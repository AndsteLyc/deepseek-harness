/** Session list and projection fixtures for the composer statistics. */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ActivityPillProps, UsagePillProps } from '../src/client/chat/StatsPills.tsx'

export type StatPillProps = ActivityPillProps & UsagePillProps
export const ROOT = 'usage-root' as SessionId

interface UsageEntry {
  id: SessionId
  parentId?: SessionId
  usage?: TokenUsageProjection
}

export function sessionList(entries: readonly UsageEntry[]): SessionListState {
  const byId: SessionListState['byId'] = {}
  const projections: Record<SessionId, SessionListState['projectionsBySession'][SessionId]> = {}
  for (const { id, parentId, usage } of entries) {
    const row: SessionSummary = {
      id, displayTitle: id, retainedBy: {}, blank: false, running: false, updatedAt: 0,
      ...parentId === undefined ? {} : { parentId, origin: 'subagent' },
    }
    byId[id] = row
    if (usage !== undefined) projections[id] = { state: 'ready', error: null, values: { ownedTokenUsage: usage } }
  }
  return { phase: 'ready', ids: entries.map(entry => entry.id), byId, projectionsBySession: projections }
}

export function singleSession(usage?: TokenUsageProjection): Pick<UsagePillProps, 'useSessions' | 'sessionId' | 'refreshUsage'> {
  const state = sessionList([{ id: ROOT, ...usage === undefined ? {} : { usage } }])
  return { sessionId: ROOT, useSessions: bindSnapshotSelector(createSnapshotStore(state)), refreshUsage: () => {} }
}
