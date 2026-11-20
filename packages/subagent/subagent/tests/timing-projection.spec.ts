import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { SUBAGENT_DESCRIPTOR_VERSION } from '../src/descriptor.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition, type TimingState } from '../src/projection.ts'

function event(
  type: SessionEvent['type'],
  seq: number,
  time: number,
  reason: TurnEndReason = { kind: 'completed' },
): SessionEvent {
  return {
    type,
    seq,
    time,
    data: type === 'turn/end' ? { turn: 1, reason } : {},
  } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state: TimingState = subagentTimingProjectionDefinition.init()
  for (const item of events) state = subagentTimingProjectionDefinition.apply(state, item)
  return subagentTimingProjectionDefinition.wire.view(state)
}

const sessionHeader = { id: SessionId('child'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: true } as const

describe('subagent timing projection', () => {
  it('preserves historical one-shot identity without inventing a label', () => {
    const descriptor = {
      ...event('subagent/descriptor', 1, 110),
      data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'spawn' },
    } as SessionEvent
    const unit = subagentIdentityProjectionDefinition
    const state = unit.apply(unit.init(sessionHeader, SessionLogOffset(0)), descriptor)
    expect(subagentIdentityProjectionDefinition.wire.view(state)).toEqual({ mode: 'one-shot', seq: 1 })
  })

  it('projects only the child route and the effort its own request materialized', () => {
    const unit = subagentIdentityProjectionDefinition
    const descriptor = (seq: number, model: string): SessionEvent<'subagent/descriptor'> => ({
      type: 'subagent/descriptor', seq: SessionSeq(seq), time: seq,
      data: {
        version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', label: model, provider: 'spawn',
        agentProvider: 'p', agentModel: model, agentReasoningEffort: ReasoningEffortId('low'),
      },
    })
    const request = (seq: number, model: string, effort?: string): SessionEvent<'request/header'> => ({
      type: 'request/header', seq: SessionSeq(seq), time: seq,
      data: { reason: 'change', header: {
        config: { provider: 'p', model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } },
        ...effort === undefined ? {} : { adapterDefaults: { reasoningEffort: true } },
      } },
    })
    const inherited = unit.apply(unit.init(sessionHeader, SessionLogOffset(2)), descriptor(0, 'ancestor'))
    expect(unit.apply(inherited, request(1, 'ancestor', 'max'))).toBe(inherited)
    expect(unit.wire.view(inherited)?.modelSelection).toBeUndefined()
    const child = unit.apply(inherited, descriptor(2, 'declared'))
    expect(unit.wire.view(child)?.modelSelection).toEqual({ provider: 'p', model: 'declared', reasoningEffort: 'low' })
    const used = unit.apply(child, request(3, 'actual', 'high'))
    expect(unit.wire.view(used)?.modelSelection).toEqual({ provider: 'p', model: 'actual', reasoningEffort: 'high' })
    expect(unit.apply(used, request(4, 'actual', 'high'))).toBe(used)
    const restored = unit.stateSchema.parse(JSON.parse(JSON.stringify(used)))
    expect(unit.wire.view(unit.apply(restored, request(5, 'historical')))?.modelSelection).toEqual({ provider: 'p', model: 'historical' })
  })

  it('waits for the session projection registry and releases its projections on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await mountWorkingDirectoryFixture(ctx)
    const pending = ctx.plugin(SubagentRuntime)
    expect(ctx.get('subagents')).toBeUndefined()
    await ctx.plugin(SessionProjectionRegistry)
    const serviceFiber = await pending

    const before = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(before.subagentTiming).toEqual({ settledMs: 0 })
    // The identity unit registers alongside timing; an empty log serves its
    // serializable null sentinel.
    expect(before.subagent).toBeNull()
    await serviceFiber.dispose()
    const after = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(after.subagentTiming).toBeUndefined()
    expect(after.subagent).toBeUndefined()
  })

  it('resets inherited seed timing at the child descriptor and sums later completed turns', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 300),
      event('turn/start', 3, 1_000),
      event('subagent/descriptor', 4, 1_100),
      event('turn/end', 5, 4_100),
      event('turn/start', 6, 10_000),
      event('turn/end', 7, 12_000),
    ])).toEqual({ settledMs: 5_100, lastTurnCompleted: true })
  })

  it('exposes an open turn start and never subtracts time for reversed boundaries', () => {
    expect(fold([
      event('turn/start', 0, 1_000),
      event('subagent/descriptor', 1, 1_100),
      event('turn/end', 2, 900),
      event('turn/start', 3, 2_000),
      event('assistant/attempt', 4, 2_500),
    ])).toEqual({ settledMs: 0, active: { since: 2_000, through: 2_500 } })
  })

  it('publishes only the latest closed turn completion and clears it when another turn opens', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
      event('turn/end', 4, 400, { kind: 'interrupted' }),
    ])).toEqual({ settledMs: 200, lastTurnCompleted: false })

    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
    ])).toEqual({ settledMs: 100, active: { since: 300, through: 300 } })
  })

  it('ignores completed pre-descriptor turns and unrelated events', () => {
    const initial = subagentTimingProjectionDefinition.init()
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('assistant/attempt', 0, 1),
    )).toBe(initial)
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('turn/end', 1, 2),
    )).toBe(initial)
    const descriptor = subagentTimingProjectionDefinition.apply(
      initial,
      event('subagent/descriptor', 2, 3),
    )
    expect(subagentTimingProjectionDefinition.apply(
      descriptor,
      event('turn/end', 3, 4),
    )).toBe(descriptor)
    expect(fold([
      event('turn/start', 0, 100),
      event('turn/end', 1, 200),
      event('subagent/descriptor', 2, 300),
    ])).toEqual({ settledMs: 0 })
  })
})
