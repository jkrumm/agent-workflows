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

## Wave 1 — `agw image icon`            <!-- status: done -->
Workers: Sonnet. Orchestrated: do NOT spawn Wave 2. Scope: agent-workflows only; dotfiles is busy with track R0.

- [x] Routes for upscale and vectorize in `packages/routes` (Replicate), priced like the other image routes, so runs carry
  cost and usage.
- [x] Image processing: port trim, master, rasters and the `.ico`/`.icns` writers from `image-gateway/gateway/src/lib/`.
  Decide `Bun.Image` vs `sharp` by test: agw uses `Bun.Image` today, and whether it covers trim, compositing and raw RGBA
  is unverified. svgo only cleans vectorize output.
- [x] `agw image-icon`: a workflow with the same outputs as `/icons`, an eval or a golden comparison against the gateway's
  output for one real source image.
- [x] Correct the README's §Icon, update `AGENTS.md`, deploy, `make verify`, one live run with priced usage.

**Left behind:** (commits c70c93f, b4aa599, 02dc887 on master, deployed as `02dc887`, `make verify` PASS)
- **Built:** routes `image.upscale` (0.002/call) and `image.vectorize` (0.01/call); capabilities of the same names on one shared Replicate runner (`packages/capabilities/src/image/replicate.ts`, cutout now uses it); workflow `image-icon` in `packages/host/src/workflows/image-icon/` (steps prepare, upscale, cutout, render, vectorize, assembly; intermediates in `<run dir>/work/`). Image README §Icon corrected, `docs/concept.md` and `docs/factory-input.md` name it. `AGENTS.md` lists no image workflows, so it is unchanged.
- **The command is `agw image-icon`, not `agw image icon`:** `assertCommands` (`packages/host/src/app.ts`) refuses a command that prefixes another, and `agw image` exists. Wave 3's `imgcli icon` must call `agw image-icon`; its flags are `--background`, `--cutout`, `--cutout-model`, `--upscale`, `--svg`, the output lists `files` with absolute paths in the artifact store (30-day retention), `html`, `manifest`, `steps`, `cost`.
- **sharp, not Bun.Image, decided by test:** Bun.Image (1.4) has no raw RGBA output, extract, pad or flatten. `sharp` 0.35.5 and `svgo` 4.1.0 (the gateway's versions) are dependencies of `packages/host`; no `trustedDependencies` needed; the deploy installed them.
- **Proof:** golden test against the gateway's real `/icons` run of 2026-10-29 (`packages/host/test/fixtures/image-icon/`), byte-identical. The live run on that same source (run 01a18cab-460e-7000-89ce-4f2a2fefe191, `agw image-icon`) produced all 10 files **byte-identical to the gateway's** (favicon.ico/.svg, icon-192/512/mask/1024, apple-touch-icon, AppIcon.icns, head.html, manifest.webmanifest); the run record carries `cost 0.01` (vectorize, recraft-vectorize, 6.5 s), `unpricedCalls 0`. The upscale and cutout paths are covered by the fake-server tests only (the source was transparent and 1024²); no live run of them.
- **Gate:** `make check` green on the committed change (2947 tests, run in an isolated worktree because the main checkout carried another agent's uncommitted work), `fallow audit` zero introduced findings, `/review` (`agw review`) run on c70c93f~1..b4aa599: 2 blocking fixed (cutout 256 px minimum checked before the paid upscale; master side cap 8192), plus decode pixel limit (64 MP), SVG active-content stripping (svgo `removeScripts` + guard), 180 s poll deadline for upscale, each with a test.
- **Review items deliberately not changed:** (1) a 2xx create answer that fails to parse leaves a possibly billed prediction off the run's ledger: this is the documented no-resend design (image README, "a garbled 200 is an error") moved from cutout unchanged; revisit only if it shows up in the ledger. (2) Limits duplicated between `pipeline.ts`/`schema.ts` and the capabilities (`CUTOUT_LIMITS`, `UPSCALE_MAX_INPUT_EDGE`, PNG magic, `UpscaleMode`): drift risk, no defect today; fold into one export when a wave next touches them.
- **Something seems wrong, flagged not fixed:** the main checkout of agent-workflows carried uncommitted work that is not Wave 1's (a usage-schema change: `packages/middleware/src/argo.ts` → `usage.ts` renamed and staged, edits in `audio/src/process/door.ts`, `host/src/boot.ts`, `capability-runs.ts`, `.env.tpl`, `Makefile`, `AGENTS.md`, `docs/concept.md` v3.11, several tests), apparently from a session of the argo track working in this checkout. Wave 1 committed only its own paths via a temporary index and did not touch or stage theirs. The deploy built `origin/master`, so that work is not live; its owner must commit and `make deploy` it. A Wave 2 worker must check `git status` first and not commit those paths.
- Do not run two `make check` / `agw check` at once: load timeouts in the review and opencode tests.

## Wave 2 — The studio on agw            <!-- status: active -->
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
