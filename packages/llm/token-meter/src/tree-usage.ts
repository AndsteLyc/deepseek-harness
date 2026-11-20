import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from './projection.ts'

/** Session-list fields used to sum local descendants without opening their conversations. */
interface UsageList {
  readonly phase: 'pending' | 'ready'
  readonly byId: Readonly<Record<SessionId, {
    readonly id: SessionId
    readonly parentId?: SessionId
    readonly origin?: 'subagent'
    readonly formatStatus?: 'current' | 'migration-required' | undefined
  }>>
  readonly projectionsBySession: Readonly<Record<SessionId, {
    readonly state: 'idle' | 'loading' | 'ready' | 'migration-required' | 'error'
    readonly values: { readonly ownedTokenUsage?: TokenUsageProjection }
  }>>
}

/** A total is available once the list and all local members' owned usage have arrived. */
export type TreeTokenUsage = {
  /** Next missing member to read, once any previous passive projection read settles. */
  readonly nextRead: SessionId | undefined
  /** A required projection could not be read or requires explicit Session migration. */
  readonly unavailable: boolean
} & ({
  readonly total: TokenUsageProjection
  readonly currentSession: TokenUsageProjection
  readonly subagents: TokenUsageProjection
} | {
  readonly total: undefined
  readonly currentSession: TokenUsageProjection | undefined
  readonly subagents: TokenUsageProjection | undefined
})

function addUsage(left: TokenUsageProjection, right: TokenUsageProjection): TokenUsageProjection {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/**
 * Sum each local subagent descendant's owned usage once in the selected Session's subtree.
 * @param sessionId - Selected Session, including when it is itself a fork or subagent.
 * @param list - Current list and live or cached per-Session projections.
 * @returns Own, descendant and combined buckets, with the next passive read or unavailable status.
 */
export function deriveTreeTokenUsage(sessionId: SessionId, list: UsageList): TreeTokenUsage {
  const currentSession = list.projectionsBySession[sessionId]?.values.ownedTokenUsage
  if (list.phase === 'pending') {
    return { currentSession, subagents: undefined, total: undefined, nextRead: undefined, unavailable: false }
  }

  const children = new Map<SessionId, SessionId[]>()
  for (const row of Object.values(list.byId)) {
    if (row.origin !== 'subagent' || row.parentId === undefined) continue
    const siblings = children.get(row.parentId)
    if (siblings === undefined) children.set(row.parentId, [row.id])
    else siblings.push(row.id)
  }

  let subagents: TokenUsageProjection | undefined = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let nextRead: SessionId | undefined
  let loading = false
  let unavailable = false
  const members = new Set([sessionId])
  for (const id of members) {
    for (const child of children.get(id) ?? []) members.add(child)
    const snapshot = list.projectionsBySession[id]
    loading ||= snapshot?.state === 'loading'
    const usage = snapshot?.values.ownedTokenUsage
    if (usage === undefined) {
      if (id !== sessionId) subagents = undefined
      if (list.byId[id]?.formatStatus === 'migration-required') unavailable = true
      else if (snapshot === undefined || snapshot.state === 'idle') nextRead ??= id
      else if (snapshot.state !== 'loading') unavailable = true
    } else if (id !== sessionId && subagents !== undefined) {
      subagents = addUsage(subagents, usage)
    }
  }
  if (subagents === undefined || currentSession === undefined) {
    return { currentSession, subagents, total: undefined, nextRead: loading ? undefined : nextRead, unavailable }
  }
  return { currentSession, subagents, total: addUsage(currentSession, subagents), nextRead: undefined, unavailable: false }
}
