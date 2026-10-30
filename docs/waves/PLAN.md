# `icon` into `agw image`, the studio on agw, image-gateway retired

**Goal:** nothing depends on the VPS image-gateway: `agw image icon` builds icon sets, the MacBook studio app talks to
agw through a tailnet door, `imgcli` keeps CDN upload and presigned links, and the gateway is gone from the VPS, the
monitors and the docs. Decision: `software-factory/docs/decisions.md` §Smaller. Track I1 in
`software-factory/docs/program.md`.
**Gate:** `make check` in every repo a wave touched, `/review` on the non-doc changes, `make verify` after each agw
deploy. The gateway stops only after the studio has generated, edited and enhanced through agw. Own-repo pushes and
deploys are routine.

Findings of 2026-10-30, checked against the code:

- **`icon` is not model-free.** `packages/host/src/workflows/image/README.md` §Icon says so and is wrong: `/icons` runs
  upscale (real-esrgan) and vectorize (recraft-vectorize), both Replicate, both priced in `image-gateway/shared/src/assets.ts`.
  agw has neither route. They belong in the route table like any model.
- **The studio does not call `/icons` or `/cutout`.** It calls `/generate`, `/edit` and `/enhance`, JSON and SSE partials
  (`image-gateway/app/src/lib/gateway.ts`), with one shared bearer in plaintext settings. Icon sets are local exports.
- **Only `imgcli icon` calls `/icons`** (`dotfiles/skills/img/scripts/imgcli`, `cmd_icon`). `gen` and `cutout` already run
  `agw image`.
- **Blockers for the studio on agw:** input paths are host-side and absolute, outputs land in host artifacts, `generate`
  has no streaming, and the studio's enhance inputs (style guide, series context, delta, preserve list, pinned overrides)
  are not ported.
- **The door has a pattern:** the audio door's path-restricted tailnet Caddy block with per-caller tokens in
  `door-tokens` (`dotfiles/config/Caddyfile`, `scripts/lib/caddy-registry.py`, `packages/audio/README.md` §Caller auth).
  The host process has no door of its own and door tokens are read only by the audio process.
- **The studio's real state is its local library** (`~/Pictures/ImageGen/`, `.imagegen/`), which is not regenerable. No
  wave touches it.

## Wave 1 — `agw image icon`            <!-- status: active -->
Workers: Sonnet. Orchestrated: do NOT spawn Wave 2. Scope: agent-workflows only; dotfiles is busy with track R0.

- [x] Routes for upscale and vectorize in `packages/routes` (Replicate), priced like the other image routes, so runs carry
  cost and usage.
- [x] Image processing: port trim, master, rasters and the `.ico`/`.icns` writers from `image-gateway/gateway/src/lib/`.
  Decide `Bun.Image` vs `sharp` by test: agw uses `Bun.Image` today, and whether it covers trim, compositing and raw RGBA
  is unverified. svgo only cleans vectorize output.
- [x] `agw image-icon`: a workflow with the same outputs as `/icons`, an eval or a golden comparison against the gateway's
  output for one real source image.
- [ ] Correct the README's §Icon, update `AGENTS.md`, deploy, `make verify`, one live run with priced usage.

**Left behind:** stopped: usage limit reached mid-wave. Wave 1 stays `active`.
- Done and committed on master: routes `image.upscale` (0.002/call) and `image.vectorize` (0.01/call); capabilities of the same names on one shared Replicate runner extracted from cutout (`capabilities/src/image/replicate.ts`); workflow `image-icon` (`packages/host/src/workflows/image-icon/`); the image README §Icon corrected, `docs/factory-input.md` updated. `AGENTS.md` lists no image workflows, so it is unchanged.
- **Command is `agw image-icon`, not `agw image icon`:** `assertCommands` (`packages/host/src/app.ts`) refuses a command that prefixes another and `agw image` exists. Wave 3's `imgcli icon` calls `agw image-icon`.
- **Bun.Image vs sharp, decided by test:** Bun.Image has no raw RGBA output, extract, pad or flatten, so the pipeline uses `sharp` 0.35.5 and `svgo` 4.1.0 (the gateway's versions) in `packages/host`.
- **Golden:** `packages/host/test/fixtures/image-icon/` holds the source of the gateway's real `/icons` run of 2026-10-29; every raster, the ICO frames and the ICNS chunks match its output byte for byte.
- Gate: `make check` green except load flakes (review hardening timeouts, `steer and abort`, `credentials ... make check`), each green when rerun alone; `fallow audit` passes with zero introduced findings.
- **Still open:** `/review` on the diff; `make deploy` + `make verify`; one live `agw image-icon` run on a real image showing priced usage (use `~/Pictures/imgcli/icons-20261029-095415/source.png`, vectorize costs 0.01); `docs/concept.md:231` still maps `img` to `agw image`.
- Do not run two `agw check`/`make check` at once: the load causes the timeouts above.

## Wave 2 — The studio on agw            <!-- status: pending -->
Workers: Sonnet. Orchestrated. Needs track R0 closed (dotfiles).

- [ ] A door for the agw host, following the audio door's pattern: a path-restricted tailnet block limited to the image
  capabilities, a per-caller token. Reusing the audio process's token file means the host learns to read it; say why if
  you pick otherwise. Security review on the diff.
- [ ] Inputs as bytes over HTTP, outputs returned to the caller; streaming partials for generate and edit, or a stated
  reason the studio can poll instead.
- [ ] The studio's enhance inputs ported.
- [ ] `image-gateway/app` points at the door, token seeded by `make configure`. The owner's library is untouched.
- [ ] Proof on the MacBook through `ask-human.sh` where a human hand is needed: generate, edit, enhance.

**Left behind:**

## Wave 3 — Retire the gateway            <!-- status: pending -->
Workers: Sonnet, Haiku for the sweep. Orchestrated.

- [ ] `imgcli icon` calls `agw image icon`; `load_gen_config`, `gen_request` and `op://vps/image-gateway` go from `imgcli`.
- [ ] Remove `vps/apps/image-gateway`, its Makefile targets and docs; the Kuma monitor in `homelab/uptime-kuma/monitors.yaml`
  (`make uk-sync`); the RollHook registration; `dotfiles-private/headless.refs` entries; the Caddy local-dev block.
- [ ] Sweep: `hermes-agent/skills/image-delivery`, `hermes-agent/scripts/hermes-ops.sh`, `basalt-ui` consumers (its own
  commit), `dotfiles/docs/architecture.md`, `rules/frontend-routing.md`, `skills/img`, comments in
  `packages/capabilities/src/image/`.
- [ ] `image-gateway` keeps only the studio app: decide the repo's name and shape in Left behind.

**Left behind:**
