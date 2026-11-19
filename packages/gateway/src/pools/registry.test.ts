import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRegistry, registryFile, reserveAboveCredit } from './registry.ts'

const platform = {
  creditUsd: 200,
  cycleDay: 21,
  headroomUsd: 2,
  enabled: true,
  apiKeyRef: 'op://vault/item/API_KEY',
  adminKeyRef: 'op://vault/item/ADMIN_KEY',
}

describe('registryFile', () => {
  const withHome = (run: (home: string) => void) => {
    const home = mkdtempSync(join(tmpdir(), 'registry-home-'))
    try {
      run(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test('$CLAUDE_ACCOUNTS_REGISTRY wins, $AGW_GATEWAY_ACCOUNTS_FILE beats it', () =>
    withHome((home) => {
      expect(registryFile({ CLAUDE_ACCOUNTS_REGISTRY: '/r/a.json' }, home)).toBe('/r/a.json')
      expect(
        registryFile({ CLAUDE_ACCOUNTS_REGISTRY: '/r/a.json', AGW_GATEWAY_ACCOUNTS_FILE: '/r/b.json' }, home),
      ).toBe('/r/b.json')
    }))

  test('the per-user file when it exists, else the dotfiles file', () =>
    withHome((home) => {
      expect(registryFile({}, home)).toBe(join(home, 'SourceRoot', 'dotfiles', 'config', 'claude-accounts.json'))
      const own = join(home, '.config', 'claude-accounts', 'registry.json')
      mkdirSync(join(home, '.config', 'claude-accounts'), { recursive: true })
      writeFileSync(own, '{}')
      expect(registryFile({}, home)).toBe(own)
    }))
})

describe('parseRegistry', () => {
  test('a v2 registry (a version, a mode, a host block) yields the same pools as the v1 one', () => {
    const v1 = { accounts: { iu: { dir: null, enabled: true, platform }, me: { dir: '~/.claude-me', platform } } }
    const v2 = {
      version: 2,
      host: { name: 'mini', role: 'primary' },
      accounts: {
        iu: {
          dir: null,
          enabled: true,
          mode: 'subscription',
          host: { name: 'mini' },
          platform: { ...platform, future: 1 },
        },
        me: { dir: '~/.claude-me', mode: 'api', platform },
      },
    }
    expect(parseRegistry(v2)).toEqual(parseRegistry(v1))
  })

  test('reads the platform block of each account in registry order', () => {
    const pools = parseRegistry({
      _note: 'ignored',
      accounts: {
        iu: { dir: null, enabled: true, plan: 'ultra', platform },
        me: { dir: '~/.claude-me', platform: { ...platform, creditUsd: 100, cycleDay: null, adminKeyRef: undefined } },
      },
    })
    expect(pools).toEqual([
      { id: 'iu', ...platform },
      {
        id: 'me',
        creditUsd: 100,
        cycleDay: null,
        headroomUsd: 2,
        enabled: true,
        apiKeyRef: 'op://vault/item/API_KEY',
      },
    ])
  })

  test('skips an account without a platform block', () => {
    const pools = parseRegistry({ accounts: { iu: { platform }, old: { dir: null, enabled: true } } })
    expect(pools.map((pool) => pool.id)).toEqual(['iu'])
  })

  test('evalReserveUsd is optional, a number from zero up', () => {
    expect(parseRegistry({ accounts: { iu: { platform } } })[0]).not.toHaveProperty('evalReserveUsd')
    expect(parseRegistry({ accounts: { iu: { platform: { ...platform, evalReserveUsd: 0 } } } })[0]).toMatchObject({
      evalReserveUsd: 0,
    })
    expect(() => parseRegistry({ accounts: { iu: { platform: { ...platform, evalReserveUsd: -1 } } } })).toThrow(
      /account "iu" platform\.evalReserveUsd/,
    )
  })

  test('reserveAboveCredit names the pools no eval can ever draw on', () => {
    const pools = parseRegistry({
      accounts: {
        iu: { platform: { ...platform, evalReserveUsd: 250 } },
        me: { platform: { ...platform, evalReserveUsd: 200 } },
        me2: { platform },
      },
    })
    expect(reserveAboveCredit(pools).map((pool) => pool.id)).toEqual(['iu'])
  })

  test('a malformed platform block throws naming the account and the field', () => {
    expect(() => parseRegistry({ accounts: { me: { platform: { ...platform, cycleDay: 32 } } } })).toThrow(
      /account "me" platform\.cycleDay/,
    )
    expect(() => parseRegistry({ accounts: { me2: { platform: { ...platform, apiKeyRef: undefined } } } })).toThrow(
      /account "me2" platform\.apiKeyRef/,
    )
    expect(() => parseRegistry({ accounts: { iu: { platform: { ...platform, creditUsd: '200' } } } })).toThrow(
      /account "iu" platform\.creditUsd/,
    )
    expect(() => parseRegistry({ accounts: { iu: { platform: 'yes' } } })).toThrow(/account "iu" platform:/)
  })

  test('a registry without accounts throws', () => {
    expect(() => parseRegistry({})).toThrow(/accounts/)
    expect(() => parseRegistry({ accounts: { iu: 'x' } })).toThrow(/account "iu" is not an object/)
  })
})
