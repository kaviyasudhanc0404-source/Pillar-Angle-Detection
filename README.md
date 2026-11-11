# Pillar Angle Detection

Real-time pillar detection and vertical-angle measurement in the browser.

- **Backend:** Python Flask + YOLOv8 (Ultralytics), trained model `MODELS/best_pillar.pt`
- **Frontend:** plain HTML, CSS and JavaScript (no framework)
- **Camera:** accessed in the browser with `navigator.mediaDevices.getUserMedia()`; frames are sent to the server for detection. The server never opens a camera itself, so it works when deployed.

## Project structure

```text
Pillar_Angle_Detection/
├── app.py                  # Flask app: loads the model once, /api/detect, /api/health
├── templates/index.html    # UI
├── static/css/style.css
├── static/js/app.js        # camera capture, API calls, overlay drawing, zero/smoothing
├── MODELS/best_pillar.pt   # trained YOLOv8 model (committed to Git)
├── DATASETS/               # Roboflow training dataset (local only, git-ignored)
├── pillar_images/          # test photos (local only, git-ignored)
├── notebooks/
│   ├── Yolov8_pillar_detection_model.ipynb   # training (Google Colab)
│   └── Model_Testing.ipynb                   # local testing + original angle logic
├── requirements.txt
├── Procfile                # Gunicorn start command
├── render.yaml             # optional Render Blueprint
├── .python-version         # Python 3.11.7
└── .gitignore
```

## How the angle is calculated

The logic is the same as the last cell of `notebooks/Model_Testing.ipynb`:

```python
cy = h / 2
fy = (h / 2) / math.tan(math.radians(VERTICAL_FOV_DEG / 2))
target_y = (y1 + y2) / 2                      # centre of the highest-confidence box
raw_angle = math.degrees(math.atan((target_y - cy) / fy))
```

- **0°**: the pillar centre is on the camera's optical axis (the image centre line).
- **Sign:** this is the notebook's convention. Image *y* grows downward, so:
  - a pillar centre **below** the centre line gives a **positive** angle;
  - a pillar centre **above** the centre line gives a **negative** angle.
- **Zero reference:** the **Set Zero** button (or the `Z` key) works like the notebook's `Z` key. It stores the current raw angle as `zero_offset`, and from then on the displayed angle is `raw_angle - zero_offset`.
- **Smoothing:** `angle_smooth = 0.8 * angle_smooth + 0.2 * angle`, the same as the notebook.

The server returns `raw_angle_deg`. The browser applies the zero offset and the smoothing, because those are per-user settings.

### Calibrating the vertical FOV

The default vertical FOV is **50°**, the same as the notebook. You can change it in two ways:

- **For a quick test:** type a new value in the **Calibration → Vertical FOV** box in the UI. It is sent with every frame.
- **As the new default:** set the `VERTICAL_FOV_DEG` environment variable.

## Run locally in VS Code (Windows)

1. Open the folder `D:\AIREI\Pillar_Angle_Detection` in VS Code.
2. Open a terminal (**Terminal → New Terminal**, PowerShell).
3. Activate the virtual environment. If it does not exist yet, create it first.

   ```powershell
   # Only the first time:
   python -m venv .venv

   .\.venv\Scripts\Activate.ps1
   ```

   If PowerShell blocks the activation script, run this once first:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

4. Install the dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

5. Start the app:

   ```powershell
   python app.py
   ```

6. Open **http://localhost:8000** in Chrome or Edge.
7. Click **Start Camera** and allow camera access.

To stop the server, press `Ctrl + C` in the terminal.

Optional settings (PowerShell, set them before `python app.py`):

```powershell
$env:VERTICAL_FOV_DEG = "48.5"   # calibrated vertical FOV
$env:CONFIDENCE = "0.25"         # detection confidence threshold
$env:PORT = "8080"               # different port (default is 8000)
```

