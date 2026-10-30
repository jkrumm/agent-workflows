# Test database: the mini's maintained Postgres (role and database agent_workflows). Resolved by secrets-run in `make check`.
AGW_TEST_PG_PASSWORD=op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD
# Admin role of the same Postgres: the usage schema tests (packages/middleware/test/usage-pg.test.ts) create and drop a
# scratch database usage_test_<random>. Without these (or without the usage-tracker checkout) that suite skips visibly.
USAGE_TEST_PG_USER=op://vps/config/POSTGRES_USER
USAGE_TEST_PG_PASSWORD=op://mini/vps-dev/POSTGRES_PASSWORD
