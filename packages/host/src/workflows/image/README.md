# image

Generate or edit images from a prompt, or cut a background out of a file. Port of the agent lane of the image stack:
`imgcli gen` and `imgcli cutout` through image-gateway to the IU endpoint, now one platform workflow whose capabilities
call the IU endpoint directly.

```
agw image "a lighthouse at dusk, blog header" --size 1536x1024 --quality low --n 2
agw image "make it dusk" --images '["/abs/photo.jpg"]'      # an edit
agw image "a leaf icon, bold silhouette" --size 1024x1024 --background transparent
agw image --file /abs/subject.png [--model bria]            # a cutout
```

Exactly one of `prompt` and `file`. The run answers with the files it made:

```json
{ "kind": "generate", "generationId": "…", "model": "…", "size": "1536x1024", "dir": "<artifacts>/image/<runId>",
  "files": [{ "path": "<artifacts>/image/<runId>/1.png", "bytes": 1234567, "width": 1536, "height": 1024, "hasAlpha": true }],
  "cost": { "usd": 0.0305, "source": "rate" }, "latencyMs": 21000 }
```

## Decisions

- **One workflow, told apart by the input.** The eval suite is named for the workflow (`agw eval run image`), and
  `agw image "<prompt>"` reads best; a `--file` is a cutout. A prompt and a file together, or neither, is a 400.
- **Paths are host paths.** Agents run on the mini and so does the host: `--images` and `--file` are read by the host and
  must be absolute. Each input is checked before a request: a regular file, within the size limit, a PNG, JPEG or WebP by
  its first bytes (never by its name). The host trusts its bearer-authenticated callers with a path, as `review` does with `cwd`.
- **The host writes no caller path.** Output goes to the platform artifact store (`packages/host/src/artifacts.ts`):
  `<root>/image/<runId>/<n>.png`, root `$AGW_ARTIFACTS_DIR` or `~/.local/state/agent-workflows/artifacts`. **Retention
  30 days**, swept on write (the first `artifactDir` of a process, then hourly); copy a file out to keep it.
- **The step journals paths, not pixels.** The capability returns base64, the step writes the files in the same body and
  journals only the listing: a 10-image high-quality run would otherwise put tens of MB in the journal.
- **Cost is recorded on the step** like an LLM call, through `ctx.addUsage`. Image generation bills tokens at three rates
  (text in, image in, image out), Replicate bills a flat price per call, so routes carry a `price`
  (`packages/routes/src/price.ts`: a general `unit` price, per image, character, second or call, with optional `per` scaling
  and tiers keyed by attributes such as quality and size, plus the `image-tokens` split; `Rate` stays text-only). A cost the provider reports (`usage.cost`) wins. A call with no
  usage and no price is `unknown`, never 0. Model ids and prices live only in the route table.
- **Routing is the gateway's `auto`.** An edit and `high`/`xhigh`/`max` go to the quality model (`sunburst`), drafts to
  the speed model (`flare`); `--model` forces one. The two bill alike.
- **Size snapping.** A `WxH` the endpoint refuses (not a multiple of 16, ratio over 3:1, outside the pixel envelope) is
  snapped into the envelope instead of failing; the output says `snappedFrom`. `auto` and the presets pass through.
- **Retries and failure modes** are image-gateway's, verified against the live endpoint: 429/5xx retry (3 attempts, 0.5 s
  × 3^i), 410 (a retired model) fails fast, and a 503 that wraps a 400, in either of its two shapes (the `user_error`
  body, the `StatusCode: BadRequest` body), is never retried and carries the vendor's message, moderation stage and
  categories included. A body that is not a PNG by its first bytes fails the run; the call was billed, so its usage is on the run.
- **Cutout (Replicate through the same IU host).** The base is IU's OpenAI base with `/openai/v1` swapped for
  `/replicate/v1` (`REPLICATE_BASE_URL` overrides). `Prefer: wait`, then poll the flat `/predictions/{id}` while it runs;
  the output URL must be on `replicate.delivery`. recraft delivers WebP, bria PNG: both come back PNG (`Bun.Image`, no
  `sharp`). recraft's input limits (5 MB, sides 256–4096 px, 16 MP) are enforced up front.
- **Left on image-gateway:** `imgcli icon` (the favicon/app-icon set: upscale, cutout, trim, `.ico`/`.icns` writers,
  vectorize) needs `sharp` and `svgo` and is deterministic image processing, not an agent capability; `imgcli gen
  --enhance` (the gateway's playbook planner). The icon *source* is `agw image … --size 1024x1024 --background transparent`.
  The gateway keeps both, and the studio app, until a later wave decides.

## Eval

Suite `image` (`agw eval run image`), plain cases in `$AGW_EVAL_DIR/image/cases.jsonl` (private):
`{id, input: <workflow input>, reference: null}`. Eight cases: a blog header, an icon source (transparent), an OG image,
a photo edit with an input image, two cutouts on generated images, and two more of the kinds the `/img` skill names.

The scorer (`scorer.ts`) is deterministic and reads the files on disk, not the output's claims:

|Score|Meaning|
|-|-|
|`valid`|the output fits its schema; every listed file is a PNG on disk whose header agrees with the listed size and bytes. Failing it is the only score|
|`count`|`n` images for a generation, one for a cutout|
|`size`|share of files at the size the run reports as requested after snapping; 0 if that report does not follow from the input. Left out for `auto`|
|`alpha`|cutout, or `background: transparent`: share of files with an alpha channel (header; says nothing about a pixel being transparent)|
|`cost`|the run recorded a price|

`pass` = every score present is 1. The legacy arm is `scripts/eval-legacy/image.ts` (`imgcli gen|cutout --json`, scored by
the same function). Neither is run live without the lead.
