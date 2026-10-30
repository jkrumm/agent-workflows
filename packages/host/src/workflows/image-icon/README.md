# image-icon

A full icon set from one master image: `favicon.ico`, `favicon.svg`, the PWA icons (`icon-192`, `icon-512`, a maskable
`icon-mask`), `apple-touch-icon`, `icon-1024` and the macOS `AppIcon.icns`, plus the `<link>` tags and the manifest.
Port of image-gateway's `/icons` route (`imgcli icon`); the outputs and their order are the gateway's.

```
agw image-icon /abs/logo.png
agw image-icon /abs/logo.png --background '#0b1020' --svg never
agw image-icon /abs/photo.jpg --cutout always --cutout-model bria --upscale never
```

The command is `image-icon`, not `image icon`: the host refuses a command that is the prefix of another
(`assertCommands`, `packages/host/src/app.ts`), and `agw image` exists. The capability `image-enhance` follows the same rule.

|Input|Default|Meaning|
|-|-|-|
|`file`|required|Absolute path on the host: png, jpeg or webp by magic bytes, at most 20 MiB|
|`background`|`#ffffff`|`#rrggbb` fill for the opaque targets only: `apple-touch-icon`, `icon-mask`, `icon-1024`|
|`cutout`|`auto`|`auto` cuts the background out only when the master has no real transparency; `always`; `never`|
|`cutoutModel` (`--cutout-model`)|`recraft`|`recraft` ($0.01) or `bria` ($0.018)|
|`upscale`|`auto`|`auto` under 512 px long edge, 4x (8x under 128 px); `always` accepts at most 1440 px; `never`|
|`svg`|`auto`|`auto` vectorizes the master into `favicon.svg`; `never`|

## Output

```json
{ "dir": "<artifacts>/image-icon/<runId>", "workDir": "<artifacts>/image-icon/<runId>/work",
  "files": [{ "name": "favicon.ico", "path": "…/favicon.ico", "mime": "image/x-icon", "width": 48, "height": 48, "bytes": 5421 }, …],
  "html": "<link rel=\"icon\" href=\"/favicon.ico\" sizes=\"32x32\">\n…", "htmlPath": "…/head.html",
  "manifest": { "icons": [ … ] }, "manifestPath": "…/manifest.webmanifest",
  "steps": [{ "step": "vectorize", "model": "<the image.vectorize route's model>", "costUsd": 0.01, "latencyMs": 9000 }],
  "cost": { "usd": 0.01, "source": "rate" }, "latencyMs": 11000 }
```

