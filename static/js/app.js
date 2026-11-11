/*
 * Pillar Angle Detection - browser client.
 *
 * Captures camera frames with getUserMedia, sends them to the Flask backend
 * (/api/detect) and draws the returned detection on an overlay canvas.
 *
 * Zero reference and smoothing follow notebooks/Model_Testing.ipynb:
 *   angle        = raw_angle - zero_offset
 *   angle_smooth = 0.8 * angle_smooth + 0.2 * angle
 *   "Z"          -> zero_offset = raw_angle, angle_smooth = 0
 */
(() => {
  "use strict";

  // ---------------- Settings ----------------
  const MAX_SEND_SIZE = 640;    // longest side of the frame sent to the server
  const JPEG_QUALITY = 0.8;
  const SMOOTH_PREV = 0.8;      // same weights as the notebook
  const SMOOTH_NEW = 0.2;
  const ERROR_RETRY_MS = 1000;

  // ---------------- Elements ----------------
  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const overlay = $("overlay");
  const ctx = overlay.getContext("2d");
  const stage = $("stage");
  const placeholder = $("placeholder");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const cameraSelect = $("cameraSelect");
  const zeroBtn = $("zeroBtn");
  const resetZeroBtn = $("resetZeroBtn");
  const fovInput = $("fovInput");
  const messageBox = $("message");
  const serverStatus = $("serverStatus");

  const ui = {
    angle: $("angleValue"),
    angleHint: $("angleHint"),
    conf: $("confValue"),
    confBar: $("confBar"),
    rawAngle: $("rawAngleValue"),
    bbox: $("bboxValue"),
    status: $("detStatus"),
    infer: $("inferValue"),
    fps: $("fpsValue"),
    zero: $("zeroValue"),
  };

  // Offscreen canvas used to encode frames
  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d");

  // ---------------- State ----------------
  let stream = null;
  let running = false;
  let abortCtrl = null;
  let zeroOffset = 0.0;
  let angleSmooth = null;
  let lastRawAngle = null;
  let lastFrameTime = 0;
  let fpsAvg = null;

  // ---------------- Messages ----------------
  function showMessage(text, type = "error") {
    messageBox.textContent = text;
    messageBox.className = "message" + (type === "info" ? " info" : "");
    messageBox.hidden = false;
  }

  function clearMessage() {
    messageBox.hidden = true;
    messageBox.textContent = "";
  }

  function cameraErrorMessage(err) {
    switch (err && err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Camera permission was denied. Allow camera access in your browser's site settings and try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No camera was found on this device.";
      case "NotReadableError":
      case "TrackStartError":
        return "The camera is already in use by another application (close other apps or browser tabs using it) or could not be started.";
      case "OverconstrainedError":
        return "The selected camera does not support the requested settings. Try the other camera option.";
      case "SecurityError":
        return "Camera access is blocked for security reasons. Open the app over HTTPS or via http://localhost.";
      case "AbortError":
        return "Camera start was aborted. Please try again.";
      default:
        return "Unable to access the camera: " + ((err && err.message) || err);
    }
  }

  // ---------------- Server health ----------------
  async function checkServer() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = await res.json();
      if (data.model_loaded) {
        serverStatus.textContent = "Model ready";
        serverStatus.className = "pill pill-ok";
      } else {
        serverStatus.textContent = "Model not loaded";
        serverStatus.className = "pill pill-error";
        showMessage("Server is running but the model failed to load: " + (data.model_error || "unknown error"));
      }
    } catch (e) {
      serverStatus.textContent = "Server offline";
      serverStatus.className = "pill pill-error";
    }
  }

  // ---------------- Camera ----------------
  async function startCamera() {
    clearMessage();

    if (!window.isSecureContext) {
      showMessage("Camera access requires a secure connection. Open this page over HTTPS or via http://localhost.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMessage("This browser does not support camera access (getUserMedia). Please use an up-to-date Chrome, Edge, Firefox or Safari.");
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = "Starting…";

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: cameraSelect.value },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      video.srcObject = stream;
      await video.play();
      await waitForVideoSize();

      // Make the stage match the camera aspect so the overlay maps 1:1
      stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;

      stream.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => {
          showMessage("The camera stopped unexpectedly (it may have been disconnected).");
          stopCamera(false);
        })
      );

      placeholder.hidden = true;
      stopBtn.disabled = false;
      zeroBtn.disabled = false;
      cameraSelect.disabled = true;
      startBtn.textContent = "Start Camera";

      angleSmooth = null;
      lastRawAngle = null;
      fpsAvg = null;
      lastFrameTime = 0;
      running = true;
      setStatus("Detecting…");
      detectLoop();
    } catch (err) {
      console.error(err);
      showMessage(cameraErrorMessage(err));
      stopCamera(false);
    }
  }

  function waitForVideoSize() {
    return new Promise((resolve, reject) => {
      if (video.videoWidth > 0) return resolve();
      const timer = setTimeout(() => reject(new Error("Camera did not deliver any frames.")), 5000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  function stopCamera(clearMsg = true) {
    running = false;
    if (abortCtrl) abortCtrl.abort();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    placeholder.hidden = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
    stopBtn.disabled = true;
    zeroBtn.disabled = true;
    cameraSelect.disabled = false;
    if (clearMsg) clearMessage();

    resetReadouts();
    setStatus("Idle");
  }

  // ---------------- Detection loop ----------------
  function captureFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, MAX_SEND_SIZE / Math.max(vw, vh));
    captureCanvas.width = Math.round(vw * scale);
    captureCanvas.height = Math.round(vh * scale);
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

    return new Promise((resolve, reject) => {
      captureCanvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the camera frame."))),
        "image/jpeg",
        JPEG_QUALITY
      );
    });
  }

  async function detectLoop() {
    while (running) {
      try {
        const blob = await captureFrame();
        const form = new FormData();
        form.append("frame", blob, "frame.jpg");
        const fov = parseFloat(fovInput.value);
        if (Number.isFinite(fov)) form.append("fov", String(fov));

        abortCtrl = new AbortController();
        const res = await fetch("/api/detect", { method: "POST", body: form, signal: abortCtrl.signal });

        let data;
        try {
          data = await res.json();
        } catch (_) {
          throw new Error(`Server returned an invalid response (HTTP ${res.status}).`);
        }
        if (!res.ok || !data.success) {
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
        if (!running) break;

        if (!messageBox.hidden && messageBox.dataset.source === "detect") {
          clearMessage();
          messageBox.dataset.source = "";
        }
        handleResult(data);
        updateFps();
      } catch (err) {
        if (!running || err.name === "AbortError") break;
        console.error(err);
        const msg = err instanceof TypeError ? "Cannot reach the server. Check that the Flask app is running." : err.message;
        showMessage("Detection error: " + msg);
        messageBox.dataset.source = "detect";
        setStatus("Error – retrying", "warn");
        await sleep(ERROR_RETRY_MS);
      }
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function updateFps() {
    const now = performance.now();
    if (lastFrameTime) {
      const fps = 1000 / (now - lastFrameTime);
      fpsAvg = fpsAvg === null ? fps : 0.9 * fpsAvg + 0.1 * fps;
      ui.fps.textContent = fpsAvg.toFixed(1) + " fps";
    }
    lastFrameTime = now;
  }

  // ---------------- Results ----------------
  function handleResult(data) {
    ui.infer.textContent = data.inference_ms.toFixed(0) + " ms";

    // Map from the sent frame size back to the overlay (full video) size
    const sx = overlay.width / data.image.width;
    const sy = overlay.height / data.image.height;

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const lw = Math.max(2, Math.round(overlay.width / 320));

    if (!data.detected) {
      setStatus("Pillar not detected", "warn");
      ui.conf.textContent = "--";
      ui.confBar.style.width = "0%";
      ui.bbox.textContent = "--";
      ui.angle.classList.add("inactive");
      ui.angleHint.textContent = "Pillar not detected";
      return;
    }

    const det = data.detection;
    const raw = det.raw_angle_deg;
    lastRawAngle = raw;

    // Zero reference + smoothing (notebook logic)
    const angle = raw - zeroOffset;
    angleSmooth = angleSmooth === null ? angle : SMOOTH_PREV * angleSmooth + SMOOTH_NEW * angle;

    // Image centre line (optical axis)
    const cyPx = data.image.center_y * sy;
    ctx.strokeStyle = "rgba(34, 211, 238, 0.8)";
    ctx.lineWidth = Math.max(1, lw / 2);
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.beginPath();
    ctx.moveTo(0, cyPx);
    ctx.lineTo(overlay.width, cyPx);
    ctx.stroke();
    ctx.setLineDash([]);

    // Other (lower-confidence) detections
    data.detections.forEach((d, i) => {
      if (i !== data.best_index) drawBox(d, sx, sy, "rgba(148, 163, 184, 0.8)", lw);
    });

    // Selected detection
    drawBox(det, sx, sy, "#22c55e", lw, true);

    // Target point (centre of the bounding box)
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(det.center.x * sx, det.center.y * sy, lw * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Angle text on the video (bottom-left, clear of the box label)
    const fontPx = Math.max(16, Math.round(overlay.width / 32));
    const text = `Vertical angle: ${fmtSigned(angleSmooth)}°`;
    ctx.font = `600 ${fontPx}px Segoe UI, system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const top = overlay.height - fontPx * 2.1;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(fontPx * 0.6, top, tw + fontPx * 0.8, fontPx * 1.6);
    ctx.fillStyle = "#4ade80";
    ctx.fillText(text, fontPx, top + fontPx * 1.15);

    // Side panel
    setStatus(data.detections.length > 1 ? `Pillar detected (${data.detections.length})` : "Pillar detected", "ok");
    ui.angle.classList.remove("inactive");
    ui.angle.textContent = fmtSigned(angleSmooth) + "°";
    ui.angleHint.textContent = zeroOffset !== 0 ? "Relative to zero reference (smoothed)" : "Relative to camera axis (smoothed)";
    ui.rawAngle.textContent = fmtSigned(raw) + "°";
    ui.conf.textContent = (det.confidence * 100).toFixed(1) + "%";
    ui.confBar.style.width = (det.confidence * 100).toFixed(1) + "%";
    const b = det.bbox;
    ui.bbox.textContent = `(${Math.round(b.x1 * sx)}, ${Math.round(b.y1 * sy)}) – (${Math.round(b.x2 * sx)}, ${Math.round(b.y2 * sy)})`;
  }

  function drawBox(d, sx, sy, color, lw, withLabel = false) {
    const x = d.bbox.x1 * sx;
    const y = d.bbox.y1 * sy;
    const w = (d.bbox.x2 - d.bbox.x1) * sx;
    const h = (d.bbox.y2 - d.bbox.y1) * sy;

    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, w, h);

    if (withLabel) {
      const fontPx = Math.max(13, Math.round(overlay.width / 48));
      const label = `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`;
      ctx.font = `600 ${fontPx}px Segoe UI, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + fontPx * 0.6;
      const th = fontPx * 1.4;
      const ly = y - th < 0 ? y : y - th;
      ctx.fillStyle = color;
      ctx.fillRect(x, ly, tw, th);
      ctx.fillStyle = "#0b1220";
      ctx.fillText(label, x + fontPx * 0.3, ly + fontPx * 1.05);
    }
  }

  function fmtSigned(v) {
    return (v >= 0 ? "+" : "") + v.toFixed(2);
  }

  function setStatus(text, kind = "") {
    ui.status.textContent = text;
    ui.status.className = "metric-value small" + (kind ? " " + kind : "");
  }

  function resetReadouts() {
    ui.angle.textContent = "--.--°";
    ui.angle.classList.add("inactive");
    ui.angleHint.textContent = "Waiting for detection";
    ui.conf.textContent = "--";
    ui.confBar.style.width = "0%";
    ui.rawAngle.textContent = "--";
    ui.bbox.textContent = "--";
    ui.infer.textContent = "--";
    ui.fps.textContent = "--";
  }

  // ---------------- Zero reference ----------------
  function setZero() {
    if (!running) return;
    if (lastRawAngle === null) {
      showMessage("No pillar detected yet – aim at the pillar before setting zero.", "info");
      return;
    }
    zeroOffset = lastRawAngle;
    angleSmooth = 0.0;
    ui.zero.textContent = fmtSigned(zeroOffset) + "°";
  }

  function clearZero() {
    zeroOffset = 0.0;
    angleSmooth = null;
    ui.zero.textContent = "0.00°";
  }

  // ---------------- Events ----------------
  startBtn.addEventListener("click", startCamera);
  stopBtn.addEventListener("click", () => stopCamera());
  zeroBtn.addEventListener("click", setZero);
  resetZeroBtn.addEventListener("click", clearZero);

  fovInput.addEventListener("change", () => {
    const v = parseFloat(fovInput.value);
    if (!Number.isFinite(v) || v < 1 || v > 179) {
      showMessage("Vertical FOV must be between 1 and 179 degrees.");
      fovInput.value = window.APP_CONFIG.defaultFov;
      return;
    }
    // A zero offset measured with a different FOV is no longer valid
    if (zeroOffset !== 0) {
      clearZero();
      showMessage("FOV changed – zero reference cleared. Set zero again.", "info");
    } else {
      angleSmooth = null;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "z" || e.key === "Z") setZero();
  });

  // Release the camera when the page is closed
  window.addEventListener("pagehide", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });

  resetReadouts();
  checkServer();
})();
