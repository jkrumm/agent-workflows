.DEFAULT_GOAL := help
.PHONY: help check fmt deploy verify live-routes install-opencode research-chrome eval-mine-job

help:
	@echo "make check   oxfmt check, oxlint type-aware, tsc, bun test (the merge gate)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  deploy origin/master on the mini: release, LaunchAgents host and audio, the gateway as a third (restarted only when its build changed), health, agw on PATH (DRY_RUN=1 prints the plan)"
	@echo "make install-opencode  install the pinned OpenCode build and react-doctor, link opencode and opencode-safe into ~/.local/bin from the main checkout (never restarts the host)"
	@echo "make research-chrome  install and start the headed Chrome (LaunchAgent, DevTools on loopback) web.fetch reads bot-walled pages with"
	@echo "make eval-mine-job  install the nightly review-ground-truth labelling job (LaunchAgent 04:30, agw eval mine review --auto; sized by the eval credit and the IU line, removes itself at 200 bug cases; not part of make deploy)"
	@echo "make live-routes one real call per route (anthropic, opencode, iu-openai text; ROUTES='a b' narrows), proved by its gateway usage row and run row; costs cents"
	@echo "make verify  prove the deployment: the pinned OpenCode and react-doctor present, the healths at the sha (the gateway at its build), agw smoke ping and audio ping with their journal rows, the door's auth, three real Haiku calls through the gateway with their usage rows"

# docs/spikes/** is excluded from every tool (see .oxfmtrc.json, .oxlintrc.json, tsconfig.json, bunfig.toml).
# Tests need Postgres via AGW_TEST_PG_URL; unset on the mini, it is built from .env.test.tpl through secrets-run, together with
# USAGE_TEST_PG_URL (admin, for the usage schema suite's scratch database; that suite skips visibly without it).
# The test environment therefore holds the admin Postgres credential: CREATE DATABASE needs CREATEDB, which the journal's
# test role (schemas only) lacks, and the suite must never touch the live `shared` database. The suite only ever runs DDL
# on the usage_test_<random> name it generated. Follow-up: a dedicated CREATEDB-only test role, so no admin credential
# reaches the test run.
# The test timeout scales with host load, sampled as each test file starts (bunfig.toml preload, packages/testing); tests that
# pass their own timeout keep it.
check:
	@echo "==> install (bun install --frozen-lockfile)"
	@bun install --frozen-lockfile
	@echo "==> format (oxfmt --check)"
	@bunx --no-install oxfmt --check .
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
	@bunx --no-install oxfmt --write .

# A release (~/.agent-workflows/releases/<sha>, live via `current`) is what runs, never this checkout; scripts/deploy.sh owns the steps.
deploy:
	@DRY_RUN="$(DRY_RUN)" /bin/zsh scripts/deploy.sh

verify:
	@/bin/zsh scripts/verify.sh

# A live call per route through `agw smoke route`, each proved by its usage.records and agw.runs rows (scripts/live-routes.sh).
live-routes:
	@/bin/zsh scripts/live-routes.sh $(ROUTES)

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

# The nightly labelling job of the review ground truth (scripts/eval-mine-daily.sh, packages/eval/README.md §Ground truth
# miner). Not a release artifact and not part of `make deploy`: installed once per machine, it runs the script of whichever
# release `current` points at, and removes itself when the bug-case target is reached. Idempotent: an unchanged, loaded
# agent is left alone; a changed plist is the only reason to boot it out and in again.
eval-mine-job:
	@label="com.jkrumm.agent-workflows-eval-mine"; plist="$$HOME/Library/LaunchAgents/$$label.plist"; tmp="$$plist.tmp.$$$$"; target="gui/$$(id -u)/$$label"; \
		[ -f "$$HOME/.agent-workflows/current/scripts/eval-mine-daily.sh" ] || { echo "eval-mine-job: the live release has no scripts/eval-mine-daily.sh; make deploy first" >&2; exit 1; }; \
		mkdir -p "$$HOME/Library/LaunchAgents" "$$HOME/Library/Logs"; \
		/usr/bin/sed -e "s|__HOME__|$$HOME|g" deploy/$$label.plist.template > "$$tmp" \
			&& plutil -lint "$$tmp" >/dev/null || { rm -f "$$tmp"; echo "eval-mine-job: rendering the plist failed" >&2; exit 1; }; \
		if launchctl print "$$target" >/dev/null 2>&1 && cmp -s "$$tmp" "$$plist"; then \
			rm -f "$$tmp"; echo "eval-mine-job: $$label is installed and unchanged"; exit 0; \
		fi; \
		mv -f "$$tmp" "$$plist"; launchctl bootout "$$target" 2>/dev/null; \
		for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$$target" >/dev/null 2>&1 || break; sleep 1; done; \
		launchctl bootstrap "gui/$$(id -u)" "$$plist" || exit 1; \
		echo "eval-mine-job: $$label installed, runs daily at 04:30; log: ~/Library/Logs/agent-workflows-eval-mine.log"
