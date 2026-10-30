.DEFAULT_GOAL := help
.PHONY: help check fmt deploy verify install-opencode

help:
	@echo "make check   format, lint, oxlint type-aware, tsc, bun test (the merge gate)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master on the mini: release, both LaunchAgents (host, audio), health, agw on PATH (DRY_RUN=1 prints the plan)"
	@echo "make install-opencode  install the pinned OpenCode build and react-doctor, link opencode and opencode-safe into ~/.local/bin from the main checkout (never restarts the host)"
	@echo "make verify  prove the deployment: the pinned OpenCode and react-doctor present, both healths at the sha, agw smoke ping and audio ping with their journal rows, the door's auth"

# docs/spikes/** is excluded from every tool (see biome.json, .oxlintrc.json, tsconfig.json, bunfig.toml).
# Tests need Postgres via AGW_TEST_PG_URL; unset on the mini, it is built from .env.test.tpl through secrets-run, together with
# USAGE_TEST_PG_URL (admin, for the usage schema suite's scratch database; that suite skips visibly without it).
# The test timeout scales with host load, sampled as each test file starts (bunfig.toml preload, packages/testing); tests that
# pass their own timeout keep it.
check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> format (biome format)"
	@bunx --no-install biome format .
	@echo "==> lint (biome lint)"
	@bunx --no-install biome lint .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware packages
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit
	@echo "==> test (bun test --isolate, load-scaled timeout per test file)"
	@if [ -n "$$AGW_TEST_PG_URL" ] || ! command -v secrets-run >/dev/null 2>&1; then \
		bun test --isolate; \
	else \
		secrets-run run --env-file=.env.test.tpl -- sh -c \
			'AGW_TEST_PG_URL="postgres://agent_workflows:$$(bun -e "process.stdout.write(encodeURIComponent(process.env.AGW_TEST_PG_PASSWORD))")@127.0.0.1:5432/agent_workflows"; \
			USAGE_TEST_PG_URL="postgres://$$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_USER))"):$$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_PASSWORD))")@127.0.0.1:5432/postgres"; \
			export AGW_TEST_PG_URL USAGE_TEST_PG_URL; exec bun test --isolate'; \
	fi
	@echo "==> check passed"

fmt:
	@bunx --no-install biome format --write .

# A release (~/.agent-workflows/releases/<sha>, live via `current`) is what runs, never this checkout; scripts/deploy.sh owns the steps.
deploy:
	@DRY_RUN="$(DRY_RUN)" /bin/zsh scripts/deploy.sh

verify:
	@/bin/zsh scripts/verify.sh

# The machine's one OpenCode build and the pinned react-doctor (packages/opencode-host/README.md §Pinned build). Run from
# the main checkout: ~/.local/bin/opencode and opencode-safe link to this checkout's scripts, so a linked worktree is
# refused (unless AGW_BIN_DIR redirects the links, a temp prefix for tests). Idempotent; never restarts the host, whose
# OpenCode server picks the new binary up on its next start. Order: the OpenCode build (fatal), the links, then
# react-doctor (a failure only warns: review runs report it as not run, `make verify` names it). AGW_OPENCODE_ROOT,
# AGW_REACT_DOCTOR_ROOT and AGW_BIN_DIR (absolute paths) redirect the installs and the links; see scripts/pins.sh.
install-opencode:
	@if [ -z "$$AGW_BIN_DIR" ] && [ "$$(git -C "$(CURDIR)" rev-parse --absolute-git-dir)" != "$$(git -C "$(CURDIR)" rev-parse --path-format=absolute --git-common-dir)" ]; then \
		echo "install-opencode: run it from the main checkout, not a linked worktree (the machine-wide links point at this checkout)" >&2; exit 1; fi
	@scripts/pins.sh root bin >/dev/null
	@scripts/install-opencode-bin.sh
	@bin="$$(scripts/pins.sh root bin)"; mkdir -p "$$bin"; \
		ln -sfn "$(CURDIR)/scripts/opencode" "$$bin/opencode"; \
		ln -sfn "$(CURDIR)/scripts/opencode-safe" "$$bin/opencode-safe"; \
		echo "linked $$bin/opencode and $$bin/opencode-safe -> $(CURDIR)/scripts"
	@scripts/install-react-doctor.sh || echo "warning: react-doctor install failed; review runs report it as not run (rerun make install-opencode)" >&2
