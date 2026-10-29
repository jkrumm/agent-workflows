# image

Generate or edit images from a prompt, or cut a background out of a file. Port of the agent lane of the image stack:
`imgcli gen` and `imgcli cutout` through image-gateway to the IU endpoint, now one platform workflow whose capabilities
call the IU endpoint directly.

```
agw image "a lighthouse at dusk, blog header" --size 1536x1024 --quality low --n 2
agw image "make it dusk" --images '["/abs/photo.jpg"]'      # an edit
agw image "a leaf icon, bold silhouette" --size 1024x1024 --background transparent
agw image --file /abs/subject.png [--model bria]            # a cutout
agw image "a leaf icon" --enhance --quality low             # plan first: playbook prompt, derived settings, policy check
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
  `/replicate/v1` (`REPLICATE_BASE_URL` overrides). `Prefer: wait`, then poll the flat `/predictions/{id}` while it runs
  (a transient poll failure is retried); the output URL must be on `replicate.delivery`, is fetched without following
  redirects and read within a byte bound. recraft delivers WebP, bria PNG: both come back PNG (`Bun.Image`, no `sharp`).
  recraft's input limits (5 MB, sides 256–4096 px, 16 MP) are checked on the file's **header** before anything decodes,
  so a crafted header cannot make the host allocate; the file is sent as it is (a camera JPEG stays a JPEG), except a
  JPEG with an EXIF rotation, which is re-encoded upright. **A started prediction is billed:** its price is recorded as
  soon as it is created, so a failed poll or the poll deadline still leaves the cost on the run.
- **`--enhance` is `imgcli gen --enhance`, ported** as the capability `image.enhance` (`brief`, `hasReferences`, optional
  `intent` and `mode`). image-gateway's playbook (`packages/capabilities/playbook/`, version 5) is the system prompt, one
  JSON plan comes back, and code disposes of it: the aggressiveness gate is by word count (under 25 full, 25–100
  gap-fill, over 100 passthrough, never the model's call), settings are routed and an invalid size snaps to the nearest
  preset (each correction is a note), a verbatim check lists brief tokens the prompt dropped, the cost is estimated from
  measured per-quality token anchors and the route's price. The workflow runs it as its own step; settings the caller
  gave win over the plan's, a `hard` warning refuses the run before an image is paid for. The model, effort (high) and
  a 32k ceiling are the `image.enhance` route (the gateway sent 16k and retried once with double on a truncated answer).
  Not ported: the studio-only inputs (style guide, series context, iteration `delta`, preserve list, pinned overrides).
- **The raw capabilities are hidden from the CLI.** `image.generate` and `image.cutout` answer megabytes of base64, so
  they carry `cli: { hidden: true }` (new in `CliSpec`; the generated CLI builds no command for them and does not list
  them as skipped). They stay on HTTP and in process. `image.enhance` is `agw image-enhance` (the workflow owns `agw image`, and the host refuses a command that is the prefix of another).
- **One bad image among n** does not discard the valid, billed ones: the output lists `rejected` entries and the valid
  files; the run fails only when none is valid.
- **Icon stays on image-gateway** (`imgcli icon`: upscale, cutout, trim, `.ico`/`.icns` writers, svgo vectorize). It needs
  `sharp` and `svgo` and has no model logic beyond `gen`, so it is deterministic image processing, not an agent
  capability. The icon *source* is `agw image … --size 1024x1024 --background transparent`; the gateway keeps the set
  builder and the studio app until a later wave decides.

## Route

Group file `packages/routes/src/table/image.ts`, image-gateway's seats called directly (no gateway in between), all on
IU's OpenAI base (`iu-openai`; Replicate is the `/replicate/v1` route of the same host). Overridable by `AGW_ROUTES` like
any route, `price` included (a model override without a price drops the old one).

|Route|Seat in image-gateway|Price|
|-|-|-|
|`image.flare`|speed model, drafts (`gateway/src/lib/pricing.ts` `RATES`)|`image-tokens`: text in 5, image in 8, out 30 USD/M|
|`image.sunburst`|quality model, finals and every edit|the same|
|`image.cutout.recraft`|`CUTOUT_PRICE_USD` (`shared/src/assets.ts`)|`unit` call, 0.01|
|`image.cutout.bria`|the same|`unit` call, 0.018|
|`image.enhance`|`ENHANCE_MODEL`, effort `high` (`gateway/src/env.ts`)|`rate` in 0.10, cached 0.01, out 0.50 USD/M; balance fallback like any text route|

## Eval

Suite `image` (`agw eval run image`), plain cases in `$AGW_EVAL_DIR/image/cases.jsonl` (private):
`{id, input: <workflow input>, reference: null}`. Eight cases: a blog header, an icon source (transparent), an OG image,
a photo edit with an input image, two more generations of the kinds the `/img` skill names, two cutouts of generated images.
Generations carry `size`, `n` and `quality: low`; both arms use the same.

The scorer (`scorer.ts`) is deterministic and reads the files on disk, not the output's claims, as pre-registered in
`docs/research/2026-10-29-wave8-ports.md` §image:

|Score|Meaning|
|-|-|
|`valid`|every listed file is a PNG (magic bytes) that decodes and agrees with the listing; `n` images (one for a cutout); a generation at a requested `WxH` is that size after snapping; a cutout has its input's dimensions. Failing it is the only score|
|`alpha`|cutout only: the decoded pixels carry an alpha channel with at least 5 % below 255 and at least 5 % at 255|
|`priced`|the run recorded a cost above 0|

`pass` = every score present is 1. The rule across arms is `rule.ts` (`evaluateRule`): (1) `valid` in every case and `alpha`
on both cutouts; (2) request parameters equal per case (model, size after snapping, quality, `n`); (3) per case
N cost ≤ 1.10 × L where both are priced, N priced in every case; (4) median wall(N) ≤ 1.25 × median wall(L).
`scripts/eval-legacy/image.ts` runs both arms (`imgcli gen|cutout --json` and `agw image`), one run per case each, scores both
with the same scorer and applies the rule; N's cost is the run record's. Neither is run live without the lead.
