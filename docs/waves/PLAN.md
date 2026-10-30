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

## Wave 2 — The studio on agw            <!-- status: done -->
Workers: Sonnet. Orchestrated. Needs track R0 closed (dotfiles).

- [x] A door for the agw host, following the audio door's pattern: a path-restricted tailnet block limited to the image
  capabilities, a per-caller token. Reusing the audio process's token file means the host learns to read it; say why if
  you pick otherwise. Security review on the diff.
- [x] Inputs as bytes over HTTP, outputs returned to the caller; streaming partials for generate and edit, or a stated
  reason the studio can poll instead.
- [x] The studio's enhance inputs ported.
- [x] `image-gateway/app` points at the door, token seeded by `make configure`. The owner's library is untouched.
- [x] Proof at the door: generate (SSE), edit, enhance through the live door, validated by the studio's own zod schemas.
- [x] Proof in the app: generate, edit, enhance clicked in ImageGen on the MacBook. Moved to Wave 3's gate (a human hand; asked 2026-10-30, request `20261030T163835-8260`).

**Left behind:** (agent-workflows `eeadccc..3b232fb` on master, deployed as `3b232fb`, `make verify` PASS; dotfiles `5dcbe3b`; image-gateway `b6ffb95`, pushed)
- **Built:** `requestImages` (`packages/capabilities/src/image/studio.ts`), the one bytes-level generate/edit/stream call; `image.generate` runs on it. `image.enhance` takes `currentPrompt`/`delta`/`styleGuide`/`seriesContext`/`preserveList`/`overrides` and returns moderation, partialImages. The door is `packages/host/src/image-door/`, mounted on the host through `hostProcess(...).routes`: `POST /door/image/{generate,edit,enhance}`, the studio's snake_case wire (JSON, multipart, SSE `partial_image`/`completed`/`error`), mirrored in `contract.ts` and pinned by a contract test. Each valid request is one internal run `door.image.<endpoint>` with cost, usage and the caller's name; `agw-run-id` goes back in the header. Limits: JSON 2 MiB, multipart 100 MiB, 5-minute upload deadline, 4 requests in flight (5th is 503), 30-minute stream ceiling.
- **Auth decision:** the host reads the audio door's file (`~/.agent-workflows/data/door-tokens`, now parsed by `packages/host/src/door-tokens.ts`; audio re-exports): one file, one parser, one rotation procedure. `make deploy` appended a `studio` line (existing lines untouched). The platform secret is accepted as `agw` like on the audio door. A door token never opens the API (tested). The host now refuses to start without a valid token file (same as audio; deploy pre-checks it).
- **Door in front:** dotfiles `config/Caddyfile` block `agw-image.test` -> `localhost:7791`, only `/door/image/*` (everything else 404), carried into the tailnet door; `make caddy-tailnet` was run on the mini. The studio's base URL is `https://agw-image.<dev-domain>/door/image`; `make configure` in image-gateway reads the dev domain and the `studio` token from the mini over ssh and merges them into `settings.json` (nothing else in the library is touched). It was run on the MacBook through `ask-human.sh`: reachable from there (401 without a token, 400 with it).
- **Proof:** live runs through the door on the mini (`door.image.enhance` 0.00068 USD, `door.image.generate` streaming with one partial 0.0083 USD, `door.image.edit` 0.0142 USD, all `done` with cost on the run); the studio's `generateResponseSchema`, `editResponseSchema`, `streamEventSchema` and `planResponseSchema` parse the answers, and an enhance with delta, style guide, series context, preserve list and overrides is honored. `scripts/verify.sh` now checks the image door (401, studio 400 envelope).
- **Not done, needs a human hand:** the click-through in the ImageGen app (restart it, one generate, one edit, one enhance). **Wave 3 stops the gateway only after that.** The app also still shows the old wording until `make app` rebuilds it; functionally it only needs the seeded settings.
- **Gate:** `make check` green (3095 pass) on the rebased tree; `/review --deep`: `agw review` (3 blocking: gone-client during upload, enhance auto-mode iteration, README strictness claim; plus streams, memory, error leakage), native `code-review` and a security pass (none); all fixed in `a662f87`, `7879f41`, `28a9618` with tests. Deliberately not changed: the token file stays a fail-closed start precondition (same as audio), the platform secret stays accepted on the door (Caddy path block is the control), the `ruleError`/`INTENTS`/`studioModel` duplication between door and capabilities (drift risk, no defect).
- **Deviations from the studio's wire (in `packages/host/README.md` §Image door):** the 401 uses the JSON envelope, generate schema failures are 400 (studio: 422), a failure before the first byte of a stream is a JSON error instead of a 200 with an error frame, an unpriced plan reports `estimated_cost` 0, the final SSE error frame carries `code`/`moderation_details`. Request schemas ignore unknown keys like the studio's. The wire is mirrored, not shared: the studio's `shared/` stays the source until Wave 3 decides the repo's shape.
- **Flagged, not mine:** the dotfiles commit `5dcbe3b` also carries another session's hooks change (a concurrent commit swept in the Caddy edits); it is pushed, no history rewrite. `docs/architecture.md` says 23 dev-app doors while the registry prints 34 (pre-existing).

## Wave 3 — Retire the gateway            <!-- status: done -->
Workers: Sonnet, Haiku for the sweep. Orchestrated.

**Gate before the second step:** the owner's ImageGen click-through (Wave 2's open item, `ask-human.sh status 20261030T163835-8260`) is answered `done`. Still pending: `ask-human.sh push 20261030T163835-8260` once; unanswered after that, finish the first step, write "stopped: click-through pending" into Left behind and close out. Denied: stop and report what failed.

