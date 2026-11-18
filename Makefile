.DEFAULT_GOAL := help
.PHONY: help check static static-steps test test-steps usage test-timings fmt deploy verify version live-routes install-opencode research-chrome shop-watch-setup shop-watch-teardown hyperdx-apply hyperdx-export

help:
	@echo "make check   install, mini-registry lint (when the dotfiles checkout is present), then make static and make test (the merge gate; TEST_WORKERS=n sets the workers; the files of .heavy-tests run after, HEAVY_WORKERS=n)"
	@echo "make static  oxfmt check, oxlint type-aware, tsc: one test slot, which the factory may place on its step host"
	@echo "make test    bun test --parallel against Postgres (the mini's, or a private cluster on the step host): one test slot, which the factory may place on its step host"
	@echo "make usage   the suites that need the usage-tracker checkout's migrations (USAGE_TESTS); they run where this target runs, never on the step host"
	@echo "make test-timings  re-record .bun-test-timings.json (how long each test file takes, so the slowest start first); run it on an idle machine and commit the result"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master on the mini: release, LaunchAgents host and audio, the gateway as a third (restarted only when its build changed), health, agw on PATH (DRY_RUN=1 prints the plan)"
	@echo "make install-opencode  install the pinned OpenCode build, link opencode and opencode-safe into ~/.local/bin from the main checkout (never restarts the host)"
	@echo "make research-chrome  install and start the headed Chrome (LaunchAgent, DevTools on loopback) web.fetch reads bot-walled pages with"
	@echo "make shop-watch-setup  install the price watch LaunchAgent (every 6 h, under jobrun) and run it once now; shop-watch-teardown removes it"
	@echo "make live-routes one real call per route (anthropic, opencode, iu-openai text; ROUTES='a b' narrows), proved by its gateway usage row and run row; costs cents"
	@echo "make hyperdx-apply  upsert the HyperDX dashboard agw and its alerts from packages/hyperdx/definitions (ARGS='--dry-run' prints the plan); hyperdx-export writes the live ones back"
	@echo "make version print the deployed commit sha (data/deployed-sha), one line, read-only"
	@echo "make verify  prove the deployment: the pinned OpenCode present, the healths at the sha (the gateway at its build), agw smoke ping and audio ping with their journal rows, the door's auth, three real Haiku calls through the gateway with their usage rows"

# docs/spikes/** is excluded from every tool (see .oxfmtrc.json, .oxlintrc.json, tsconfig.json, bunfig.toml).
# Tests need Postgres via AGW_TEST_PG_URL; unset on the mini, it is built from .env.test.tpl through secrets-run, together with
# USAGE_TEST_PG_URL (admin, for the usage schema suite's scratch database; that suite skips visibly without it).
# The test environment therefore holds the admin Postgres credential: CREATE DATABASE needs CREATEDB, which the journal's
# test role (schemas only) lacks, and the suite must never touch the live `shared` database. The suite only ever runs DDL
# on the usage_test_<random> name it generated. Follow-up: a dedicated CREATEDB-only test role, so no admin credential
# reaches the test run.
# The test timeout scales with host load, sampled as each test file starts (bunfig.toml preload, packages/testing); tests that
# pass their own timeout keep it.
# Before the tests, packages/testing/src/sweep.ts drops test schemas (agw_t_*) older than a day: what a failed or interrupted run left.
# Test files run in TEST_WORKERS parallel processes (bun test --parallel, which implies --isolate; see
# bun.com/docs/test/parallel). Every file brings its own Postgres schema, so files do not collide, but each holds
# connections: a worker per core on a big machine exhausts the server's slots. 4 matches CI and the mini's headroom.
# The timings file (.bun-test-timings.json, refreshed by `make test-timings`) orders the files slowest-first.
TEST_WORKERS ?= 4
# Memory: a parallel worker keeps the high-water mark of the largest file it ran (a finished file's pages are not given back
# to the OS), so the files in .heavy-tests (hundreds of MiB each while they run) run in a second pass with HEAVY_WORKERS
# workers, never next to each other on the four. Both passes together run every test file once.
HEAVY_WORKERS ?= 1
HEAVY_TESTS := $(shell sed -e 's/\#.*//' .heavy-tests)
# The suites that apply the usage-tracker checkout's migrations (a sibling repository only the mini has; they skip visibly without it,
# as on CI). `make usage` runs them on the mini, so the step host's `make test` leaves them out.
USAGE_TESTS := packages/middleware/test/usage-pg.test.ts packages/gateway/test/outbox-pg.test.ts
BUN_TEST_BASE ?= --timings=.bun-test-timings.json
BUN_TEST_FLAGS ?= --parallel=$(TEST_WORKERS) $(BUN_TEST_BASE)
# Both passes always run; the exit code is the worst of the two.
TEST_CMD = rc=0; bun test $(BUN_TEST_FLAGS) $(foreach f,$(HEAVY_TESTS) $(USAGE_TESTS),--path-ignore-patterns=$(f)) || rc=$$?; bun test --parallel=$(HEAVY_WORKERS) $(BUN_TEST_BASE) $(HEAVY_TESTS) || rc=$$?; exit $$rc

