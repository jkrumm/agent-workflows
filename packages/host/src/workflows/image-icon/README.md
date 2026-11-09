# image-icon

A full icon set from one master image: `favicon.ico`, `favicon.svg`, the PWA icons (`icon-192`, `icon-512`, a maskable
`icon-mask`), `apple-touch-icon`, `icon-1024` and the macOS `AppIcon.icns`, plus the `<link>` tags and the manifest.
Port of image-gateway's `/icons` route (`imgcli icon`); the outputs and their order are the gateway's.

```
agw image-icon /abs/logo.png
agw image-icon /abs/logo.png --background '#0b1020' --svg never
agw image-icon /abs/photo.jpg --cutout always --cutout-model bria --upscale never
agw image-icon /abs/logo.png --flat /abs/logo-flat.png --card-title 'Acme' --card-line 'Plans that ship'
```

For a logo, the master is the winner of a breadth round and edits (`../image/README.md` §A logo or app icon). A metallic or
gradient master gets no usable `favicon.svg`: pass a flat derivative as `--flat` and the master keeps the PNG set.

The command is `image-icon`, not `image icon`: the host refuses a command that is the prefix of another
(`assertCommands`, `packages/host/src/app.ts`), and `agw image` exists. The capability `image-enhance` follows the same rule.

|Input|Default|Meaning|
|-|-|-|
|`file`|required|Absolute path on the host: png, jpeg or webp by magic bytes, at most 20 MiB|
|`background`|none|`#rrggbb` fill for the opaque targets: `apple-touch-icon`, `icon-mask`, `icon-1024`. Without it: `#ffffff` for a master without a tile, the tile's own colour bleeding into the corners for a master with one|
|`flat`|none|Absolute path of a flat derivative (png, jpeg, webp, at most 20 MiB, 64 MP): drives `favicon.ico` and `favicon.svg` instead of the master. No upscale, cutout or model step runs on it|
|`cardTitle` (`--card-title`)|none|1 to 80 chars. Makes `og-image.png` (1200x630) and the og/twitter head tags|
|`cardLine` (`--card-line`)|none|1 to 160 chars under the title; without `cardTitle` the run fails with `invalid_input` before anything is billed|
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
`svgSkippedReason` is set when `favicon.svg` was left out. With `cardTitle`, `og-image.png` (1200x630) follows
`AppIcon.icns`. `tile` is `true` when the master carried a rounded tile: the full-bleed targets extend it and the icns sits
on the macOS grid. The og tags in `head.html` use a relative `og:image`; scrapers want an absolute URL, which the site
prefixes.

## Steps

Each step journals paths and small facts, never pixels. Intermediates are written to `<dir>/work/` because the
capabilities read their input from the host's disk.

|Step|Cost|What|
|-|-|-|
|`prepare`|free|Read and validate the file, decode it (EXIF applied), choose the upscale scale, refuse a run whose cutout could not take the upscaled size (see Decisions) and a `cardLine` without `cardTitle`, write `work/source.png`; with `flat`, validate and decode it the same way into `work/flat-source.png` (journaled as `flatPath`)|
|`upscale`|$0.002|Only when a scale was chosen: `image.upscale` (real-esrgan) on `source.png` -> `work/upscaled.png`|
|`cutout`|$0.01 (bria $0.018)|Decided inside the step on the current image: `always`, or `auto` and no real transparency. Then the image is normalised (PNG, at most 1536 px) into `work/cutout-input.png` and sent to `image.cutout` -> `work/cutout.png`. Otherwise it returns `ran: false` with no call|
|`render`|free|Clean near-transparent pixels, trim and centre on a square master (`work/master.png`), detect a tile (journaled as `tile`), build the flat source the same way (`work/small-master.png`), render every raster and write it to `<dir>/`; with `cardTitle` also `og-image.png`|
|`vectorize`|$0.01|Only for `svg: auto`: the small master (the flat source, else the master) on a 1024 canvas (`work/vectorize-input.png`) -> `image.vectorize`, then the result is stripped of the root `width`/`height`/`style` and no-op transforms and optimised with svgo. Over 64 KB it is dropped (`svgSkippedReason`), else written as `favicon.svg`|

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
- **A tile is detected, not declared** (`tile.ts`). The core is the pixels with alpha >= 250. A master is a tile when the
  core's bounding box is at least 16 px, near-square (sides within 3%), fills 90% of the box, is opaque at the centre of
  all four edges and transparent at all four box corners. A disc (fill 0.785), an already square opaque image and a glyph
  on transparency are no tile, so their outputs are exactly the pre-tile ones (the golden test).
