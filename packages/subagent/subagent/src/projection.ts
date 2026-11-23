/**
 * Pure session projections for subagent identity (mode/label) and active-turn
 * duration.
 *
 * @module @deepseek-ai/dsh-subagent/projection
 */

import { z } from 'zod'
import { SessionLogOffset, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import type { SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

/** Fold state for a subagent's latest timing snapshot. */
export interface TimingState {
  /** Milliseconds accumulated across completed post-descriptor turns. */
  settledMs: number
  /** Current open interval kept paired inside the fold. */
  active?: { since: number; through: number } | undefined
  /** Latest pre-descriptor turn start, promoted when the child's own descriptor arrives. */
  pendingTurnStart?: number | undefined
  /** Whether the fold has crossed a descriptor in this logical log. */
  descriptorSeen: boolean
  /** Whether the latest closed post-descriptor turn completed normally; absent while a turn is open or before one closes. */
  lastTurnCompleted?: boolean | undefined
}

const activeIntervalSchema = z.object({
  since: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
}).strict()

const projectionSchema: z.ZodType<SubagentTimingProjection> = z.object({
  settledMs: z.number().int().nonnegative(),
  active: activeIntervalSchema.optional(),
  lastTurnCompleted: z.boolean().optional(),
}).strict().transform(({ settledMs, active, lastTurnCompleted }) => ({
  settledMs,
  ...active === undefined ? {} : { active },
  ...lastTurnCompleted === undefined ? {} : { lastTurnCompleted },
}))

const timingStateSchema: z.ZodType<TimingState> = z.object({
  settledMs: z.number().int().nonnegative(),
  active: activeIntervalSchema.optional(),
  pendingTurnStart: z.number().int().nonnegative().optional(),
  descriptorSeen: z.boolean(),
  lastTurnCompleted: z.boolean().optional(),
}).strict()

/**
 * Fold turn boundaries around the child's own durable descriptor.
 *
 * A fork seed may contain an ancestor descriptor and completed turns. Every
 * descriptor therefore resets the accumulated state; the healthy catalog
 * admits only a child with exactly one descriptor in its own suffix, making
 * the final reset the child's authoritative timing origin.
 */
export const subagentTimingProjectionDefinition = {
  key: 'subagentTiming',
  stateSchema: timingStateSchema,
  init: () => ({ descriptorSeen: false, settledMs: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      const { lastTurnCompleted: _closed, ...openState } = state
      return state.descriptorSeen
        ? { ...openState, active: { since: event.time, through: event.time } }
        : { ...openState, pendingTurnStart: event.time }
    }
    if (event.type === 'subagent/descriptor') {
      const activeSince = state.active?.since ?? state.pendingTurnStart
      return {
        descriptorSeen: true,
        settledMs: 0,
        ...(activeSince === undefined
          ? {}
          : { active: { since: activeSince, through: event.time } }),
      }
    }
    if (event.type === 'turn/end') {
      if (!state.descriptorSeen) {
        if (state.pendingTurnStart === undefined) return state
        const { pendingTurnStart: _closed, ...next } = state
        return next
      }
      if (state.active === undefined) return state
      const { active, ...rest } = state
      return {
        ...rest,
        settledMs: state.settledMs + Math.max(0, event.time - active.since),
        lastTurnCompleted: event.data.reason.kind === 'completed',
      }
    }
    if (state.active === undefined) return state
    return { ...state, active: { ...state.active, through: event.time } }
  },
  wire: {
    viewSchema: projectionSchema,
    view: state => ({
      settledMs: state.settledMs,
      ...(state.active === undefined ? {} : { active: state.active }),
      ...(state.lastTurnCompleted === undefined ? {} : { lastTurnCompleted: state.lastTurnCompleted }),
    }),
  },
  stateVersion: 3,
} satisfies ProjectionDefinition<'subagentTiming', TimingState>

/** Descriptor identity retained by the subagent projection. */
export interface IdentityState {
  /** Inherited descriptors identify ancestors but cannot supply this child's model. */
  inheritedEventCount: SessionLogOffset
  /** Identity from the last valid descriptor; absent before one, and after an invalid one. */
  identity?: SubagentIdentityProjection | undefined
}

const modelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().transform(brandString<ReasoningEffortId>).exactOptional(),
}).strict()
const identityValueSchema: z.ZodType<SubagentIdentityProjection> = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('one-shot'),
    label: z.string().exactOptional(),
    modelSelection: modelSelectionSchema.exactOptional(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  }).strict(),
  z.object({
    mode: z.literal('continuable'),
    label: z.string(),
    modelSelection: modelSelectionSchema.exactOptional(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  }).strict(),
])

const identitySchema = identityValueSchema.nullable()

const identityStateSchema: z.ZodType<IdentityState> = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  identity: identityValueSchema.optional(),
}).strict()

/** Interpret one `subagent/descriptor` event's identity; no value when the payload cannot be trusted. */
function descriptorIdentity(event: SessionEvent, own: boolean): SubagentIdentityProjection | undefined {
  let descriptor: SubagentDescriptorData | undefined
  try {
    descriptor = foldSubagentDescriptor([event])
  } catch {
    // Only a malformed current-version payload throws in descriptor parsing;
    // a projection fold must never throw, so damage folds to no value.
    descriptor = undefined
  }
  if (descriptor === undefined) return undefined
  return descriptor.mode === 'one-shot'
    ? {
      mode: 'one-shot',
      ...descriptor.label !== undefined ? { label: descriptor.label } : {},
      seq: event.seq,
    }
    : {
      mode: 'continuable', label: descriptor.label, seq: event.seq,
      ...own && descriptor.agentProvider !== undefined && descriptor.agentModel !== undefined ? {
        modelSelection: {
          provider: descriptor.agentProvider, model: descriptor.agentModel,
          ...descriptor.agentReasoningEffort === undefined ? {} : { reasoningEffort: descriptor.agentReasoningEffort },
        },
      } : {},
    }
}

/**
 * Fold the durable mode/label identity from `subagent/descriptor` events,
 * last-wins: a fork seed may replay an ancestor's descriptor, and the child's
 * own descriptor must override it — the same reset discipline as
 * {@link subagentTimingProjectionDefinition}. A malformed or unknown-version
 * payload resets to the `null` sentinel instead of throwing, so a fork of a
 * healthy ancestor never inherits an identity its own descriptor failed to
 * establish — and the reset survives every JSON push frame, so a consumer
 * holding the earlier identity replaces it instead of keeping it stale;
 * `null` ⟺ no valid descriptor, with the causes deliberately undistinguished.
 */
export const subagentIdentityProjectionDefinition = {
  key: 'subagent',
  stateSchema: identityStateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset): IdentityState => ({ inheritedEventCount }),
  apply: (state, event) => {
    const { identity, inheritedEventCount } = state
    if (event.type === 'subagent/descriptor') {
      return { inheritedEventCount, identity: descriptorIdentity(event, event.seq >= inheritedEventCount) }
    }
    if (event.type !== 'request/header' || identity === undefined || identity.seq < inheritedEventCount) return state
    const { provider, model, reasoningEffort } = event.data.header.config
    const previous = identity.modelSelection
    if (previous?.provider === provider && previous.model === model && previous.reasoningEffort === reasoningEffort) return state
    const modelSelection = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    return { inheritedEventCount, identity: { ...identity, modelSelection } }
  },
  wire: { viewSchema: identitySchema, view: state => state.identity ?? null },
  stateVersion: 3,
} satisfies ProjectionDefinition<'subagent', IdentityState>
