#!/usr/bin/env bun
// Production alone on a real script: builds `podcast.produce`'s input from a recorded audio-gateway job (its
// `script.json` and its ledger row, both read-only) and, with `--run`, produces it on this platform.
//
//   bun scripts/produce-from-legacy.ts <legacy job id or 8-char prefix>            # dry run: print the input
//   bun scripts/produce-from-legacy.ts <id> --run [--publish] [--brain-note] [--no-cover]
//
// The input mirrors what the writers' room hands over (`packages/audio/src/workflows/podcast/index.ts` step 11): the
// script without its metadata fields, the hosts, the metadata, the request's later-stage fields and the profile.
// Publishing is off unless `--publish`; the brain note (a second note for an episode legacy already filed) is off
// unless `--brain-note`. `--run` starts the run on an in-process runtime against the journal (`AGW_PG_URL`,
// `AGW_PG_SCHEMA`), with the audio env of this process (`IU_*`, `PODCAST_*`, `ABS_*`, `BRAIN_DIR`); run it through
// `secrets-run run --env-file=.env.tpl -- …` on the mini. It spends TTS and image money. Legacy checkout:
// AGW_LEGACY_AUDIO, default ~/SourceRoot/audio-gateway.
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { createCapabilities } from '../packages/capabilities/src/index.ts'
import { audioConfig } from '../packages/audio/src/config.ts'
import type { Queryable } from '../packages/audio/src/workflows/podcast/history.ts'
import { type CoverCall, createProduceWorkflow } from '../packages/audio/src/workflows/podcast-produce/index.ts'
import { postgresProduceJournal } from '../packages/audio/src/workflows/podcast-produce/journal.ts'
import {
  type LegacyRequest,
  type LegacyScript,
  type LegacyState,
  produceInputFromLegacy,
} from '../packages/audio/src/workflows/podcast-produce/legacy-input.ts'
import { Runtime } from '../packages/runtime/src/index.ts'

const LEGACY = process.env.AGW_LEGACY_AUDIO ?? join(homedir(), 'SourceRoot', 'audio-gateway')

interface Job {
  id: string
  created_at: string
  request_json: string
  state_json: string
}

function readJob(prefix: string): Job {
  const db = new Database(join(LEGACY, 'data', 'podcasts.db'), { readonly: true })
  try {
    const rows = db
      .query<Job, [string]>('select id, created_at, request_json, state_json from podcast_job where id like ?')
      .all(`${prefix}%`)
    if (rows.length !== 1) throw new Error(`"${prefix}" matches ${rows.length} legacy jobs, not one`)
    return rows[0] as Job
  } finally {
    db.close()
  }
}

async function main(argv: string[]) {
  const id = argv.find((a) => !a.startsWith('--'))
  if (!id) throw new Error('usage: produce-from-legacy.ts <legacy job id> [--run] [--publish] [--brain-note] [--no-cover]')
  const job = readJob(id)
  const input = produceInputFromLegacy({
    job: { id: job.id, createdAt: job.created_at },
    script: JSON.parse(readFileSync(join(LEGACY, 'data', 'podcasts', job.id, 'script.json'), 'utf8')) as LegacyScript,
    request: JSON.parse(job.request_json) as LegacyRequest,
    state: JSON.parse(job.state_json) as LegacyState,
    flags: { publish: argv.includes('--publish'), brainNote: argv.includes('--brain-note'), cover: !argv.includes('--no-cover') },
  })
  if (!argv.includes('--run')) {
    console.log(JSON.stringify(input, null, 2))
    return
  }

  const pgUrl = process.env.AGW_PG_URL
  if (!pgUrl) throw new Error('--run needs AGW_PG_URL (and AGW_PG_SCHEMA, default agw)')
  const schema = process.env.AGW_PG_SCHEMA?.trim() || 'agw'
  // `pg` is the runtime package's dependency, not the root's: resolved from there, as the history import does.
  const { Pool } = createRequire(resolve(import.meta.dir, '../packages/runtime/package.json'))('pg') as {
    Pool: new (options: { connectionString: string; max: number }) => Queryable & { end(): Promise<void> }
  }
  const pool = new Pool({ connectionString: pgUrl, max: 2 })
  const cover = createCapabilities().find((c) => c.id === 'image.generate') as unknown as CoverCall | undefined
  const produce = createProduceWorkflow({
    journal: postgresProduceJournal(pool, schema),
    audio: { config: audioConfig(process.env), env: process.env },
    ...(cover ? { cover } : {}),
  })
  const runtime = new Runtime({ connectionString: pgUrl, schema, workflows: [produce] })
  await runtime.open()
  try {
    const { runId } = await runtime.start(produce, input, { purpose: 'build' })
    console.error(`podcast.produce run ${runId} started`)
    const result = await runtime.wait(runId)
    console.log(JSON.stringify({ runId, status: result.status, output: result.output ?? null }, null, 2))
    if (result.status !== 'done') process.exitCode = 1
  } finally {
    await runtime.close()
    await pool.end()
  }
}

if (import.meta.main) await main(process.argv.slice(2))
