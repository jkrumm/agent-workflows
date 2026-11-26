# syntax=docker/dockerfile:1
# The test step's image on the factory's step host (project.yaml `steps.test.dockerfile`): Ubuntu 24.04 as CI's
# `ubuntu-latest`, with what the suite runs that the factory's own image lacks: ffmpeg and ffprobe (packages/audio exercises
# the real boundary) and zsh (the script tests run the real interpreter; with `CI` set, which a step has, a missing zsh fails
# the file). Plus what the factory's image carries and a repo's own image must: git, jq, make, the pinned bun and the
# PostgreSQL 16 server binaries (`initdb` and `pg_ctl` on PATH, PG_BIN_DIR set): scripts/test-env.sh starts a private
# cluster in the step's container, as it does on the mini. The step host builds this once per
# content, from stdin: there is no build context, so nothing here is COPYed.
FROM ubuntu:24.04
# The factory passes BUN: the version of package.json's `packageManager`.
ARG BUN

# The package's default cluster would be created at build time: no step reads it.
RUN mkdir -p /etc/postgresql-common && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git jq make postgresql-16 unzip zsh \
 && rm -rf /var/lib/apt/lists/*
ENV PG_BIN_DIR=/usr/lib/postgresql/16/bin
ENV PATH=/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$BUN/bun-linux-x64.zip" \
 && unzip -q /tmp/bun.zip -d /tmp && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun && ln -s bun /usr/local/bin/bunx \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
