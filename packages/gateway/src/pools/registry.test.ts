import { describe, expect, test } from 'bun:test'

import { parseRegistry } from './registry.ts'

const platform = {
  creditUsd: 200,
  cycleDay: 21,
  headroomUsd: 2,
  enabled: true,
  apiKeyRef: 'op://vault/item/API_KEY',
  adminKeyRef: 'op://vault/item/ADMIN_KEY',
}

describe('parseRegistry', () => {
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
