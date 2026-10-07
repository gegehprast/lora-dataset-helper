"""Long-lived local analysis worker, spawned by the Bun server.

Protocol: newline-delimited JSON over stdin/stdout.
  request : {"id": 1, "op": "analyze", "args": {"paths": [...]}}
  response: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
On startup the worker prints {"ready": true}. Logs go to stderr only.
"""

import base64
import json
import os
import sys
import traceback
import urllib.request

# Reserve the real stdout for protocol messages and point fd 1 at stderr, so
# anything printed by Python or native libraries (onnxruntime, torch) can't
# corrupt the protocol stream.
_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

MODELS_DIR = os.environ.get("MODELS_DIR", os.path.join(os.path.dirname(__file__), "..", "data", ".cache", "models"))
AESTHETIC_URL = (
    "https://github.com/christophschuhmann/improved-aesthetic-predictor/raw/main/sac+logos+ava1-l14-linearMSE.pth"
)
FACE_MAX_SIDE = 2048  # detection runs on a downscaled copy for speed
CLIP_BATCH = 16


def send(obj):
    _proto.write(json.dumps(obj) + "\n")
    _proto.flush()


def log(*args):
    print("[worker]", *args, file=sys.stderr, flush=True)


def b64_f32(arr):
    import numpy as np

    return base64.b64encode(np.asarray(arr, dtype="<f4").tobytes()).decode("ascii")


def laplacian_var(gray):
    import cv2

    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def resize_to(gray, long_side=None, height=None):
    """Downscale only (never upscale, which would fake blur)."""
    import cv2

    h, w = gray.shape[:2]
    if long_side is not None:
        s = long_side / max(h, w)
    else:
        s = height / h
    if s >= 1:
        return gray
    return cv2.resize(gray, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)


class GpuOutOfMemory(Exception):
    pass


def is_oom(e):
    """CUDA out-of-memory from torch or onnxruntime (which raises a generic error with a message)."""
    msg = str(e).lower()
    return (
        type(e).__name__ == "OutOfMemoryError"
        or "out of memory" in msg
        or "failed to allocate memory" in msg
        or "cudnn_status_alloc_failed" in msg
        or "cublas_status_alloc_failed" in msg
    )


