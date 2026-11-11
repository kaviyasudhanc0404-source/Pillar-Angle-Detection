"""
Pillar Angle Detection - Flask backend.

The browser captures camera frames with navigator.mediaDevices.getUserMedia()
and POSTs them to /api/detect. This server runs the trained YOLOv8 model on
each frame and returns the detected pillar, its confidence, bounding box and
the vertical angle relative to the camera's optical axis.

The angle calculation is taken unchanged from notebooks/Model_Testing.ipynb.
Zero-reference and smoothing (the "Z" key in the notebook) are per-user state,
so they are applied in the browser (static/js/app.js).
"""

import logging
import math
import os
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

# ---------------------------------------------------------------------------
# Configuration (override with environment variables)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get("MODEL_PATH", BASE_DIR / "MODELS" / "best_pillar.pt"))

# Replace with your calibrated camera vertical FOV (same default as the notebook)
VERTICAL_FOV_DEG = float(os.environ.get("VERTICAL_FOV_DEG", "50.0"))
CONFIDENCE = float(os.environ.get("CONFIDENCE", "0.25"))
IMG_SIZE = int(os.environ.get("IMG_SIZE", "640"))
MAX_UPLOAD_MB = float(os.environ.get("MAX_UPLOAD_MB", "5"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("pillar")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(MAX_UPLOAD_MB * 1024 * 1024)


# ---------------------------------------------------------------------------
# Model - loaded once at startup
# ---------------------------------------------------------------------------
model = None
model_error = None
# Ultralytics predictors are not thread-safe; serialize inference.
model_lock = threading.Lock()


def load_model():
    global model, model_error
    try:
        from ultralytics import YOLO

        if not MODEL_PATH.is_file():
            raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")

        model = YOLO(str(MODEL_PATH))
        # Warm-up so the first real request is not slow
        model.predict(
            source=np.zeros((IMG_SIZE, IMG_SIZE, 3), dtype=np.uint8),
            imgsz=IMG_SIZE,
            conf=CONFIDENCE,
            verbose=False,
        )
        log.info("Model loaded: %s  classes=%s", MODEL_PATH, model.names)
    except Exception as exc:  # keep the server up so the UI can show the error
        model = None
        model_error = f"{type(exc).__name__}: {exc}"
        log.exception("Failed to load model")


load_model()


# ---------------------------------------------------------------------------
# Angle calculation (from notebooks/Model_Testing.ipynb)
# ---------------------------------------------------------------------------
def focal_length_y(h, vertical_fov_deg):
    """Vertical focal length in pixels from image height and vertical FOV."""
    return (h / 2) / math.tan(math.radians(vertical_fov_deg / 2))


def vertical_angle(target_y, h, vertical_fov_deg):
    """
    Vertical bearing (degrees) of an image row relative to the camera axis.

    Sign convention (unchanged from the notebook): image y grows downward,
    so a target below the image centre gives a positive angle and a target
    above the centre gives a negative angle. 0 deg = on the optical axis.
    """
    cy = h / 2
    fy = focal_length_y(h, vertical_fov_deg)
    return math.degrees(math.atan((target_y - cy) / fy))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class BadRequest(Exception):
    pass


def read_frame():
    """Decode the uploaded frame (multipart file 'frame') into a BGR image."""
    file = request.files.get("frame")
    if file is None:
        raise BadRequest("No frame received. Send the image as multipart field 'frame'.")

    data = file.read()
    if not data:
        raise BadRequest("Received an empty frame.")

    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise BadRequest("Could not decode the frame. Send a JPEG or PNG image.")
    return frame


def read_fov():
    """Optional per-request FOV override for calibration (form field 'fov')."""
    raw = request.form.get("fov")
    if raw in (None, ""):
        return VERTICAL_FOV_DEG
    try:
        fov = float(raw)
    except ValueError:
        raise BadRequest("'fov' must be a number (degrees).")
    if not 1.0 <= fov <= 179.0:
        raise BadRequest("'fov' must be between 1 and 179 degrees.")
    return fov


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template(
        "index.html",
        default_fov=VERTICAL_FOV_DEG,
        confidence=CONFIDENCE,
    )


@app.route("/api/health")
def health():
    return jsonify(
        status="ok" if model is not None else "error",
        model_loaded=model is not None,
        model_error=model_error,
        model_path=MODEL_PATH.name,
        classes=list(model.names.values()) if model is not None else [],
        vertical_fov_deg=VERTICAL_FOV_DEG,
        confidence_threshold=CONFIDENCE,
        img_size=IMG_SIZE,
    ), (200 if model is not None else 503)


@app.route("/api/detect", methods=["POST"])
def detect():
    if model is None:
        return jsonify(success=False, error=f"Model is not loaded. {model_error or ''}".strip()), 503

    try:
        frame = read_frame()
        fov = read_fov()
    except BadRequest as exc:
        return jsonify(success=False, error=str(exc)), 400

    h, w = frame.shape[:2]
    cy = h / 2
    fy = focal_length_y(h, fov)

    try:
        t0 = time.perf_counter()
        with model_lock:
            result = model.predict(
                source=frame,
                imgsz=IMG_SIZE,
                conf=CONFIDENCE,
                verbose=False,
            )[0]
        inference_ms = (time.perf_counter() - t0) * 1000
    except Exception as exc:
        log.exception("Inference failed")
        return jsonify(success=False, error=f"Inference failed: {exc}"), 500

    detections = []
    best = None
    best_idx = None

    if result.boxes is not None and len(result.boxes) > 0:
        # Select the highest-confidence detection (as in the notebook)
        best_idx = int(result.boxes.conf.argmax())

        for i, box in enumerate(result.boxes):
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())

            # Center of the detected pillar
            target_x = (x1 + x2) / 2
            target_y = (y1 + y2) / 2

            # Vertical bearing relative to camera axis
            raw_angle = vertical_angle(target_y, h, fov)

            det = {
                "class_id": int(box.cls[0]),
                "class_name": model.names[int(box.cls[0])],
                "confidence": round(float(box.conf[0]), 4),
                "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "center": {"x": target_x, "y": target_y},
                "raw_angle_deg": round(raw_angle, 4),
            }
            detections.append(det)
            if i == best_idx:
                best = det

    return jsonify(
        success=True,
        detected=best is not None,
        detection=best,
        best_index=best_idx,
        detections=detections,
        image={"width": w, "height": h, "center_y": cy},
        camera={"vertical_fov_deg": fov, "focal_length_px": round(fy, 3)},
        inference_ms=round(inference_ms, 1),
    )


# ---------------------------------------------------------------------------
# JSON error handlers
# ---------------------------------------------------------------------------
@app.errorhandler(413)
def too_large(_):
    return jsonify(success=False, error=f"Frame is too large (limit {MAX_UPLOAD_MB:g} MB)."), 413


@app.errorhandler(HTTPException)
def http_error(exc):
    if request.path.startswith("/api/"):
        return jsonify(success=False, error=exc.description), exc.code
    return exc


@app.errorhandler(Exception)
def unhandled(exc):
    log.exception("Unhandled error")
    return jsonify(success=False, error="Internal server error."), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    # use_reloader=False so the model is not loaded twice in debug mode
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=False)
