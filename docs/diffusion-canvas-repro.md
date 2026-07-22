# Reproducing the live diffusion canvas

This documents every piece needed to reproduce the truthful diffusion canvas
visualization: DiffusionGemma served by a patched vLLM that streams its
intermediate denoising states, rendered live in the Pi TUI.

## The pieces

| Piece                 | Where it lives                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| vLLM canvas streaming | [`osolmaz/vllm`](https://github.com/osolmaz/vllm), branch `diffusion-canvas-events`, release tag `canvas-v0.23.1rc2` | Adds the opt-in `--diffusion-stream-canvas` server flag and the `GET /v1/diffusion/events` SSE side channel that emits the detokenized canvas on every denoising step. See the fork's [`DIFFUSION_CANVAS.md`](https://github.com/osolmaz/vllm/blob/diffusion-canvas-events/DIFFUSION_CANVAS.md). Tracked as [PR #1 on the fork](https://github.com/osolmaz/vllm/pull/1). |
| Pi widget             | [`packages/diffusion-canvas`](../packages/diffusion-canvas/) in this repo                                            | Standalone Pi package that renders the canvas above the editor. Not published to a registry; this repo is its home.                                                                                                                                                                                                                                                      |
| localpi wiring        | `--diffusion-canvas` flag                                                                                            | Loads the packaged extension into the Pi session it launches.                                                                                                                                                                                                                                                                                                            |

The vLLM changes are deliberately not upstreamed; they are maintained as
tagged fork releases (`canvas-v<upstream version>rc<N>`, PEP 440-parseable so
vLLM's version detection accepts them).

## 1. Install the patched vLLM

All fork changes are pure Python, so the install overlays them on the
official precompiled kernels — no compilation:

```bash
VLLM_USE_PRECOMPILED=1 \
VLLM_PRECOMPILED_WHEEL_COMMIT=4e5ca89cfe98121642d76b40e32a006f4d0fbf3b \
pip install git+https://github.com/osolmaz/vllm@canvas-v0.23.1rc2
```

`VLLM_PRECOMPILED_WHEEL_COMMIT` pins the official wheel that provides the
binary artifacts. It must match the fork release's upstream base commit,
which is recorded in the fork's `DIFFUSION_CANVAS.md`.

## 2. Serve DiffusionGemma with canvas streaming

```bash
vllm serve nvidia/diffusiongemma-26B-A4B-it-NVFP4 \
  --host 127.0.0.1 --port 8000 \
  --max-model-len 32768 --max-num-seqs 16 --max-num-batched-tokens 8192 \
  --kv-cache-dtype fp8 \
  --enable-auto-tool-choice --tool-call-parser gemma4 \
  --diffusion-stream-canvas
```

`--diffusion-stream-canvas` requires the single-process FastAPI frontend (no
`--grpc`, headless mode, or external/hybrid/multi-port data-parallel load
balancing); the server rejects incompatible combinations at startup.

To sanity-check the side channel independently of any client:

```bash
curl -N http://127.0.0.1:8000/v1/diffusion/events
```

then run any chat completion against the server; per-step JSON events
(`request_id`, `step`, `text`) should stream out.

## 3. Run the visualizer

Through localpi:

```bash
localpi --runtime vllm --model nvidia/diffusiongemma-26B-A4B-it-NVFP4 --diffusion-canvas
```

Or in plain Pi, install the package from a checkout of this repo:

```bash
pi install ./localpi/packages/diffusion-canvas
```

The widget needs no configuration: it derives the events and metrics URLs
from the active model's `baseUrl`, with `PI_DIFFUSION_CANVAS_EVENTS_URL` and
`PI_DIFFUSION_CANVAS_METRICS_URL` as overrides. Against a server without the
side channel it falls back to a clearly labeled simulation paced by the real
commit bursts.

## How the truthful path works

- Each denoising step, vLLM's diffusion sampler produces an `argmax_canvas`
  (its current best guess for every canvas position). The fork carries these
  through the draft-token path into `EngineCoreOutput`, detokenizes them in
  the API server, and broadcasts them on `/v1/diffusion/events`.
- The Pi extension assigns each completion a request id up front via the
  `X-Request-Id` header (vLLM derives the `chatcmpl-*` id from it), then
  subscribes to the side channel scoped to that id
  (`?request_id=...`). Uncorrelated canvases are never rendered, so a shared
  server cannot leak another client's text into the TUI.
- The widget renders committed text and the resolving canvas as one
  continuous document with a tail window, keeps a stable height, and
  substitutes glyphs of ambiguous terminal width, so the TUI's differential
  renderer never leaves stale frames in scrollback.

## Upgrading the fork to a newer vLLM

1. Rebase `diffusion-canvas-events` onto the new upstream base commit.
2. Run the fork's test suite: `pytest tests/v1/engine/test_diffusion_events.py`.
3. Update the base commit in the fork's `DIFFUSION_CANVAS.md` and in the
   install one-liners here and in the package README.
4. Tag the next `canvas-v<upstream version>rc<N>` and push the tag.
5. Re-verify the install one-liner in a scratch venv and the live TUI flow.
