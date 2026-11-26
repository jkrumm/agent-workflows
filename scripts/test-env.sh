#!/bin/sh
# usage: scripts/test-env.sh <command...>
# Runs the command with the tests' Postgres in its environment (AGW_TEST_PG_URL, USAGE_TEST_PG_URL):
#   1. AGW_TEST_PG_URL already set (CI's service container, a developer's own database): the command runs as it is.
#   2. Otherwise a private cluster from the server binaries in PG_BIN_DIR (set in the step image on the factory's step host;
#      default Homebrew's postgresql@18, the mini), in a temp directory on a free loopback port, trust auth, stopped and
#      removed when the command ends. The superuser is the test role and the admin one at once, so the usage schema suite's
#      scratch database works there too. Never the mini's maintained Postgres: its test role's connection limit was shared
#      with the live processes, and a run next to a busy host failed one random test with "too many connections for role".
# POSIX sh: the step image's /bin/sh is dash. Its exit code is the command's.
set -u

if [ -n "${AGW_TEST_PG_URL:-}" ]; then exec "$@"; fi

bin="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@18/bin}"
if [ ! -x "$bin/initdb" ]; then
  echo "test-env: AGW_TEST_PG_URL is unset and $bin has no initdb (PG_BIN_DIR): no Postgres for the tests" >&2
  exit 1
fi

root="${TMPDIR:-/tmp}"
root="${root%/}"
# A run killed with SIGKILL never reaches its trap and leaves its server running: stop and remove every cluster whose
# owning shell is gone. The server is signalled only when the pid it recorded still runs on that data directory.
for old in "$root"/agw-test-pg.*; do
  owner="$(cat "$old/owner" 2>/dev/null)" || continue
  kill -0 "$owner" 2>/dev/null && continue
  server="$(head -n 1 "$old/data/postmaster.pid" 2>/dev/null)"
  case "$(ps -ww -o command= -p "${server:-0}" 2>/dev/null)" in
    *"$old/data"*) "$bin/pg_ctl" -D "$old/data" -m immediate stop >/dev/null 2>&1 ;;
  esac
  rm -rf "$old"
done

dir="$(mktemp -d "$root/agw-test-pg.XXXXXX")" || exit 1
echo "$$" >"$dir/owner"
stop() {
  "$bin/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1
  rm -rf "$dir"
}
trap stop EXIT
trap 'exit 143' HUP INT TERM

fail() {
  echo "test-env: $1" >&2
  cat "$dir/pg.log" >&2 2>/dev/null
  exit 1
}

# C.UTF-8 as the step image has no other locale, whatever LANG the caller's shell passed in.
"$bin/initdb" -D "$dir/data" -U agent_workflows --auth=trust --no-sync --encoding=UTF8 --locale=C.UTF-8 >"$dir/pg.log" 2>&1 \
  || fail "initdb failed"
port="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true)')" \
  || fail "no free port"
# Throwaway data: nothing is worth a disk flush. 200 connections: the parallel workers hold a few pools each. TCP only: a
# socket path under macOS's TMPDIR can pass the 103-byte limit. LC_ALL: macOS's server refuses to start without a valid one.
LC_ALL=C.UTF-8 "$bin/pg_ctl" -D "$dir/data" -l "$dir/pg.log" -w -s \
  -o "-c listen_addresses=127.0.0.1 -p $port -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
  start || fail "pg_ctl start failed"
"$bin/createdb" -h 127.0.0.1 -p "$port" -U agent_workflows agent_workflows || fail "createdb failed"

AGW_TEST_PG_URL="postgres://agent_workflows@127.0.0.1:$port/agent_workflows"
USAGE_TEST_PG_URL="postgres://agent_workflows@127.0.0.1:$port/postgres"
export AGW_TEST_PG_URL USAGE_TEST_PG_URL
"$@"
exit $?