# The factory's step host (project.yaml `steps`, docs/architecture.md "Steps off the mini" in software-factory) may run `static` and
# `test` off the mini when the mini's test line would make them wait. Install and the registry lint stay here: the host
# installs on its own, and the registry lint needs the dotfiles checkout only the mini has. Without `factory` (CI) the bare command.
# The step is named after the project, never the worktree directory: the factory learns a step's peak by name.
SLOT_PROJECT = agent-workflows
slot = $(if $(shell command -v factory 2>/dev/null),factory slot run --name "$(SLOT_PROJECT) $(1)" --,)

check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> registry (mini-registry lint: this repo's mini-services.yaml against every other registry; skipped without the dotfiles checkout, as on CI)"
	@[ ! -f "$$HOME/SourceRoot/dotfiles/scripts/mini-registry.ts" ] || bun "$$HOME/SourceRoot/dotfiles/scripts/mini-registry.ts" lint
	@$(MAKE) --no-print-directory static
	@$(MAKE) --no-print-directory test
	@$(MAKE) --no-print-directory usage
	@echo "==> check passed"

# The caller's variables do not reach a step that runs on the step host: only what is spelled out in the command does.
static:
	@$(call slot,static) $(MAKE) --no-print-directory static-steps

static-steps:
	@echo "==> format (oxfmt --check)"
	@bunx --no-install oxfmt --check .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware packages
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit

# scripts/test-env.sh gives the command its Postgres: AGW_TEST_PG_URL as set (CI), else the mini's through secrets-run, else a
# private cluster from PG_BIN_DIR (the step image). TEST_WORKERS and HEAVY_WORKERS are forwarded because the step host does not
# see the caller's make variables; BUN_TEST_BASE is not (`make test-timings` writes a file on this machine, so it stays here).
test:
	@$(call slot,test) sh scripts/test-env.sh $(MAKE) --no-print-directory test-steps TEST_WORKERS=$(TEST_WORKERS) HEAVY_WORKERS=$(HEAVY_WORKERS)

# Home, and no slot: two light files on one worker (a slot would queue it behind a guessed 3.5 GiB first), and the suites need the usage-tracker checkout.
usage:
	@echo "==> usage (the suites that need the usage-tracker checkout's migrations)"
	@sh scripts/test-env.sh bun test --parallel=1 $(USAGE_TESTS)

test-steps:
	@echo "==> test (bun test --parallel=$(TEST_WORKERS), slowest files first, load-scaled timeout per test file; then the files of .heavy-tests with --parallel=$(HEAVY_WORKERS))"
	@for f in $(HEAVY_TESTS); do [ -f "$$f" ] || { echo ".heavy-tests names $$f, which is not a file"; exit 1; }; done
	@bun packages/testing/src/sweep.ts && sh -c '$(TEST_CMD)'

# Re-record how long each test file takes (run on an idle machine, then commit the file; the step stays on the mini, as the file is written here): `bun test --parallel` reads it to
# start the slowest files first. A file with no entry counts as the median, so a stale record only costs speed.
test-timings:
	@FACTORY_SLOT_REMOTE=0 $(MAKE) --no-print-directory check BUN_TEST_BASE="$(BUN_TEST_BASE) --update-timings"

fmt:
	@bunx --no-install oxfmt --write .

# A release (~/.agent-workflows/releases/<sha>, live via `current`) is what runs, never this checkout; scripts/deploy.sh owns the steps.
deploy:
	@DRY_RUN="$(DRY_RUN)" /bin/zsh scripts/deploy.sh

verify:
	@/bin/zsh scripts/verify.sh

# The deployed commit sha, one line, read-only: what `make deploy` last left live (the factory checks a shipped commit against it).
version:
	@tr -d '[:space:]' < "$${AGW_ROOT:-$$HOME/.agent-workflows}/data/deployed-sha"; echo

# The HyperDX dashboard `agw` and its alerts, upserted by name from packages/hyperdx/definitions through the `agw hdx` door
# (the door holds the credentials). ARGS='--dry-run' validates and prints the plan; ARGS='--env local' targets the dev ClickStack.
hyperdx-apply:
	@bun packages/hyperdx/src/cli.ts apply $(ARGS)

# The inverse: write the live dashboard and its agw-tagged alerts back into packages/hyperdx/definitions (capture a UI edit).
hyperdx-export:
	@bun packages/hyperdx/src/cli.ts export $(ARGS)

# A live call per route through `agw smoke route`, each proved by its usage.records and agw.runs rows (scripts/live-routes.sh).
live-routes:
	@/bin/zsh scripts/live-routes.sh $(ROUTES)

# The machine's one OpenCode build (packages/opencode-host/README.md §Pinned build). Run from
# the main checkout: ~/.local/bin/opencode and opencode-safe link to this checkout's scripts, so a linked worktree is
# refused (unless AGW_BIN_DIR redirects the links, a temp prefix for tests). Idempotent; never restarts the host, whose
# OpenCode server picks the new binary up on its next start. Order: the OpenCode build (fatal), then the links.
# AGW_OPENCODE_ROOT and AGW_BIN_DIR (absolute paths) redirect the install and the links; see scripts/pins.sh.
install-opencode:
	@if [ -z "$$AGW_BIN_DIR" ] && [ "$$(git -C "$(CURDIR)" rev-parse --absolute-git-dir)" != "$$(git -C "$(CURDIR)" rev-parse --path-format=absolute --git-common-dir)" ]; then \
		echo "install-opencode: run it from the main checkout, not a linked worktree (the machine-wide links point at this checkout)" >&2; exit 1; fi
	@scripts/pins.sh root bin >/dev/null
	@scripts/install-opencode-bin.sh
	@bin="$$(scripts/pins.sh root bin)"; mkdir -p "$$bin"; \
		ln -sfn "$(CURDIR)/scripts/opencode" "$$bin/opencode"; \
		ln -sfn "$(CURDIR)/scripts/opencode-safe" "$$bin/opencode-safe"; \
		echo "linked $$bin/opencode and $$bin/opencode-safe -> $(CURDIR)/scripts"

# The headed Chrome behind web.fetch's browser fallback (AGW_BROWSER_CDP_URL in .env.tpl). Not a release artifact: the
# profile and its cookies live in ~/.local/share/research-chrome, so it is installed once per machine. Idempotent; a
# Chrome already running on that profile keeps running: the agent is a supervisor loop that waits while 9222 answers and
# starts Chrome when it stops. An unchanged, loaded agent is left alone; a changed plist is the only reason to boot it
# out and in again.
research-chrome:
	@plist="$$HOME/Library/LaunchAgents/com.jkrumm.research-chrome.plist"; tmp="$$plist.tmp.$$$$"; target="gui/$$(id -u)/com.jkrumm.research-chrome"; \
		probe() { curl -fs -m 2 http://127.0.0.1:9222/json/version >/dev/null; }; \
		mkdir -p "$$HOME/Library/LaunchAgents" "$$HOME/.local/share/research-chrome"; \
		/usr/bin/sed -e "s|__HOME__|$$HOME|g" deploy/com.jkrumm.research-chrome.plist.template > "$$tmp" \
			&& plutil -lint "$$tmp" >/dev/null || { rm -f "$$tmp"; echo "research-chrome: rendering the plist failed" >&2; exit 1; }; \
		if launchctl print "$$target" >/dev/null 2>&1 && cmp -s "$$tmp" "$$plist"; then \
			rm -f "$$tmp"; probe || launchctl kickstart "$$target"; \
		else \
			mv -f "$$tmp" "$$plist"; launchctl bootout "$$target" 2>/dev/null; \
			for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$$target" >/dev/null 2>&1 || break; sleep 1; done; \
			launchctl bootstrap "gui/$$(id -u)" "$$plist" || exit 1; \
		fi; \
		for i in 1 2 3 4 5 6 7 8 9 10; do probe && { echo "research-chrome: DevTools answers on 127.0.0.1:9222"; exit 0; }; sleep 1; done; \
		echo "research-chrome: loaded, but DevTools does not answer on 127.0.0.1:9222" >&2; exit 1

# The price watch (docs/shop.md §Watch): `agw shop watch` every six hours under jobrun. Not a release artifact: it only asks
# the deployed host, so it is installed once per machine from this checkout's template. Idempotent. The first run happens
# here, where someone is present, so a missing or invalid ~/.agent-workflows/data/shop/watch.json fails now and not at 3 a.m.
SHOP_WATCH_LABEL := com.jkrumm.agent-workflows-shop-watch
shop-watch-setup:
	@plist="$$HOME/Library/LaunchAgents/$(SHOP_WATCH_LABEL).plist"; tmp="$$plist.tmp.$$$$"; target="gui/$$(id -u)/$(SHOP_WATCH_LABEL)"; \
		mkdir -p "$$HOME/Library/LaunchAgents" "$$HOME/Library/Logs"; \
		/usr/bin/sed -e "s|__HOME__|$$HOME|g" deploy/$(SHOP_WATCH_LABEL).plist.template > "$$tmp" \
			&& plutil -lint "$$tmp" >/dev/null || { rm -f "$$tmp"; echo "shop-watch: rendering the plist failed" >&2; exit 1; }; \
		if launchctl print "$$target" >/dev/null 2>&1 && cmp -s "$$tmp" "$$plist"; then rm -f "$$tmp"; \
		else \
			mv -f "$$tmp" "$$plist"; launchctl bootout "$$target" 2>/dev/null; \
			for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$$target" >/dev/null 2>&1 || break; sleep 1; done; \
			launchctl bootstrap "gui/$$(id -u)" "$$plist" || exit 1; \
		fi; \
		echo "shop-watch: loaded $(SHOP_WATCH_LABEL); first run:"; \
		AGW_CALLER=shop-watch "$$HOME/.local/bin/jobrun" $(SHOP_WATCH_LABEL) --owner agent-workflows --every 21600 --timeout 1800 -- "$$HOME/.local/bin/agw" shop watch --commit

shop-watch-teardown:
	@launchctl bootout "gui/$$(id -u)/$(SHOP_WATCH_LABEL)" 2>/dev/null; rm -f "$$HOME/Library/LaunchAgents/$(SHOP_WATCH_LABEL).plist" "$$HOME/.local/state/jobs/$(SHOP_WATCH_LABEL).json"; echo "shop-watch: removed $(SHOP_WATCH_LABEL)"