`files` is the gateway's list, in its order: `favicon.ico`, `favicon.svg` (when made; width and height 0, an SVG has no
pixel size), `icon-192.png`, `icon-512.png`, `icon-mask.png`, `apple-touch-icon.png`, `icon-1024.png`, `AppIcon.icns`.
`head.html` and `manifest.webmanifest` are written beside them and given as `html` / `manifest`. `steps` lists only the
model steps that ran; `cost` is their sum (usd 0 when none ran, `unknown` when any ran step's price is unknown).
`svgSkippedReason` is set when `favicon.svg` was left out.

## Steps

Each step journals paths and small facts, never pixels. Intermediates are written to `<dir>/work/` because the
capabilities read their input from the host's disk.

|Step|Cost|What|
|-|-|-|
|`prepare`|free|Read and validate the file, decode it (EXIF applied), choose the upscale scale, refuse a run whose cutout could not take the upscaled size (see Decisions), write `work/source.png`|
|`upscale`|$0.002|Only when a scale was chosen: `image.upscale` (real-esrgan) on `source.png` -> `work/upscaled.png`|
|`cutout`|$0.01 (bria $0.018)|Decided inside the step on the current image: `always`, or `auto` and no real transparency. Then the image is normalised (PNG, at most 1536 px) into `work/cutout-input.png` and sent to `image.cutout` -> `work/cutout.png`. Otherwise it returns `ran: false` with no call|
|`render`|free|Clean near-transparent pixels, trim and centre on a square master (`work/master.png`), render every raster and write it to `<dir>/`|
|`vectorize`|$0.01|Only for `svg: auto`: the master on a 1024 canvas (`work/vectorize-input.png`) -> `image.vectorize`, then the result is stripped of the root `width`/`height`/`style` and no-op transforms and optimised with svgo. Over 64 KB it is dropped (`svgSkippedReason`), else written as `favicon.svg`|

After the steps, plain code orders the file list, writes `head.html` (the svg link only if `favicon.svg` exists) and
`manifest.webmanifest`. A failure in any step fails the run; the model steps that already ran stay on the run record,
and the error names them with their total ("already billed: upscale $0.002, cutout $0.01; total $0.012").

## Decisions

- **sharp and svgo, not `Bun.Image`.** Verified: `Bun.Image` has no raw pixel output, no crop, no pad and no flatten, which
  the trim, the square master and the opaque targets need. `sharp` and `svgo` are `packages/host` dependencies; the ICO
  and ICNS containers are hand-written (`containers.ts`), as neither encoder writes them.
- **`image-icon`, not `image icon`:** the prefix rule above.
- **Intermediates stay in `work/`** instead of being cleaned up: they show what each model returned, and the artifact
  sweep removes the whole run directory.
- **Golden fixture = a real image-gateway run.** `packages/host/test/fixtures/image-icon/` holds the source and the
  output set of the gateway's run of 2026-10-29 (image-gateway @ 3efdf8a, default background). On the same sharp version
  the rasters, the ICO, the ICNS and the cleaned SVG are byte-identical to the gateway's (`image-icon-golden.test.ts`).
- **The SVG is omitted above 64 KB.** Browsers prefer the SVG icon, so a bloated one (gradient or photographic art) is
  worse than none; the PNG/ICO set stands and the head tags have no svg link.
- **The cutout's 256 px minimum is checked in `prepare`, before anything is billed.** recraft needs a short edge of at
  least 256 px, and `upscale: auto` makes an 8x of a source under 128 px, so a 16 px opaque icon would pay for an upscale
  (128 px) and then fail its cutout. When a cutout will run (`always`, or `auto` on an image without transparency) and
  `min(width, height) * scale` is under 256, the run fails with `invalid_input` naming both sizes and suggesting
  `--cutout never` or a larger source. With `--cutout never` such a source runs as usual (upscale, render, vectorize).
- **The square master is at most 8192 px a side.** The master is the trimmed subject on a square canvas of its long side,
  so a 20000x1000 subject would allocate 20000x20000 before failing in the renderer on sharp's 268 MP limit. A subject
  over 8192 px on its long side is `invalid_input` from `buildMaster`, before any canvas exists.
- **Caller bytes decode up to 64 MP** (`limitInputPixels`, a deliberate source limit instead of sharp's 268 MP default).
  A larger image is `invalid_input` ("unreadable image: Input image exceeds pixel limit") from the first read. The
  64 MP is also what `image.upscale` may deliver.
- **The SVG is guarded against active content.** It is published under `public/`. svgo runs with `removeScripts` on
  top of the default preset (scripts, event-handler attributes, `javascript:` links); if the result still contains
  `<script`, `<foreignObject`, an `on...=` attribute or `javascript:`, `cleanVectorized` throws and no `favicon.svg` is
  written (the vectorize price stays on the run).
- **The poll deadline is per capability.** Replicate predictions are polled for 60 s by default; `image.upscale` waits
  up to 180 s because real-esrgan 4x/8x can run longer than a cutout.
- **The Replicate models are routes** in the route table (`image.upscale`, `image.vectorize`, `image.cutout.*`;
  `packages/routes/src/table/image.ts`), priced per call and overridable by `AGW_ROUTES` like any route.
- **No eval suite.** The outputs are deterministic image processing, covered by the golden and pipeline tests; the three
  model steps are tested against the fake Replicate server (`image-icon.test.ts`).

## Retention

Files are in the platform artifact store and swept 30 days after the run directory's last change
(`packages/host/src/artifacts.ts`). Copy out what you keep (the icons into the project's `public/`).
