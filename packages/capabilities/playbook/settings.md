# Settings Derivation

This studio's rules for turning a brief into concrete generation settings. The enhancer derives these; every derived value surfaces as an editable control, never hidden. Explicit user values are echoed verbatim and never overridden — see `overrides` in the `/enhance` v2 contract (`shared/src/plan.ts`).

## Quality and n — draft-first by default

**This is the most expensive decision you make. Get it right before anything else.**

At 1024×1024: `low` $0.006, `medium` $0.013, `high` $0.053 (~9× low), `xhigh` $0.094, `max` $0.211 (~35.8× low). `xhigh`/`max` exist for an explicit "print / maximum detail" request — most "final" requests are well served by `high`.

**Default, applied unless a rule below overrides it: `quality: low`, `n: 4`.**

Escalate only on an explicit signal:

| Signal                                                                                    | quality          | n   |
| ----------------------------------------------------------------------------------------- | ---------------- | --- |
| _(no explicit signal — the common case)_                                                  | `low`            | 4   |
| "draft / try / explore / variations / options / ideas"                                    | `low`            | 4–6 |
| "final / print / ship / publish / for the site" — an explicit finalization request        | `high`           | 1   |
| "maximum detail / print-ready / poster-quality" — an explicit maximum-fidelity request    | `xhigh` or `max` | 1   |
| Dense rendered text is central to the image (a poster's headline, a diagram's labels)     | `medium`         | 2   |
| Iteration on an accepted prompt (a delta re-run) whose parent already ran `high` or above | same tier        | 1   |
| The policy pre-check predicts an **input** block (`predicted_stage: "input"`)             | `low`            | 1   |

Rules for combining them:

- **`high`, `xhigh`, and `max` all imply `n: 1`.** Never propose any of them with `n > 1` — at `max` that's $0.85+ off a single brief. If the brief wants both variety and finish, propose `low` with a high `n` and say in `assumptions` that the winner should be promoted.
- **A subject being hard is not a finalization signal.** Photoreal portraits, intricate icons, and detailed illustrations still _draft_ at `low`. Difficulty is a reason to iterate more, not to pay 9–35.8× on the first attempt.
- **Never spend `high`/`xhigh`/`max` on a request you predict will fail.** If the policy pre-check raises a `hard`- or `rewrite`-severity input-stage warning, the request likely never reaches the renderer — derive `low`/`n: 1` and say why in `assumptions`.
- Whatever you derive, name the two-step in `assumptions` when you chose `low` for something the user may consider finished work (e.g. "drafting 4 at low ≈ $0.024; promote the winner to high ≈ $0.053").

## Model — two models, routed by intent

This studio generates on `gpt-image-2.5-flare` (speed-optimized — up to ~50% lower latency, best for drafts/iteration) and `gpt-image-2.5-sunburst` (quality-optimized — best for editing precision/reference preservation, slower). Never propose `gpt-image-2`, `gpt-image-1.5`, or `gpt-image-1-mini`; all three are retired from the generate path. (They still appear in the library on old generations — that is the read path, and it is none of your concern when deriving settings.)

Normally propose `model: "auto"` and let the gateway route:

- an edit (reference images attached) always routes to `sunburst` — editing precision matters more than the token-identical price difference in latency.
- a generate at `quality: high`, `xhigh`, or `max` routes to `sunburst` — it's the final render.
- a generate at `quality: low`, `medium`, or `auto` routes to `flare` — it's the draft/iteration loop.

Only propose an explicit model when the user names one directly; `auto` is otherwise always correct.

## Size — arbitrary `WxH` is always available

Both generatable models accept **arbitrary custom sizes on both generate and edit**. There are no presets-only cases anymore; never constrain a size because "the model only takes presets". The envelope:

- width and height are **multiples of 16**
- aspect ratio **≤ 3:1** in either direction
- total area **655,360–8,294,400 px**
- longest edge **< 3840**

Derive the size the brief actually wants and let `shared/src/rules.ts` snap it if it lands off-grid.

## The rest

These derive from the brief's _shape_, independent of the quality decision above:

| Signal in the brief                                     | Derivation                                                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Icon / logo / avatar / sticker                          | square 1024; transparent background — see "Background treatment" below                                                                                                                                            |
| Cover / banner / hero / wallpaper                       | wide custom size; 2560×1440 for journal covers                                                                                                                                                                    |
| Poster / portrait subject / phone                       | tall — 1024×1536, or a custom tall `WxH`                                                                                                                                                                          |
| Transparency ("transparent", "cutout", "no background") | derive `background: "transparent"` with `output_format: "png"` (or `"webp"`) — see "Background treatment"                                                                                                         |
| Edit with identity/product fidelity concerns            | nothing to derive — **never send `input_fidelity`**. Neither generatable model accepts the parameter (hard 400) and both are locked to high fidelity internally, so the behaviour you want is already the default |

The capability matrix is enforced by `shared/src/rules.ts`, not here — this table only describes what to _derive_; `rules.ts` disposes.

## Background treatment: transparency is AVAILABLE

Both generatable models (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`) have a real alpha channel (live-probed 2026-09-23: `background: "transparent"` + png/webp returns real RGBA). For any brief that wants a cutout, a sticker, a logo, or an icon "with no background":

- derive `background: "transparent"` with `output_format: "png"` (or `"webp"` — never `"jpeg"`, which has no alpha channel and is rejected outright);
- describe an **isolated subject with no background scenery** in the prompt — there is nothing to render behind it, so don't ask for one.

Apple Vision matting (`docs/research/transparency-and-vector.md`) was the interim restoration path while no generatable model had an alpha channel; it is no longer needed for fresh generations and is documented there only as history.

### Prompt text must match the `background` parameter

**The prompt text must never assert a background treatment that contradicts the `background` parameter this request sends.** Probe-verified failure, still true on the 2.5 models: send `background: "opaque"` while the prompt says "isolated on a transparent background", and the model does not ignore the mismatch — it **paints a fake transparency checkerboard directly into the image pixels**. The output has no alpha channel (opaque RGB, colortype 2) and the checkerboard is baked-in garbage, not real transparency.

- When you derive `background: "transparent"`, prompt text describing an isolated subject with no background is correct and expected — that is the point.
- When you derive `background: "opaque"` (or leave it `"auto"`), **never** write "transparent background", "cutout", "no background", or any checkerboard/transparency-pattern description into the prompt.
- **Never suggest chroma-key / green-screen generation as a transparency workaround.** Real alpha exists now, so there is even less reason to reach for it — it remains a separate, documented failure (colour leakage onto the subject, non-uniform "solid" colours, 1px halos — `docs/research/transparency-and-vector.md`), not a fallback for cases where alpha isn't available.

## Cost anchors

Cost anchors (probe-measured 2026-09-23, per generatable model @ 1024×1024): low $0.006, medium $0.013, high $0.053, xhigh $0.094, max $0.211 per image. Streaming preview overhead is per-model — flare emits zero partial frames (no overhead), sunburst adds a flat ~+$0.002 per streamed request. Implemented as `estimateCost()` in `shared/src/cost.ts`, which scales these anchors linearly with pixel count relative to 1024×1024.
