#!/usr/bin/env bash
# Creates the Python analysis worker environment (worker/.venv).
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3.12}"
if ! command -v "$PY" >/dev/null; then
  echo "error: $PY not found. Install Python 3.12 or set PYTHON=/path/to/python3.x (3.10-3.12)." >&2
  exit 1
fi

[ -x worker/.venv/bin/python ] || "$PY" -m venv worker/.venv
VPY=worker/.venv/bin/python
"$VPY" -m pip install --upgrade pip wheel setuptools
"$VPY" -m pip install -r worker/requirements.txt
# insightface ships only as an sdist that needs Cython + numpy at build time.
"$VPY" -m pip install cython
"$VPY" -m pip install --no-build-isolation insightface
"$VPY" -c "import torch, onnxruntime; print('torch', torch.__version__, 'cuda:', torch.cuda.is_available()); print('onnxruntime providers:', onnxruntime.get_available_providers())"
echo "Worker environment ready."
