import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveTreeTokenUsage } from '@deepseek-ai/dsh-token-meter/client'

const root = SessionId('root')
const child = SessionId('child')
const grandchild = SessionId('grandchild')
const sibling = SessionId('sibling')
const fork = SessionId('ordinary-fork')
const byId = {
  [root]: { id: root },
  [child]: { id: child, parentId: root, origin: 'subagent' },
  [sibling]: { id: sibling, parentId: root, origin: 'subagent' },
  [grandchild]: { id: grandchild, parentId: child, origin: 'subagent' },
  [fork]: { id: fork, parentId: root },
} as const
const buckets = (n: number) => ({ uncachedInputTokens: n, outputTokens: n * 2, cacheReadTokens: n * 3, cacheWriteTokens: n * 4 })
const snapshot = (n: number) => ({ state: 'idle' as const, values: { ownedTokenUsage: buckets(n) } })

const listed = {
  phase: 'ready', byId,
  projectionsBySession: {
    [root]: snapshot(10), [child]: snapshot(4), [grandchild]: snapshot(2), [sibling]: snapshot(3), [fork]: snapshot(99),
  },
} as const

describe('Session subtree usage', () => {
  it('sums cached descendants at every depth and accepts live usage replacements', () => {
    expect(deriveTreeTokenUsage(root, listed)).toEqual({
      currentSession: buckets(10), subagents: buckets(9), total: buckets(19), nextRead: undefined, unavailable: false,
    })
    expect(deriveTreeTokenUsage(child, listed)).toEqual({
      currentSession: buckets(4), subagents: buckets(2), total: buckets(6), nextRead: undefined, unavailable: false,
    })
    const updated = { ...listed, projectionsBySession: { ...listed.projectionsBySession, [grandchild]: snapshot(5) } }
    expect(deriveTreeTokenUsage(root, updated).total).toEqual(buckets(22))
    expect(deriveTreeTokenUsage(fork, listed).subagents).toEqual(buckets(0))
  })

  it('reads missing owned projections one at a time after the Host list arrives', () => {
    const { [sibling]: _unloaded, ...rest } = listed.projectionsBySession
    const legacy = { ...listed, projectionsBySession: { ...rest, [grandchild]: { state: 'idle' as const, values: {} } } }
    expect(deriveTreeTokenUsage(root, { ...legacy, phase: 'pending' })).toEqual({
      total: undefined, subagents: undefined, currentSession: buckets(10), nextRead: undefined, unavailable: false,
    })
    expect(deriveTreeTokenUsage(root, legacy)).toEqual({
      total: undefined, subagents: undefined, currentSession: buckets(10), nextRead: sibling, unavailable: false,
    })
    const reading = { ...legacy.projectionsBySession, [sibling]: { state: 'loading' as const, values: {} } }
    expect(deriveTreeTokenUsage(root, { ...legacy, projectionsBySession: reading }).nextRead).toBeUndefined()
    const loaded = { ...reading, [sibling]: snapshot(3) }
    expect(deriveTreeTokenUsage(root, { ...legacy, projectionsBySession: loaded }).nextRead).toBe(grandchild)
  })

  it.each(['error', 'migration-required', 'ready'] as const)('reports missing usage after a %s projection read', (state) => {
    expect(deriveTreeTokenUsage(fork, { ...listed, projectionsBySession: { [fork]: { state, values: {} } } })).toEqual({
      currentSession: undefined, subagents: buckets(0), total: undefined, nextRead: undefined, unavailable: true,
    })
  })

  it('keeps a missing historical projection unavailable until the child migrates', () => {
    const historical = { ...byId, [child]: { id: child, parentId: root, origin: 'subagent' as const, formatStatus: 'migration-required' as const } }
    const { [child]: _missing, ...projectionsBySession } = listed.projectionsBySession
    expect(deriveTreeTokenUsage(root, { ...listed, byId: historical, projectionsBySession })).toEqual({
      currentSession: buckets(10), subagents: undefined, total: undefined, nextRead: undefined, unavailable: true,
    })
  })

  it('visits each member once even when historical lineage contains a cycle', () => {
    const cyclic = { ...byId, [root]: { id: root, origin: 'subagent' as const, parentId: child } }
    expect(deriveTreeTokenUsage(root, { ...listed, byId: cyclic }).total).toEqual(buckets(19))
  })
})
