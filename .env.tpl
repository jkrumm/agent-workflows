IU_API_KEY=op://common/anthropic/API_KEY
IU_BASE_URL=op://common/anthropic/BASE_URL
# Direct Anthropic API key for claude models on the opencode wire (not required while no opencode route uses one).
ANTHROPIC_API_KEY=op://common/claude-platform/API_KEY_IU
# web.* capabilities: Tavily search fallback and Extract (shared common item), Context7 docs (this platform's own item).
TAVILY_API_KEY=op://common/tavily/API_KEY
CONTEXT7_API_KEY=op://mini/agent-workflows/CONTEXT7_API_KEY
# hdx.* capabilities (HyperDX/ClickStack HTTP API), prod: the agent access key and the domain the capability builds
# https://hyperdx.<domain> from. Local needs no ref: its key is read from ~/.config/hyperdx/local.env at call time.
HYPERDX_PROD_ACCESS_KEY=op://vps/clickstack/AGENT_ACCESS_KEY
HYPERDX_DOMAIN=op://vps/config/DOMAIN
# Argo bearer (the agents overview push, the podcast's Slack notice). ARGO_URL is deployment config.
ARGO_API_SECRET=op://common/api/SECRET
# Host (scripts/launch.sh). The API secret is also what `make deploy` writes into the CLI's env file.
AGW_API_SECRET=op://mini/agent-workflows/API_SECRET
ARGO_URL=op://mini/agent-workflows/ARGO_URL
# Span export. The key is a separate var: secrets-run resolves whole-value refs only, launch.sh builds the header.
OTEL_EXPORTER_OTLP_ENDPOINT=op://mini/agent-workflows/OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_AUTHORIZATION=op://vps/argo/HYPERDX_API_KEY_PROD
# Journal database password; launch.sh builds AGW_PG_URL from it (the way `make check` builds AGW_TEST_PG_URL).
AGW_PG_PASSWORD=op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD
# Usage database (schema `usage` in `shared`, role `usage`): the middleware outbox writes usage rows there. launch.sh builds
# USAGE_PG_URL from the password, the same way.
USAGE_PG_PASSWORD=op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD
# web.fetch's browser fallback: the loopback DevTools endpoint of the headed research Chrome (`make research-chrome`). Plain
# value, not a secret. Unset, the fallback is off.
AGW_BROWSER_CDP_URL=http://127.0.0.1:9222
# Where the friction job files issues (plain value, not a secret: passes through secrets-run as is).
AGW_FRICTION_REPO=jkrumm/agent-workflows
# Audio process (packages/audio): the STT language steer the door's transcriptions send when a client sets none (plain
# value, as audio-gateway sets it). Its IU lanes derive the OpenAI, Gemini and Replicate bases from IU_BASE_URL.
STT_PROMPT=Die Aufnahme ist auf Deutsch oder Englisch.
# The podcast's Slack notice goes to this channel via Argo (ARGO_URL, ARGO_API_SECRET above); a constant, as audio-gateway's
# mini instance set it. Unset = no notice.
PODCAST_NOTIFY_CHANNEL=media
# Audiobookshelf, where the podcast's publish stage uploads an episode (audio process).
ABS_URL=op://vps/audiobookshelf/URL
ABS_API_KEY=op://vps/audiobookshelf/API_KEY
