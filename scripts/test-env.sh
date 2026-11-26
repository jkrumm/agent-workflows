#!/bin/sh
# usage: scripts/test-env.sh <command...>
# Runs the command with the tests' Postgres in its environment (AGW_TEST_PG_URL, USAGE_TEST_PG_URL), from the first of:
#   1. AGW_TEST_PG_URL already set (CI's service container, a developer's own database): the command runs as it is.
#   2. secrets-run on PATH (the mini): the maintained Postgres, with the role from .env.test.tpl. One command at a time holds
#      /tmp/agent-workflows-check.lock (lockf, CHECK_LOCK_WAIT seconds, exit 75 when it passes): the role's 64 connections are
#      shared with the live processes, and a full test run alone peaks at 38. Inside a factory slot already held, the wait
#      counts toward the slot's 30 min run limit, hence 20 min.
#   3. PG_BIN_DIR set (the step image on the factory's step host, which has secrets-run nowhere): a private cluster in a
#      temp directory on a free loopback port, trust auth, stopped and removed when the command ends. The superuser is the
#      test role and the admin one at once, so the usage schema suite's scratch database works there too.
# POSIX sh: the step image's /bin/sh is dash. Its exit code is the command's.
set -u

if [ -n "${AGW_TEST_PG_URL:-}" ]; then exec "$@"; fi

if command -v secrets-run >/dev/null 2>&1; then
  lock=''
  if command -v lockf >/dev/null 2>&1; then
    lock="lockf -t ${CHECK_LOCK_WAIT:-1200} ${CHECK_LOCK:-/tmp/agent-workflows-check.lock}"
  else
    echo "test-env: lockf is not on PATH: this run takes no lock and may share the role's connections with another check" >&2
  fi
  # $lock is a command prefix, split into words on purpose.
  # shellcheck disable=SC2086
  exec $lock secrets-run run --env-file=.env.test.tpl -- sh -c '
    AGW_TEST_PG_URL="postgres://agent_workflows:$(bun -e "process.stdout.write(encodeURIComponent(process.env.AGW_TEST_PG_PASSWORD))")@127.0.0.1:5432/agent_workflows"
    USAGE_TEST_PG_URL="postgres://$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_USER))"):$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_TEST_PG_PASSWORD))")@127.0.0.1:5432/postgres"
    export AGW_TEST_PG_URL USAGE_TEST_PG_URL
    exec "$@"' sh "$@"
fi

if [ -z "${PG_BIN_DIR:-}" ]; then
  echo "test-env: AGW_TEST_PG_URL is unset, secrets-run is not on PATH and PG_BIN_DIR is unset: no Postgres for the tests" >&2
  exit 1
fi

dir="$(mktemp -d "${TMPDIR:-/tmp}/agw-test-pg.XXXXXX")" || exit 1
stop() {
  "$PG_BIN_DIR/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1
  rm -rf "$dir"
}
trap stop EXIT
trap 'exit 143' HUP INT TERM

fail() {
  echo "test-env: $1" >&2
  cat "$dir/pg.log" >&2 2>/dev/null
  exit 1
}

# C.UTF-8 as the image has no other locale, whatever LANG the caller's shell passed in.
"$PG_BIN_DIR/initdb" -D "$dir/data" -U agent_workflows --auth=trust --no-sync --encoding=UTF8 --locale=C.UTF-8 >"$dir/pg.log" 2>&1 \
  || fail "initdb failed"
port="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true)')" \
  || fail "no free port"
# Throwaway data: nothing is worth a disk flush. 200 connections: the parallel workers hold a few pools each.
"$PG_BIN_DIR/pg_ctl" -D "$dir/data" -l "$dir/pg.log" -w -s \
  -o "-c listen_addresses=127.0.0.1 -p $port -c unix_socket_directories=$dir -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
  start || fail "pg_ctl start failed"
"$PG_BIN_DIR/createdb" -h 127.0.0.1 -p "$port" -U agent_workflows agent_workflows || fail "createdb failed"

AGW_TEST_PG_URL="postgres://agent_workflows@127.0.0.1:$port/agent_workflows"
USAGE_TEST_PG_URL="postgres://agent_workflows@127.0.0.1:$port/postgres"
export AGW_TEST_PG_URL USAGE_TEST_PG_URL
"$@"
exit $?