class Analyzer:
    """Runs on the GPU when available. If the GPU runs out of memory (e.g. a game is using it),
    it switches to the CPU for the rest of the session: slower, but analysis keeps working.
    LORA_WORKER_DEVICE=cpu forces the CPU from the start."""

    def __init__(self, force_cpu=False):
        import torch

        os.makedirs(MODELS_DIR, exist_ok=True)
        self.torch = torch
        force_cpu = force_cpu or os.environ.get("LORA_WORKER_DEVICE", "").lower() == "cpu"
        self.device = "cuda" if torch.cuda.is_available() and not force_cpu else "cpu"
        self.fallback_reason = None
        log("device:", self.device)
        self._load_clip()
        self._load_aesthetic()
        self._load_faces()

    def to_cpu(self, reason):
        """Move every model to the CPU (after a GPU out-of-memory error)."""
        log("switching to CPU:", reason)
        self.device = "cpu"
        self.fallback_reason = reason
        self.clip = self.clip.to("cpu").float()
        self.aesthetic = self.aesthetic.to("cpu")
        self.faces = None
        try:
            self.torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        self._load_faces()

    def _load_clip(self):
        import open_clip

        log("loading CLIP ViT-L-14 (OpenAI) ...")
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-L-14-quickgelu", pretrained="openai", device=self.device, cache_dir=os.path.join(MODELS_DIR, "open_clip")
        )
        model.eval()
        self.clip = model
        self.preprocess = preprocess

    def _load_aesthetic(self):
        """LAION improved aesthetic predictor: an MLP on normalized CLIP ViT-L/14 embeddings (score ~1-10)."""
        nn = self.torch.nn
        path = os.path.join(MODELS_DIR, "aesthetic", "sac+logos+ava1-l14-linearMSE.pth")
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            log("downloading aesthetic predictor weights ...")
            urllib.request.urlretrieve(AESTHETIC_URL, path + ".part")
            os.replace(path + ".part", path)

        class MLP(nn.Module):
            def __init__(self):
                super().__init__()
                self.layers = nn.Sequential(
                    nn.Linear(768, 1024), nn.Dropout(0.2),
                    nn.Linear(1024, 128), nn.Dropout(0.2),
                    nn.Linear(128, 64), nn.Dropout(0.1),
                    nn.Linear(64, 16), nn.Linear(16, 1),
                )

            def forward(self, x):
                return self.layers(x)

        mlp = MLP()
        mlp.load_state_dict(self.torch.load(path, map_location="cpu", weights_only=True))
        self.aesthetic = mlp.to(self.device).eval()

    def _load_faces(self):
        import onnxruntime as ort
        from insightface.app import FaceAnalysis

        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()  # pick up CUDA/cuDNN libs installed by pip (torch / nvidia-* wheels)
            except Exception as e:  # noqa: BLE001
                log("onnxruntime preload_dlls failed:", e)
        available = ort.get_available_providers()
        wanted = ("CUDAExecutionProvider", "CPUExecutionProvider") if self.device == "cuda" else ("CPUExecutionProvider",)
        providers = [p for p in wanted if p in available]
        log("loading InsightFace buffalo_l with", providers, "...")
        self.faces = FaceAnalysis(name="buffalo_l", root=os.path.join(MODELS_DIR, "insightface"), providers=providers)
        self.faces.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
        self.face_providers = providers

    def info(self):
        return {"device": self.device, "faceProviders": self.face_providers, "fallback": self.fallback_reason}

    def _analyze_one(self, path, crop=None):
        import cv2
        import imagehash
        import numpy as np
        from PIL import Image, ImageOps

        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
        if crop:
            # Normalized x, y, w, h relative to the EXIF-rotated image (same as the app).
            W, H = im.size
            x, y, cw, ch = crop
            left, top = round(x * W), round(y * H)
            right, bottom = min(W, left + max(1, round(cw * W))), min(H, top + max(1, round(ch * H)))
            im = im.crop((left, top, right, bottom))
        w, h = im.size
        rgb = np.asarray(im)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

        result = {
            "width": w,
            "height": h,
            "sharpness": laplacian_var(resize_to(gray, long_side=1024)),
            "brightness": float(gray.mean()),
            "darkClip": float((gray < 8).mean()),
            "brightClip": float((gray > 247).mean()),
            "phash": str(imagehash.phash(im)),
            "faces": [],
        }

        scale = min(1.0, FACE_MAX_SIDE / max(w, h))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        det = bgr if scale >= 1 else cv2.resize(bgr, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        for f in self.faces.get(det):
            x1, y1, x2, y2 = (float(v) / scale for v in f.bbox)
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            crop = gray[int(y1):int(y2), int(x1):int(x2)]
            pose = getattr(f, "pose", None)
            result["faces"].append({
                "bbox": [x1 / w, y1 / h, x2 / w, y2 / h],
                "det": float(f.det_score),
                "sharpness": laplacian_var(resize_to(crop, height=256)),
                "pose": [float(v) for v in pose] if pose is not None else None,  # pitch, yaw, roll (degrees)
                "age": int(f.age) if getattr(f, "age", None) is not None else None,
                "sex": getattr(f, "sex", None),
                "embedding": b64_f32(f.normed_embedding),
            })
        result["faces"].sort(key=lambda fc: (fc["bbox"][2] - fc["bbox"][0]) * (fc["bbox"][3] - fc["bbox"][1]), reverse=True)
        return result, im

    def analyze(self, paths, crops=None):
        try:
            return self._analyze(paths, crops)
        except GpuOutOfMemory as e:
            if self.device == "cpu":
                raise
            self.to_cpu(f"GPU out of memory ({e})")
            return self._analyze(paths, crops)

    def _analyze(self, paths, crops):
        torch = self.torch
        results, images = [], []
        crops = crops or [None] * len(paths)
        for p, crop in zip(paths, crops):
            try:
                r, im = self._analyze_one(p, crop)
                results.append(r)
                images.append(im)
            except Exception as e:  # noqa: BLE001
                if self.device == "cuda" and is_oom(e):
                    raise GpuOutOfMemory(str(e)[:200]) from e
                log("analyze failed:", p, e)
                results.append({"error": f"{type(e).__name__}: {e}"})
                images.append(None)

        ok = [i for i, im in enumerate(images) if im is not None]
        for start in range(0, len(ok), CLIP_BATCH):
            idx = ok[start:start + CLIP_BATCH]
            batch = torch.stack([self.preprocess(images[i]) for i in idx]).to(self.device)
            try:
                with torch.no_grad(), torch.autocast(self.device, enabled=self.device == "cuda"):
                    emb = self.clip.encode_image(batch).float()
            except Exception as e:  # noqa: BLE001
                if self.device == "cuda" and is_oom(e):
                    raise GpuOutOfMemory(str(e)[:200]) from e
                raise
            emb = emb / emb.norm(dim=-1, keepdim=True)
            with torch.no_grad():
                scores = self.aesthetic(emb).squeeze(-1).cpu().tolist()
            emb = emb.cpu().numpy()
            for j, i in enumerate(idx):
                results[i]["aesthetic"] = float(scores[j])
                results[i]["clip"] = b64_f32(emb[j])
        return results


def load_analyzer():
    """Load the models on the GPU; if that alone runs out of memory, load them on the CPU."""
    try:
        return Analyzer()
    except Exception as e:  # noqa: BLE001
        if not is_oom(e):
            raise
        log("GPU out of memory while loading models; using the CPU:", e)
        import torch

        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        a = Analyzer(force_cpu=True)
        a.fallback_reason = "GPU out of memory while loading models"
        return a


def main():
    analyzer = None
    send({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        mid, op, args = msg.get("id"), msg.get("op"), msg.get("args") or {}
        try:
            if op == "ping":
                result = "pong"
            elif op == "load":
                if analyzer is None:
                    analyzer = load_analyzer()
                result = analyzer.info()
            elif op == "analyze":
                if analyzer is None:
                    analyzer = load_analyzer()
                result = analyzer.analyze(args["paths"], args.get("crops"))
            elif op == "shutdown":
                send({"id": mid, "ok": True, "result": None})
                break
            else:
                raise ValueError(f"unknown op: {op}")
            send({"id": mid, "ok": True, "result": result})
        except Exception as e:  # noqa: BLE001
            log(traceback.format_exc())
            send({"id": mid, "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
