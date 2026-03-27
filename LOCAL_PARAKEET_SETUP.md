# Local Parakeet Backend Setup (Backend Only)

This backend supports two modes:
- Mock mode: quick wiring validation (default)
- Live mode: real transcription via local `.nemo` model and Python bridge

## 1. Install backend dependencies

```powershell
Set-Location "c:\project\study snap\backend"
npm install
```

## 2. Create backend env file

Copy `.env.example` to `.env` and set values.

Required minimum:

```env
JWT_SECRET=change_this_to_a_long_secret
PARAKEET_MODEL_PATH=../parakeet-tdt-0.6b-v2.nemo
PARAKEET_MOCK_MODE=false
PARAKEET_PYTHON_COMMAND=python
PARAKEET_INFER_SCRIPT_PATH=./scripts/parakeet_transcribe.py
```

## 3. Install Python dependencies for NeMo

Use the Python environment where you will run inference.

```powershell
python -m pip install --upgrade pip
python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
python -m pip install nemo_toolkit[asr]
```

Notes:
- For GPU, install CUDA-compatible PyTorch instead of CPU wheels.
- Package installation can take several minutes.

## 4. Start backend

```powershell
Set-Location "c:\project\study snap\backend"
npm run dev
```

## 5. Validate health endpoint

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:8080/health"
```

Expected response:

```json
{
  "ok": true,
  "service": "study-snap-backend"
}
```

## 6. Create transcription session token

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/api/session"
```

The response includes `token` used in websocket URL:

```text
ws://localhost:8080/ws/transcribe?token=<token>
```

## 7. Runtime behavior in live mode

- Audio chunks are buffered as PCM16 mono.
- Backend periodically runs local Python inference and emits `transcript.partial`.
- On `session.stop`, backend runs final inference and emits `transcript.final`.

## 8. Common issues

1. `Model not found`:
- Fix `PARAKEET_MODEL_PATH` in `.env`.

2. `Missing NeMo dependencies`:
- Install `nemo_toolkit[asr]` and PyTorch in the same Python environment used by `PARAKEET_PYTHON_COMMAND`.

3. Inference timeout:
- Increase `PARAKEET_INFERENCE_TIMEOUT_MS`.
- Use smaller buffered audio duration or GPU runtime.

## 9. Run backend smoke test client

After backend is running, execute:

```powershell
Set-Location "c:\project\study snap\backend"
npm run smoke:ws
```

What this does:
- Creates a session token via `POST /api/session`
- Opens websocket to `/ws/transcribe`
- Sends synthetic PCM16 chunks
- Prints `transcript.partial`, `transcript.final`, and `session.ended` messages
