.DEFAULT_GOAL := help
.PHONY: help check fmt deploy verify

help:
	@echo "make check   format, lint, oxlint type-aware, tsc, bun test (the merge gate)"
	@echo "make fmt     apply formatting"
	@echo "make deploy  skeleton, nothing deployable yet"
	@echo "make verify  skeleton, nothing deployable yet"

# docs/spikes/** is excluded from every tool (see biome.json, .oxlintrc.json, tsconfig.json, bunfig.toml).
check:
	@echo "==> format (biome format)"
	@bunx --no-install biome format .
	@echo "==> lint (biome lint)"
	@bunx --no-install biome lint .
	@echo "==> lint (oxlint --type-aware)"
	@bunx --no-install oxlint -c .oxlintrc.json --type-aware packages
	@echo "==> typecheck (tsc --noEmit)"
	@bunx --no-install tsc --noEmit
	@echo "==> test (bun test --isolate)"
	@bun test --isolate
	@echo "==> check passed"

fmt:
	@bunx --no-install biome format --write .

deploy:
	@echo "deploy: nothing is deployable yet; Wave 3 fills this in."

verify:
	@echo "verify: nothing is deployable yet; Wave 3 fills this in."