- [x] `imgcli icon` calls `agw image-icon` (the command is hyphenated, see Wave 1); `load_gen_config`, `gen_request` and `op://vps/image-gateway` go from `imgcli`.
- [x] Remove `vps/apps/image-gateway`, its Makefile targets and docs; the Kuma monitor in `homelab/uptime-kuma/monitors.yaml`
  (`make uk-sync`); the RollHook registration; `dotfiles-private/headless.refs` entries; the Caddy local-dev block.
- [x] Sweep: `hermes-agent/skills/image-delivery`, `hermes-agent/scripts/hermes-ops.sh`, `basalt-ui` consumers (its own
  commit), `dotfiles/docs/architecture.md`, `rules/frontend-routing.md`, `skills/img`, comments in
  `packages/capabilities/src/image/`.
- [x] `image-gateway` keeps only the studio app: decide the repo's name and shape in Left behind.

**Left behind:** (dotfiles `64e9553`, `5fcc819`; vps `725403e`; homelab `545193d`; dotfiles-private `93e66f1`; hermes-agent `46c5a20`; image-gateway `2c64d9a`; all on master, pushed)
- **Gate waived by the owner, not passed:** the ImageGen click-through (`20261030T163835-8260`) was pushed once and stayed unanswered; the owner then said in chat they do not use the studio and would rather work through the agw image CLI. The gateway was stopped on that. The studio's door path was proven at the door in Wave 2 only, never clicked in the app; the request stays pending in the human queue and can be closed.
- **Step 1:** `imgcli icon` runs `agw image-icon` (generic `agw_run`, `agw_image` wraps it); `load_gen_config`, `gen_request`, `REF_GEN_ITEM` and all `op://vps/image-gateway` lines are gone from `imgcli` and `skills/img/SKILL.md`. Live proof: `imgcli icon --from <golden source.png>` produced the 10-file set for $0.0100.
- **Step 2, live:** the VPS container `image-gateway-image-gateway-7` stopped and removed, both of its images removed, `apps/image-gateway/.env` removed; the grey-cloud A record `image-gateway.<domain>` deleted through the Cloudflare API; the Kuma monitor `Image Gen Gateway - HTTP` removed from `monitors.yaml` and deleted in Kuma (`make uk-sync` with `--delete-orphans`, the only orphan). Repo side: vps `apps/image-gateway/`, its Makefile targets (`-up/-down/-env/-redeploy/-bootstrap-image/-cutover`), `KNOWN_APPS`/`APP_SERVICE`, README, AGENTS.md and observability rows, audit skill list; dotfiles-private `headless.refs` image-gateway block; dotfiles Caddyfile `image-gateway.test` block. RollHook has no separate registration: it was label-driven from the compose file and the repo's `deploy.yml`, both deleted, so the old `rollhook.<domain>/image-gateway` image tags are gone from the VPS.
- **Step 3, sweep:** hermes-agent (`image-delivery` skill now says `agw image` on the mini; `hermes-ops.sh` stack lists and comments; `homelab-ops` skill and rollhook-deploys reference; `tests/test_hermes_ops.py` 95/95), dotfiles `docs/architecture.md` and the img skill description. **basalt-ui and `rules/frontend-routing.md` unchanged on purpose:** the studio stays, so `consumers.json` and the "image-gateway" consumer entry are still correct.
- **Step 4, repo decision:** `image-gateway` keeps its name and becomes the ImageGen studio only (name now historical, stated in its README). A rename would churn basalt-ui `consumers.json`, herdr `groups.json`, local paths and `AGENTS.md` pointers for an app the owner rarely opens; do it if the studio is revived. Removed: `gateway/`, `deploy.yml`, `.dockerignore`, `shared/src/assets.ts` (cutout/icon schemas nothing imported), the gateway Makefile targets (`up` is now `make app`), `dev` runs the app only. `bun run pre` and `bun test` green (305 pass); the Tauri/Rust build was not run. The wire mirror in agw (`packages/host/src/image-door/contract.ts`) still names the studio's `shared/` as its source and that source is unchanged.
- **Not done / flagged:** (1) the mini's live Caddy still carries the stale dev door `image-gateway.test` -> :7716 (harmless 502): the main dotfiles checkout on the mini carries another agent's uncommitted work incl. `docs/architecture.md`, so a `git pull` there would conflict; `make caddy-tailnet` after that agent commits. (2) The 1Password item `op://vps/image-gateway` still exists (read-only service account cannot delete it); delete by hand when convenient. (3) hermes-agent's live checkout and `~/.hermes` pick up the skill edit on their next sync, not forced. (4) `image-gateway/docs/concept.md` and `PRD.md` line 63 still describe the gateway as live; `email-gateway/.env.tpl` has a comment naming image-gateway. (5) Provenance comments in `packages/capabilities/src/image/` and the image READMEs ("image-gateway's retry set", "ported from") are accurate history and were left. (6) vps `.claude/skills/audit` was edited; the vps main checkout carries another agent's uncommitted `apps/email-gateway` and `apps/image-gateway/.env.tpl` edits, which are now moot once it pulls (the file is deleted on master; expect a modify/delete conflict to resolve by deleting).
- **Gate:** no agent-workflows code changed this wave; per-repo checks: `bash -n` + live `imgcli icon` run (dotfiles), `make check` (vps, compose + shell syntax), `uk-dry-run` listing only the intended orphan (homelab), `test_hermes_ops.py` (hermes-agent), `bun run pre` + `bun test` (image-gateway). `/review` not run: shell/docs/removal only, the one code-bearing change (imgcli) was proven by a live run. All work was done in per-repo worktrees off fetched origin, because every checkout touched carried another agent's uncommitted changes.