- **A tile bleeds, or takes the caller's colour.** The three opaque targets from a tile master are the tile cropped at
  its core plus 2 px, every pixel under alpha 250 filled with the mean of the nearest opaque pixel in its row and in its
  column, alpha 255: no transparent corner, no inner edge, gradients continue. An explicit `background` flattens the crop
  on that colour instead; a colour other than the tile's leaves visible corners, the caller chose it.
- **The maskable safe zone is measured on the art.** Art is what differs from the tile's edge colour by more than 40
  (RGB distance, 4% rim ignored, measured at 256 px). If its half-extent exceeds the 409 px box, the tile square is scaled
  down and extended to 512 by edge replication, so no tile edge shows on a flat tile.
- **The icns sits on the macOS grid for a tile master only:** the original rounded tile at 824/1024 of every size,
  centred (100 px margin at 1024), over a soft shadow (black at 35% of the tile's alpha, sigma 1% of the size, 1.2% down).
  Without a tile the icns keeps its 10% padding and no shadow.
- **A light glyph gets a dark backing on the small targets.** A master (or `flat` source) with real transparency and an
  alpha-weighted mean luminance of at least 0.85 vanishes on a light browser tab: it is scaled to 70% on a rounded square
  (radius 22.5%) that fills the canvas, in the explicit `background` if that is darker than 0.4, else `#111827`. It drives
  the ico frames and the vectorize input, so `favicon.svg` has the backing too. A tile never gets it; the golden source
  (0.767) does not trigger it.
- **The card is free and uses system fonts.** `og-image.png` is built in `render` from SVG text (Helvetica, Arial,
  sans-serif) composited with sharp: no model, no network. Background is `background`, else the tile's edge colour, else
  white; text is white below luminance 0.5, else `#111827`. Lines wrap by a character-width estimate (title 64 px, 2 lines;
  line 32 px, 3 lines) and end in an ellipsis when cut.
- **The poll deadline is per capability.** Replicate predictions are polled for 60 s by default; `image.upscale` waits
  up to 180 s because real-esrgan 4x/8x can run longer than a cutout.
- **The Replicate models are routes** in the route table (`image.upscale`, `image.vectorize`, `image.cutout.*`;
  `packages/routes/src/table/image.ts`), priced per call and patched by an eval run's arm like any route.
## Eval

`agw eval run image-icon` replays six cases (`eval/cases.jsonl`, `PlainCase` lines) on synthetic master images
(`eval/disc-*.png`: a disc on an opaque or transparent ground, 64 to 512 px, drawn by `eval/generate.ts` from arithmetic,
nothing else; a test checks the committed PNGs against the generator). The case's `file` is a name in `eval/`; the suite's
reader makes it the absolute path the workflow wants, so a release finds it wherever it lives. The model steps cost
about $0.01 to $0.02 for the cases that run them; cases 05 and 06 run none and are free.

|Case|Input|Model steps|
|-|-|-|
|01|opaque 64 px, defaults|upscale (8x), cutout, vectorize|
|02|opaque 256 px, `cutout always`, `upscale never`, `svg never`|cutout|
|03|transparent 128 px, defaults|upscale (4x), vectorize|
|04|transparent 512 px, defaults|vectorize|
|05|opaque 512 px, `cutout never`, `upscale never`, `svg never`|none (the ground stays)|
|06|transparent 512 px, background `#0b1020`, everything `never`|none|

The scorer (`scorer.ts`, deterministic, reads the listed files) scores 0 or 1 each: `valid`, `files` (the spec's set in
order, on disk, size and mime), `dimensions` (48, 192, 512, 512, 180, 1024 from the listing and the PNG headers, ICO/ICNS/SVG
magic), `manifest` (its icons name listed PNGs of the stated size and type; `manifest.webmanifest` and `head.html` match;
the svg link only with a `favicon.svg`), `svg` (`never` leaves no file, reason or call; `auto` called vectorize and has the
file or the reason, not both), `background` (`apple-touch-icon.png` flattened on the input colour, white without one; only opaque for a tile master without one; `og-image.png` is in the spec exactly when a card was asked for, 1200x630) and `cost` (known, the
sum of the steps). With a case's reference also `steps` (the model steps that ran, in order) and `alpha` (is the ground gone
at the content corner of `icon-512.png`: the cutout worked, or the source had none). The scorer also runs on drift for
production runs, without a reference, while their artifacts still exist.

## Retention

Files are in the platform artifact store and swept 30 days after the run directory's last change
(`packages/host/src/artifacts.ts`). Copy out what you keep (the icons into the project's `public/`).
