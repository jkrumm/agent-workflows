.DEFAULT_GOAL := help
.PHONY: help check fmt deploy verify install-opencode

help:
	@echo "make check   format, lint, oxlint type-aware, tsc, bun test (the merge gate)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master on the mini: release, both LaunchAgents (host, audio), health, agw on PATH (DRY_RUN=1 prints the plan)"
	@echo "make install-opencode  install the pinned OpenCode build and react-doctor, link opencode and opencode-safe into ~/.local/bin from this checkout (never restarts the host)"
	@echo "make verify  prove the deployment: both healths at the sha, agw smoke ping and audio ping with their journal rows, the door's auth"

# docs/spikes/** is excluded from every tool (see biome.json, .oxlintrc.json, tsconfig.json, bunfig.toml).
# Tests need Postgres via AGW_TEST_PG_URL; unset on the mini, it is built from .env.test.tpl through secrets-run.
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
			'AGW_TEST_PG_URL="postgres://agent_workflows:$$(bun -e "process.stdout.write(encodeURIComponent(process.env.AGW_TEST_PG_PASSWORD))")@127.0.0.1:5432/agent_workflows" exec bun test --isolate'; \
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
# the dev checkout: ~/.local/bin/opencode and opencode-safe link to this checkout's scripts. Idempotent; never restarts the
# host, whose OpenCode server picks the new binary up on its next start. AGW_OPENCODE_ROOT, AGW_REACT_DOCTOR_ROOT and
# AGW_BIN_DIR redirect the installs and the links (a temp prefix for tests).
install-opencode:
	@scripts/install-opencode-bin.sh
	@scripts/install-react-doctor.sh
	@bin="$${AGW_BIN_DIR:-$$HOME/.local/bin}"; mkdir -p "$$bin"; \
		ln -sfn "$(CURDIR)/scripts/opencode" "$$bin/opencode"; \
		ln -sfn "$(CURDIR)/scripts/opencode-safe" "$$bin/opencode-safe"; \
		echo "linked $$bin/opencode and $$bin/opencode-safe -> $(CURDIR)/scripts"
