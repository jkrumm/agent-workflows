# The inference gateway (scripts/launch-gateway.sh, packages/gateway): only what it needs. The refs are the same as
# .env.tpl's, so every one is already in the mini's secrets cache; add none here that .env.tpl does not hold.
# The personal IU key (IU_KEY_ID=personal is set by the launcher). The Athena team key never reaches this process.
IU_API_KEY=op://common/anthropic/API_KEY
IU_BASE_URL=op://common/anthropic/BASE_URL
# The door's API secret (callers present it as a bearer or x-api-key).
AGW_API_SECRET=op://mini/agent-workflows/API_SECRET
# Usage database (schema `usage`, role `usage`): launch-gateway.sh builds USAGE_PG_URL from the password.
USAGE_PG_PASSWORD=op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD
# Span export; the key is a separate var because secrets-run resolves whole-value refs only.
OTEL_EXPORTER_OTLP_ENDPOINT=op://mini/agent-workflows/OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_AUTHORIZATION=op://vps/argo/HYPERDX_API_KEY_PROD
