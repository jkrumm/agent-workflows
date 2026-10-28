IU_API_KEY=op://common/anthropic/API_KEY
IU_BASE_URL=op://common/anthropic/BASE_URL
# Argo usage ingest (middleware outbox): bearer for POST <ARGO_URL>/usage/records. ARGO_URL is deployment config.
ARGO_API_SECRET=op://common/api/SECRET
# Host (scripts/launch.sh). The API secret is also what `make deploy` writes into the CLI's env file.
AGW_API_SECRET=op://mini/agent-workflows/API_SECRET
ARGO_URL=op://mini/agent-workflows/ARGO_URL
# Span export. The key is a separate var: secrets-run resolves whole-value refs only, launch.sh builds the header.
OTEL_EXPORTER_OTLP_ENDPOINT=op://mini/agent-workflows/OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_AUTHORIZATION=op://vps/argo/HYPERDX_API_KEY_PROD
# Journal database password; launch.sh builds AGW_PG_URL from it (the way `make check` builds AGW_TEST_PG_URL).
AGW_PG_PASSWORD=op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD
# Where the friction job files issues (plain value, not a secret: passes through secrets-run as is).
AGW_FRICTION_REPO=jkrumm/agent-workflows
