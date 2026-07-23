# pi-diffusion-canvas

A [Pi](https://pi.dev) widget that shows how a diffusion LLM's text actually
forms. Diffusion models like DiffusionGemma denoise a whole block of tokens at
once, so a normal client only sees text arrive in big silent bursts. This
widget renders the server's real intermediate canvas on every denoising step:
accepted tokens mixed with the sampler's renoise tokens, converging into the
final text right above your editor.

## Requirements

- A vLLM server with the diffusion canvas side channel, started with
  `--diffusion-stream-canvas`. Until the feature is available in a vLLM
  release, use the fork tag (pure-Python overlay on official binaries):

```bash
VLLM_USE_PRECOMPILED=1 \
VLLM_PRECOMPILED_WHEEL_COMMIT=4e5ca89cfe98121642d76b40e32a006f4d0fbf3b \
pip install git+https://github.com/osolmaz/vllm@canvas-v0.23.1rc3
```

Without the side channel the widget falls back to a clearly labeled
simulation paced by the real commit bursts.

## Install

This package is not published to a registry; it lives in the
[localpi](https://github.com/dutifuldev/localpi) repository. Install it into
plain Pi from a local checkout (Pi git installs point at repository roots,
so clone first):

```bash
git clone https://github.com/dutifuldev/localpi
pi install ./localpi/packages/diffusion-canvas
```

Or run localpi with `--diffusion-canvas`, which bundles this package.

## Configuration

None needed in the common case: the widget derives the server's
`/v1/diffusion/events` and `/metrics` URLs from the active model's `baseUrl`.
To point it elsewhere (e.g. a separate metrics port), set:

- `PI_DIFFUSION_CANVAS_EVENTS_URL`
- `PI_DIFFUSION_CANVAS_METRICS_URL`

## What you see

```
 the committed text flows straight into the canvas still being denoi
 sed: accepted tokens mixed with ren··se tok·ns co··erging int· ····
 diffusion canvas | live | 1 commits | ~303 tok/commit | ~82 tok/s | denoising canvas 2, step 24...
```

- Committed text is muted, the resolving canvas is accented, and both flow as
  one continuous document; on a commit the converged text flashes bright,
  stays in place as it mutes, and the next canvas continues mid-row.
- The stats line shows commits, tokens per commit, throughput, and the
  server-wide denoising steps per canvas from vLLM's Prometheus counters.
- After the turn, the widget collapses to the stats line.

## Privacy

The widget subscribes to the event stream scoped to its own request id
(assigned via the `X-Request-Id` header), so it never receives other
clients' canvas states from a patched server, and it never renders an
uncorrelated canvas regardless of server version.

## License

[MIT](../../LICENSE)
