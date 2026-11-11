# Pillar Angle Detection

Real-time pillar detection and vertical angle measurement in the browser, using a custom-trained **YOLOv8** model with a **Flask** backend and a plain **HTML / CSS / JavaScript** frontend.

Point your camera at a pillar. The app draws a box around the pillar and shows its **vertical angle** relative to the camera's optical axis, live, in degrees.

---

## Contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Angle calculation](#angle-calculation)
4. [Project structure](#project-structure)
5. [Getting started](#getting-started)
6. [Using the app](#using-the-app)
7. [Configuration](#configuration)
8. [API reference](#api-reference)
9. [Model and dataset](#model-and-dataset)
10. [Troubleshooting](#troubleshooting)
11. [Credits and licences](#credits-and-licences)

---

## Features

- **Live camera in the browser.** The camera is opened with `getUserMedia`, so it works on laptops and phones, with no camera access on the server.
- **YOLOv8 pillar detection.** It uses a custom model trained on pillar images (`MODELS/best_pillar.pt`).
- **Bounding-box overlay.** The box, confidence label, pillar centre point and image centre line are drawn over the video.
- **Vertical angle in degrees.** The readout is smoothed so it stays steady.
- **Zero reference.** Set the current angle as 0° and measure relative to it.
- **Adjustable camera FOV.** Calibrate the field of view from the page, with no restart.
- **Clear error messages** for a blocked or missing camera, a server problem, or a model that failed to load.
- **Responsive layout** for desktop and mobile.

---

## How it works

```text
 Browser                                    Flask server (app.py)
 ───────                                    ─────────────────────
 Camera (getUserMedia)
        │
        ▼
 Capture frame → resize (≤ 640 px) → JPEG
        │
        │  POST /api/detect  (frame + FOV)
        └──────────────────────────────────▶  Decode image
                                              YOLOv8 inference (model loaded once)
                                              Pick highest-confidence pillar
                                              Compute vertical angle
        ┌──────────────────────────────────  JSON: box, confidence, angle
        ▼
 Draw overlay on the video
 Apply zero reference and smoothing
 Show angle, confidence and box
        │
        └──▶ send the next frame
```

The browser sends a new frame only after the previous result comes back, so a slow network or server never builds up a queue of frames.

---

## Angle calculation

The angle is the vertical position of the pillar's centre, measured from the camera's forward (optical) axis using a pinhole camera model:

```python
cy = h / 2                                                 # image centre row
fy = (h / 2) / math.tan(math.radians(VERTICAL_FOV_DEG / 2))  # focal length in pixels
target_y = (y1 + y2) / 2                                   # centre of the pillar's box
angle = math.degrees(math.atan((target_y - cy) / fy))
```

| Situation | Angle |
|---|---|
| Pillar centre on the image centre line | **0°** |
| Pillar centre **below** the centre line | **positive (+)** |
| Pillar centre **above** the centre line | **negative (−)** |

- **Zero reference:** pressing **Set Zero** (or the **Z** key) stores the current angle as an offset. From then on the app shows `angle − offset`.
- **Smoothing:** each new reading is blended with the previous ones (`0.8 × previous + 0.2 × new`) to reduce jitter.
- **Field of view (FOV):** the result depends on the camera's vertical FOV. The default is **50°**. For accurate angles, calibrate it for your camera (see [Configuration](#configuration)).

If more than one pillar is detected, the angle is taken from the one with the **highest confidence**. Any others are drawn in grey.

---

## Project structure

```text
Pillar-Angle-Detection/
├── app.py                   # Flask backend: model loading, API, angle calculation
├── templates/
│   └── index.html           # Web page
├── static/
│   ├── css/style.css        # Styling (responsive, dark theme)
│   └── js/app.js            # Camera, frame upload, overlay, zero and smoothing
├── MODELS/
│   └── best_pillar.pt       # Trained YOLOv8 model (~6 MB)
├── notebooks/
│   ├── Yolov8_pillar_detection_model.ipynb   # Model training (Google Colab)
│   └── Model_Testing.ipynb                   # Model and angle testing (local)
├── DATASETS/                # Training dataset (not included in the repository)
├── pillar_images/           # Test photos (not included in the repository)
├── requirements.txt         # Python dependencies
└── .python-version          # Python version (3.11.7)
```

The dataset and test photos are kept out of the repository to keep it small. The app only needs `MODELS/best_pillar.pt`.

---

## Getting started

### Requirements

- Python **3.11**
- A browser with camera support (Chrome, Edge, Firefox or Safari)
- A webcam or phone camera

### 1. Clone the repository

```bash
git clone https://github.com/kaviyasudhanc0404-source/Pillar-Angle-Detection.git
cd Pillar-Angle-Detection
```

### 2. Create and activate a virtual environment

**Windows (PowerShell):**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script, run this once, then try again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install the dependencies

```bash
pip install -r requirements.txt
```

This installs the CPU version of PyTorch, so no GPU is needed.

### 4. Start the app

```bash
python app.py
```

When the model has loaded, you will see:

```text
[INFO] Model loaded: .../MODELS/best_pillar.pt  classes={0: 'Pillar'}
 * Running on http://127.0.0.1:8000
```

### 5. Open it in your browser

Go to **http://localhost:8000**.

To stop the server, press `Ctrl + C` in the terminal.

---

## Using the app

1. Click **Start Camera** and allow camera access when the browser asks.
2. Point the camera at a pillar. A green box appears around it, and the angle is shown on the video and in the side panel.
3. *(Optional)* Aim at your reference point and press **Set Zero** (or **Z**) to measure relative to it. **Clear Zero** removes the offset.
4. *(Optional)* Enter your camera's vertical FOV under **Calibration**.
5. Click **Stop Camera** when you are done.

On phones, choose **Back camera** or **Front camera** before starting.

### What the panel shows

| Item | Meaning |
|---|---|
| Vertical angle | Smoothed angle, relative to the zero reference if one is set |
| Raw angle | Unsmoothed angle for the current frame, without the zero offset |
| Confidence | How sure the model is that this is a pillar |
| Bounding box | Pillar position in pixels (top-left to bottom-right) |
| Detection status | Pillar detected, not detected, or error |
| Inference / Frame rate | Detection time per frame, and frames processed per second |

---

## Configuration

Settings are read from environment variables. All of them are optional.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Port the server listens on |
| `VERTICAL_FOV_DEG` | `50.0` | Camera vertical field of view, in degrees |
| `CONFIDENCE` | `0.25` | Minimum detection confidence (0–1) |
| `IMG_SIZE` | `640` | YOLO inference image size |
| `MODEL_PATH` | `MODELS/best_pillar.pt` | Path to the model file |
| `MAX_UPLOAD_MB` | `5` | Maximum size of one uploaded frame |

Example (PowerShell):

```powershell
$env:VERTICAL_FOV_DEG = "48.5"
python app.py
```

### Calibrating the vertical FOV

1. Hold the camera level, pointing straight ahead.
2. Put a mark at a known height *H* above the camera, at a known horizontal distance *D*.
3. The true angle is `atan(H / D)`. A mark above the camera reads as a **negative** angle.
4. Adjust the FOV in the page until the measured angle matches.
5. Save that value as `VERTICAL_FOV_DEG`.

Use the camera at the same resolution and orientation as when you measure.

---

## API reference

### `GET /api/health`

Shows whether the model is loaded, plus the current settings.

```json
{
  "status": "ok",
  "model_loaded": true,
  "classes": ["Pillar"],
  "vertical_fov_deg": 50.0,
  "confidence_threshold": 0.25,
  "img_size": 640
}
```

### `POST /api/detect`

Runs pillar detection on a single image.

**Request:** `multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `frame` | yes | JPEG or PNG image |
| `fov` | no | Vertical FOV in degrees (1–179), overrides the default |

**Response:**

```json
{
  "success": true,
  "detected": true,
  "detection": {
    "class_name": "Pillar",
    "confidence": 0.784,
    "bbox": { "x1": 159, "y1": 10, "x2": 302, "y2": 546 },
    "center": { "x": 230.5, "y": 278.0 },
    "raw_angle_deg": -3.5012
  },
  "best_index": 0,
  "detections": [ "...all detected pillars..." ],
  "image": { "width": 480, "height": 640, "center_y": 320.0 },
  "camera": { "vertical_fov_deg": 50.0, "focal_length_px": 686.243 },
  "inference_ms": 190.3
}
```

When no pillar is found, `detected` is `false` and `detection` is `null`.

**Errors** are returned as `{ "success": false, "error": "<message>" }`:

| Status | Cause |
|---|---|
| `400` | Missing, empty or unreadable image, or an invalid `fov` |
| `413` | Image larger than `MAX_UPLOAD_MB` |
| `500` | Detection failed |
| `503` | Model not loaded |

**Example with curl:**

```bash
curl -F "frame=@pillar.jpg" -F "fov=50" http://localhost:8000/api/detect
```

---

## Model and dataset

| Item | Details |
|---|---|
| Base model | YOLOv8n (Ultralytics), fine-tuned |
| Classes | 1: `Pillar` |
| Dataset | 61 images (54 train / 4 validation / 3 test), labelled in Roboflow |
| Pre-processing | Auto-orientation; resized to fit 640 × 640 |
| Augmentation | Rotation ±5°, brightness ±15 %, exposure ±10 % |
| Training | Up to 50 epochs (early stopping after 47), image size 640, batch 8, Tesla T4 GPU |
| Test results | mAP50 = **0.995**, mAP50-95 = **0.530** |

The test set has only 3 images, so these numbers are only a rough guide. Accuracy in real use depends on lighting, distance and how much the scene looks like the training photos.

### Notebooks

- **`Yolov8_pillar_detection_model.ipynb`** trains the model on Google Colab with the dataset stored in Google Drive.
- **`Model_Testing.ipynb`** tests the model locally on single images, image folders and a webcam (OpenCV window). It also contains the original version of the angle calculation used in the app.

The notebooks use absolute file paths from the original machine. Update the paths at the top of each notebook before running them.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Page shows `{"message":"Route not found"}` or another app's page | Another program is using the port. Start on a different one: `$env:PORT = "8080"; python app.py` |
| "Camera access requires a secure connection" | Open the app at `http://localhost:8000`, not at your computer's IP address. Browsers only allow the camera on `localhost` or HTTPS. |
| "Camera permission was denied" | Allow the camera in the browser's site settings (the icon next to the address bar), then click **Start Camera** again. |
| "Camera is already in use" | Close other apps or browser tabs that use the camera. |
| Header shows "Model not loaded" | Check that `MODELS/best_pillar.pt` exists. The terminal shows the exact error. |
| Angle looks too large or too small | Calibrate the vertical FOV (see [Configuration](#configuration)). |

---

## Credits and licences

- **Dataset:** *Pillar Detection v1*, created with [Roboflow](https://universe.roboflow.com/sudhan-bfurf/pillar-detection-zvwqs), licensed **CC BY 4.0**.
- **Object detection:** [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics), licensed **AGPL-3.0**.
- **Web framework:** [Flask](https://flask.palletsprojects.com/).