> **Note:** browsers only allow camera access on **HTTPS** or **http://localhost**. If you open the app from another device on your LAN (for example `http://192.168.x.x:8000`), the camera is blocked. Use the deployed HTTPS URL instead.
>
> Gunicorn (used in the `Procfile`) does not run on Windows. Locally, use `python app.py`. Render uses Gunicorn on Linux.

## API

| Method | URL           | Description |
|--------|---------------|-------------|
| GET    | `/`           | Web UI |
| GET    | `/api/health` | Model status and configuration |
| POST   | `/api/detect` | Runs detection on one frame |

The `POST /api/detect` request is `multipart/form-data` with these fields:

- `frame` (required): a JPEG or PNG image.
- `fov` (optional): the vertical FOV in degrees.

Example response:

```json
{
  "success": true,
  "detected": true,
  "detection": {
    "class_name": "Pillar",
    "confidence": 0.784,
    "bbox": {"x1": 159, "y1": 10, "x2": 302, "y2": 546},
    "center": {"x": 230.5, "y": 278.0},
    "raw_angle_deg": -3.5012
  },
  "best_index": 0,
  "detections": [ ... all detections ... ],
  "image": {"width": 480, "height": 640, "center_y": 320.0},
  "camera": {"vertical_fov_deg": 50.0, "focal_length_px": 686.243},
  "inference_ms": 190.3
}
```

Errors are returned as `{"success": false, "error": "..."}` with these status codes:

- **400:** missing or invalid frame or FOV.
- **413:** the frame is too large.
- **500:** inference failed.
- **503:** the model is not loaded.

## Push to GitHub

```powershell
git init
git add .
git commit -m "Pillar angle detection Flask app"
git branch -M main
git remote add origin https://github.com/<your-username>/Pillar_Angle_Detection.git
git push -u origin main
```

`.gitignore` excludes `.venv/`, `__pycache__/`, `.env`, `DATASETS/` and `pillar_images/`. The trained model `MODELS/best_pillar.pt` (about 6 MB) **is** committed, because the deployed app needs it.

## Deploy on Render

**Option A: Blueprint**

1. On Render, choose **New → Blueprint**.
2. Select your GitHub repository. Render reads `render.yaml`.

**Option B: Web Service (manual)**

1. On Render, choose **New → Web Service** and connect the repository.
2. Set **Runtime** to **Python 3**.
3. Set the **Build Command**:

   ```bash
   pip install -r requirements.txt && pip uninstall -y opencv-python && pip install --force-reinstall --no-deps opencv-python-headless
   ```

   Ultralytics installs `opencv-python`, which needs system GUI libraries (`libGL`) that Render does not provide. This command swaps it for the headless build.

4. Set the **Start Command** to the same command as the `Procfile`:

   ```bash
   gunicorn app:app --workers 1 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT
   ```

5. Add these **Environment variables**:
   - `PYTHON_VERSION` = `3.11.7`
   - `VERTICAL_FOV_DEG` = `50.0` (optional)
   - `YOLO_CONFIG_DIR` = `/tmp/Ultralytics`
6. Set **Health Check Path** to `/api/health`.

Render serves the app over HTTPS, so camera access works on phones and laptops.

**Tips:**

- `requirements.txt` installs the **CPU-only** PyTorch wheels, which keeps the build far smaller than the CUDA build.
- The app uses one Gunicorn worker, so the model is loaded only once.
- On the free plan (512 MB RAM, shared CPU), inference is slower than on a PC. Expect roughly 1–3 frames per second, and a cold start of up to about a minute after the service has been idle.
- The browser sends the next frame only after the previous result arrives, so a slow server never builds up a queue.

## Notebooks

- **`Yolov8_pillar_detection_model.ipynb`:** training on Google Colab (uses Drive paths). The model was **not** retrained for this app.
- **`Model_Testing.ipynb`:** local testing with OpenCV windows and `cv2.VideoCapture(0)`. Use it on your own PC only; the web app replaces it for deployment.
