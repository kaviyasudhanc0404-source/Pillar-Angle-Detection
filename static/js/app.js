/*
 * Pillar Angle Detection - browser client
 *
 * Flow: camera (getUserMedia) -> capture frame -> POST /api/detect
 *       -> draw overlay + update panel -> next frame.
 *
 * Zero reference and smoothing follow notebooks/Model_Testing.ipynb:
 *   angle        = raw_angle - zero_offset
 *   angle_smooth = 0.8 * angle_smooth + 0.2 * angle
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- Config
  const CONFIG = {
    maxSendSize: 640,     // longest side of the frame sent to the server (px)
    jpegQuality: 0.8,
    smoothing: 0.2,       // weight of the newest reading (notebook: 0.2)
    retryDelayMs: 1000,
    toastMs: 4000,
    gauge: { cx: 12, cy: 80, r: 100, range: 45, step: 5, major: 15 },
    colors: {
      best: "#22c55e",
      other: "rgba(203, 213, 225, 0.85)",
      axis: "rgba(34, 211, 238, 0.9)",
      target: "#facc15",
      pillText: "#06130b",
    },
  };

  // ---------------------------------------------------------------- Elements
  const $ = (sel) => document.querySelector(sel);
  const el = {
    stage: $("#stage"),
    video: $("#video"),
    overlay: $("#overlay"),
    toggleBtn: $("#toggleBtn"),
    zeroBtn: $("#zeroBtn"),
    flipBtn: $("#flipBtn"),
    clearZeroBtn: $("#clearZeroBtn"),
    fovInput: $("#fovInput"),
    fovValue: $("#fovValue"),
    zeroValue: $("#zeroValue"),
    angleValue: $("#angleValue"),
    angleHint: $("#angleHint"),
    statusBadge: $("#statusBadge"),
    serverChip: $("#serverChip"),
    confMeter: $("#confMeter"),
    gauge: $("#gauge"),
    toast: $("#toast"),
  };
  // Every element with data-stat="name" is reachable as stats.name
  const stats = Object.fromEntries(
    [...document.querySelectorAll("[data-stat]")].map((node) => [node.dataset.stat, node])
  );
  const ctx = el.overlay.getContext("2d");
  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d");

  // ---------------------------------------------------------------- State
  const state = {
    stream: null,
    session: 0,           // increments on every start/stop; stale loops exit
    abort: null,
    facing: "environment",
    zeroOffset: 0,
    smooth: null,
    lastRaw: null,
    lastFrameAt: 0,
    fps: null,
    px: 1,                // canvas pixels per CSS pixel
    detectError: false,
  };

  // ---------------------------------------------------------------- Helpers
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fmtAngle = (v) => {
    const abs = Math.abs(v).toFixed(2);
    return `${abs === "0.00" ? "" : v < 0 ? "−" : "+"}${abs}°`;
  };
  const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // Updates a chip/badge: colour via data-tone, text via its [data-label] child
  function setChip(node, tone, text) {
    node.dataset.tone = tone;
    setText(node.querySelector("[data-label]") || node, text);
  }

  // ---------------------------------------------------------------- Toast
  let toastTimer = null;

  function notify(message, tone = "error") {
    clearTimeout(toastTimer);
    el.toast.dataset.tone = tone;
    setText(el.toast.querySelector("[data-label]"), message);
    el.toast.hidden = false;
    if (tone !== "error") toastTimer = setTimeout(dismissToast, CONFIG.toastMs);
  }

  function dismissToast() {
    clearTimeout(toastTimer);
    el.toast.hidden = true;
  }

  // ---------------------------------------------------------------- UI mode
  // "idle" | "starting" | "running" - CSS reacts to body[data-mode]
  function setMode(mode) {
    document.body.dataset.mode = mode;
    const running = mode === "running";
    el.toggleBtn.disabled = mode === "starting";
    el.toggleBtn.querySelector("use").setAttribute("href", running ? "#i-stop" : "#i-video");
    setText(
      el.toggleBtn.querySelector("[data-label]"),
      { idle: "Start camera", starting: "Starting…", running: "Stop camera" }[mode]
    );
    el.zeroBtn.disabled = !running;
    if (!running) setChip(el.statusBadge, "muted", mode === "starting" ? "Starting…" : "Idle");
  }

  // ---------------------------------------------------------------- Gauge
  // Fan-shaped dial: 0° points right, positive angles rotate the needle down
  // (same sign as the angle: pillar below the centre line = positive).
  const gaugeNeedle = (() => {
    const { cx, cy, r, range, step, major } = CONFIG.gauge;
    const NS = "http://www.w3.org/2000/svg";
    const point = (deg, radius) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
    };
    const add = (parent, tag, attrs, text) => {
      const node = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
      if (text !== undefined) node.textContent = text;
      parent.appendChild(node);
      return node;
    };

    const [sx, sy] = point(-range, r);
    const [ex, ey] = point(range, r);
    add(el.gauge, "path", { class: "gauge-sector", d: `M${cx},${cy} L${sx},${sy} A${r},${r} 0 0 1 ${ex},${ey} Z` });

    for (let deg = -range; deg <= range; deg += step) {
      const isMajor = deg % major === 0;
      const kind = deg === 0 ? "gauge-tick--zero" : isMajor ? "gauge-tick--major" : "";
      const [x1, y1] = point(deg, r - (isMajor ? 12 : 6));
      const [x2, y2] = point(deg, r);
      add(el.gauge, "line", { class: `gauge-tick ${kind}`, x1, y1, x2, y2 });
      if (isMajor) {
        const [lx, ly] = point(deg, r + 12);
        add(el.gauge, "text", { class: "gauge-label", x: lx, y: ly }, deg > 0 ? `+${deg}` : `${deg}`.replace("-", "−"));
      }
    }

    const needle = add(el.gauge, "g", { class: "gauge-needle" });
    add(needle, "line", { x1: cx, y1: cy, x2: cx + r - 16, y2: cy });
    add(needle, "circle", { cx, cy, r: 5 });
    needle.style.transformOrigin = `${cx}px ${cy}px`;
    return needle;
  })();

  // ---------------------------------------------------------------- Readouts
  function renderAngle(value) {
    const empty = value === null;
    el.angleValue.toggleAttribute("data-empty", empty);
    setText(el.angleValue, empty ? "—" : fmtAngle(value).slice(0, -1));

    const { range } = CONFIG.gauge;
    const clamped = empty ? 0 : Math.max(-range, Math.min(range, value));
    gaugeNeedle.style.transform = `rotate(${clamped}deg)`;
    el.gauge.classList.toggle("is-idle", empty);
    el.gauge.classList.toggle("is-clamped", !empty && clamped !== value);

    setText(
      el.angleHint,
      state.zeroOffset !== 0 ? "Relative to your zero reference" : "+ pillar below centre line · − above"
    );
  }

  function clearDetection() {
    ["confidence", "raw", "bbox"].forEach((key) => setText(stats[key], "—"));
    el.confMeter.style.setProperty("--value", 0);
  }

  function resetReadouts() {
    clearDetection();
    ["inference", "count"].forEach((key) => setText(stats[key], "—"));
    setText(stats.fps, "— fps");
    renderAngle(null);
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  }

  function showResult(data) {
    const scale = { x: el.overlay.width / data.image.width, y: el.overlay.height / data.image.height };
    setText(stats.inference, `${Math.round(data.inference_ms)} ms`);
    setText(stats.count, String(data.detections.length));

    if (!data.detected) {
      drawOverlay(data, scale, null);
      clearDetection();
      el.angleValue.toggleAttribute("data-empty", true);
      setChip(el.statusBadge, "warn", "No pillar");
      return;
    }

    const det = data.detection;
    const angle = det.raw_angle_deg - state.zeroOffset;
    state.lastRaw = det.raw_angle_deg;
    state.smooth = state.smooth === null ? angle : (1 - CONFIG.smoothing) * state.smooth + CONFIG.smoothing * angle;

    drawOverlay(data, scale, state.smooth);
    renderAngle(state.smooth);
    setChip(el.statusBadge, "ok", "Detected");
    setText(stats.raw, fmtAngle(det.raw_angle_deg));
    setText(stats.confidence, fmtPct(det.confidence));
    el.confMeter.style.setProperty("--value", det.confidence);
    const b = det.bbox;
    setText(
      stats.bbox,
      `(${Math.round(b.x1 * scale.x)}, ${Math.round(b.y1 * scale.y)}) → (${Math.round(b.x2 * scale.x)}, ${Math.round(b.y2 * scale.y)})`
    );
  }

  function tickFps() {
    const now = performance.now();
    if (state.lastFrameAt) {
      const fps = 1000 / (now - state.lastFrameAt);
      state.fps = state.fps === null ? fps : 0.85 * state.fps + 0.15 * fps;
      setText(stats.fps, `${state.fps.toFixed(1)} fps`);
    }
    state.lastFrameAt = now;
  }

  // ---------------------------------------------------------------- Overlay
  function drawPill(text, x, y, bg, align = "left") {
    const px = state.px;
    ctx.font = `600 ${13 * px}px Inter, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 16 * px;
    const h = 24 * px;
    const left = Math.max(0, Math.min(el.overlay.width - w, align === "left" ? x : x - w));
    const top = Math.max(0, Math.min(el.overlay.height - h, y));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(left, top, w, h, 6 * px) : ctx.rect(left, top, w, h);
    ctx.fill();
    ctx.fillStyle = CONFIG.colors.pillText;
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + 8 * px, top + h / 2 + px);
  }

  function drawBox(det, scale, color, label) {
    const px = state.px;
    const x = det.bbox.x1 * scale.x;
    const y = det.bbox.y1 * scale.y;
    const w = (det.bbox.x2 - det.bbox.x1) * scale.x;
    const h = (det.bbox.y2 - det.bbox.y1) * scale.y;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;

    // Corner brackets
    const c = Math.min(w, h) * 0.2;
    ctx.lineWidth = 4 * px;
    ctx.lineCap = "round";
    ctx.beginPath();
    [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
      ctx.moveTo(cx + dx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * c);
    });
    ctx.stroke();

    if (label) drawPill(label, x, y - 30 * px, color);
  }

  function drawOverlay(data, scale, angle) {
    const { width: W, height: H } = el.overlay;
    const px = state.px;
    ctx.clearRect(0, 0, W, H);

    // Optical axis (image centre line)
    const axisY = data.image.center_y * scale.y;
    ctx.strokeStyle = CONFIG.colors.axis;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([8 * px, 6 * px]);
    ctx.beginPath();
    ctx.moveTo(0, axisY);
    ctx.lineTo(W, axisY);
    ctx.stroke();
    ctx.setLineDash([]);

    data.detections.forEach((det, i) => {
      if (i !== data.best_index) drawBox(det, scale, CONFIG.colors.other);
    });
    if (!data.detected) return;

    const best = data.detection;
    drawBox(best, scale, CONFIG.colors.best, `${best.class_name} ${Math.round(best.confidence * 100)}%`);

    // Target point, its offset from the axis, and the angle
    const tx = best.center.x * scale.x;
    const ty = best.center.y * scale.y;
    ctx.strokeStyle = CONFIG.colors.target;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.moveTo(tx, axisY);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = CONFIG.colors.target;
    ctx.beginPath();
    ctx.arc(tx, ty, 6 * px, 0, Math.PI * 2);
    ctx.fill();
    drawPill(fmtAngle(angle), tx + 12 * px, ty - 12 * px, CONFIG.colors.target);
  }

  // ---------------------------------------------------------------- Camera
  function cameraErrorMessage(err) {
    const messages = {
      NotAllowedError: "Camera permission was denied. Allow camera access in the browser's site settings and try again.",
      NotFoundError: "No camera was found on this device.",
      NotReadableError: "The camera is in use by another app or browser tab. Close it and try again.",
      OverconstrainedError: "This camera does not support the requested settings. Try switching camera.",
      SecurityError: "Camera access is blocked. Open the app over HTTPS or at http://localhost.",
      AbortError: "Starting the camera was interrupted. Please try again.",
    };
    return messages[err?.name] || `Unable to access the camera: ${err?.message || err}`;
  }

  function cameraSupportError() {
    if (!window.isSecureContext) return "Camera access needs a secure connection. Open the app over HTTPS or at http://localhost.";
    if (!navigator.mediaDevices?.getUserMedia) return "This browser does not support camera access. Use an up-to-date Chrome, Edge, Firefox or Safari.";
    return null;
  }

  function waitForVideo() {
    if (el.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The camera did not send any video.")), 5000);
      el.video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  function updatePixelRatio() {
    state.px = el.overlay.width / (el.stage.clientWidth || el.overlay.width) || 1;
  }

  async function updateFlipButton() {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    el.flipBtn.hidden = devices.filter((d) => d.kind === "videoinput").length < 2;
  }

  async function startCamera() {
    const unsupported = cameraSupportError();
    if (unsupported) return notify(unsupported);

    dismissToast();
    setMode("starting");
    const session = ++state.session;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (session !== state.session) return stream.getTracks().forEach((track) => track.stop());
      state.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      await waitForVideo();
      if (session !== state.session) return;

      const { videoWidth: w, videoHeight: h } = el.video;
      el.overlay.width = w;
      el.overlay.height = h;
      el.stage.style.setProperty("--ar", w / h);
      updatePixelRatio();

      state.stream.getVideoTracks()[0].addEventListener("ended", () => {
        stopCamera();
        notify("The camera stopped unexpectedly. It may have been disconnected.");
      });

      Object.assign(state, { smooth: null, lastRaw: null, lastFrameAt: 0, fps: null, detectError: false });
      setMode("running");
      setChip(el.statusBadge, "info", "Detecting…");
      updateFlipButton();
      detectLoop(session);
    } catch (err) {
      console.error(err);
      stopCamera();
      notify(cameraErrorMessage(err));
    }
  }

  function stopCamera() {
    state.session++;
    state.abort?.abort();
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    el.video.srcObject = null;
    el.stage.style.removeProperty("--ar");
    setMode("idle");
    resetReadouts();
  }

  async function flipCamera() {
    state.facing = state.facing === "user" ? "environment" : "user";
    if (state.stream) {
      stopCamera();
      await startCamera();
    }
  }

  // ---------------------------------------------------------------- Detection
  function captureFrame() {
    const { videoWidth: vw, videoHeight: vh } = el.video;
    const scale = Math.min(1, CONFIG.maxSendSize / Math.max(vw, vh));
    captureCanvas.width = Math.round(vw * scale);
    captureCanvas.height = Math.round(vh * scale);
    captureCtx.drawImage(el.video, 0, 0, captureCanvas.width, captureCanvas.height);
    return new Promise((resolve, reject) =>
      captureCanvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the camera frame."))),
        "image/jpeg",
        CONFIG.jpegQuality
      )
    );
  }

  async function requestDetection(blob) {
    const form = new FormData();
    form.append("frame", blob, "frame.jpg");
    form.append("fov", el.fovInput.value);
    state.abort = new AbortController();

    let res;
    try {
      res = await fetch("/api/detect", { method: "POST", body: form, signal: state.abort.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error("Cannot reach the server. Check that the Flask app is running.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `Server error (HTTP ${res.status}).`);
    return data;
  }

  async function detectLoop(session) {
    while (session === state.session) {
      // Pause while the tab is in the background to save CPU and data
      if (document.hidden) {
        await new Promise((resolve) => document.addEventListener("visibilitychange", resolve, { once: true }));
        continue;
      }
      try {
        const data = await requestDetection(await captureFrame());
        if (session !== state.session) break;
        if (state.detectError) {
          state.detectError = false;
          dismissToast();
        }
        showResult(data);
        tickFps();
      } catch (err) {
        if (session !== state.session || err.name === "AbortError") break;
        console.error(err);
        state.detectError = true;
        notify(`Detection error: ${err.message}`);
        setChip(el.statusBadge, "warn", "Retrying…");
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }

  // ---------------------------------------------------------------- Zero / FOV
  function setZero(offset) {
    state.zeroOffset = offset;
    state.smooth = offset === 0 ? null : 0;
    setText(el.zeroValue, fmtAngle(offset));
    renderAngle(state.stream ? state.smooth : null);
  }

  function setZeroFromCurrent() {
    if (!state.stream) return;
    if (state.lastRaw === null) return notify("No pillar detected yet. Aim at the pillar before setting zero.", "info");
    setZero(state.lastRaw);
  }

  function onFovChange() {
    state.smooth = null;
    if (state.zeroOffset !== 0) {
      setZero(0);
      notify("Field of view changed, so the zero reference was cleared. Set zero again.", "info");
    }
  }

  // ---------------------------------------------------------------- Server
  async function checkServer() {
    try {
      const data = await (await fetch("/api/health", { cache: "no-store" })).json();
      if (data.model_loaded) return setChip(el.serverChip, "ok", "Model ready");
      setChip(el.serverChip, "error", "Model not loaded");
      notify(`The model failed to load: ${data.model_error || "unknown error"}`);
    } catch {
      setChip(el.serverChip, "error", "Server offline");
    }
  }

  // ---------------------------------------------------------------- Events
  el.toggleBtn.addEventListener("click", () => (state.stream ? stopCamera() : startCamera()));
  el.zeroBtn.addEventListener("click", setZeroFromCurrent);
  el.clearZeroBtn.addEventListener("click", () => setZero(0));
  el.flipBtn.addEventListener("click", flipCamera);
  el.fovInput.addEventListener("input", () => setText(el.fovValue, `${Number(el.fovInput.value).toFixed(1)}°`));
  el.fovInput.addEventListener("change", onFovChange);
  $("#toastClose").addEventListener("click", dismissToast);

  document.addEventListener("keydown", (e) => {
    if ((e.key === "z" || e.key === "Z") && !e.target.closest("input, select, textarea")) setZeroFromCurrent();
  });
  new ResizeObserver(updatePixelRatio).observe(el.stage);
  window.addEventListener("pagehide", () => state.stream?.getTracks().forEach((track) => track.stop()));

  // ---------------------------------------------------------------- Init
  setMode("idle");
  resetReadouts();
  el.fovInput.dispatchEvent(new Event("input"));
  checkServer();
})();
