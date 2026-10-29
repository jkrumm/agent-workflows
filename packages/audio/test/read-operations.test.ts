// The host serves the overview reads (`agents`, `quota`, `quota-report`); the audio process must not. The CLI refuses a
// command two processes declare unless every owner is a run command, so both processes are booted for real and their
// contracts checked against that rule.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../../host/src/boot.ts'
import { loadConfig } from '../../host/src/config.ts'
import { freshSchema, PG_URL } from '../../runtime/test/support/pg.ts'
import { testConfig } from '../src/testing/index.ts'
import { bootAudio, loadAudioProcessConfig } from '../src/process/index.ts'

const SECRET = 'test-secret-0123456789abcdef-0123456789'

type Doc = { paths: Record<string, Record<string, { 'x-cli'?: { command: string[]; kind: string } }>> }

test('the reads are declared by the host only: no command is served by both processes unless it is a run command', async () => {
  const hostDb = freshSchema('readshost')
  const audioDb = freshSchema('readsaudio')
  const home = mkdtempSync(join(tmpdir(), 'agw-reads-'))
  const hostEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    AGW_ARGO_PUSH: '0',
    AGW_API_SECRET: SECRET,
    AGW_MACHINE: 'test-machine',
    AGW_PG_URL: PG_URL,
    AGW_PG_SCHEMA: hostDb.schema,
    AGW_PORT: '0',
    IU_API_KEY: 'test-key',
  }
  const host = await boot(loadConfig(hostEnv), { env: hostEnv })
  const audio = await bootAudio(
    {
      audio: { config: testConfig('https://iu.example.com/anthropic'), env: {} },
      config: loadAudioProcessConfig({
        HOME: home,
        AGW_API_SECRET: SECRET,
        AGW_MACHINE: 'test-machine',
        AGW_PG_URL: PG_URL,
        AGW_PG_SCHEMA: audioDb.schema,
        AGW_AUDIO_PORT: '0',
        AGW_AUDIO_STATE_DIR: home,
      }),
      handlers: {} as never,
      tokens: new Map(),
    },
    { env: { PATH: process.env.PATH ?? '', HOME: home } },
  )
  try {
    const contract = async (port: number) => {
      const doc = (await (
        await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers: { authorization: `Bearer ${SECRET}` } })
      ).json()) as Doc
      return Object.values(doc.paths)
        .flatMap((methods) => Object.values(methods))
        .flatMap((op) => (op['x-cli'] ? [{ command: op['x-cli'].command.join(' '), kind: op['x-cli'].kind }] : []))
    }
    const [hostOps, audioOps] = [await contract(host.port), await contract(audio.port)]

    const reads = ['agents', 'quota', 'quota-report']
    expect(hostOps.map((o) => o.command)).toEqual(expect.arrayContaining(reads))
    expect(audioOps.map((o) => o.command).filter((c) => reads.includes(c))).toEqual([])

    // the CLI's rule: a command both declare must be a run command on every owner
    const owners = new Map<string, string[]>()
    for (const op of [...hostOps, ...audioOps]) owners.set(op.command, [...(owners.get(op.command) ?? []), op.kind])
    const conflicts = [...owners].filter(([, kinds]) => kinds.length > 1 && !kinds.every((k) => k === 'run'))
    expect(conflicts).toEqual([])
  } finally {
    await audio.shutdown()
    await host.shutdown()
    rmSync(home, { recursive: true, force: true })
    await hostDb.drop()
    await audioDb.drop()
  }
})
