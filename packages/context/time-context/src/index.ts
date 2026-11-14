/**
 * Opt-in request clock context. Eligible steps add durable,
 * source-attributed time readings to the request history.
 *
 * @module @deepseek-ai/dsh-time-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'time-context': { kind: 'time-context' } & ContextFormed
  }
}

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { Duration } from '@deepseek-ai/dsh-util-time'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  deriveBrowserTimeZoneContext,
  reportedBrowserTimeZone,
  renderBrowserTimeZoneContext,
} from './request-zone.ts'
import { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'time-context'

const timeContextStateSchema = zod.object({
  /** Time of the latest model-visible event (user/assistant message, tool result), or null. */
  lastMessageTime: zod.number().nullable(),
  /** Time of this plugin's latest durable injection, or null. */
  lastInjectionTime: zod.number().nullable(),
  /** Latest injection time in the open turn, or null before that turn receives one. */
  lastTurnInjectionTime: zod.number().nullable(),
  /** Latest entered turn; null before any turn/start record. */
  browserTurn: zod.number().nullable(),
  /** Distinct reported zones in encounter order; validation remains request-time. */
  browserTimeZones: zod.array(zod.string()),
})

/** The agent registry that owns pre-step processing. */
export const inject = ['agents', 'sessionProjections']

/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
  timeZone?: string
  /**
   * Force this IANA zone for the clock timestamp, overriding the browser zone reported for the open
   * request. Omit to keep browser-zone precedence with `timeZone` or the process zone as fallback.
   * The timestamp still names this zone when the browser policy line is omitted.
   */
  overrideTimeZone?: string
  /**
   * Append the browser time-zone policy line that tells the model which zone owns unqualified times.
   * Defaults to true; false keeps only the timestamp and elapsed lines, while the timestamp still names
   * the zone it was formatted in. A mixed or missing browser zone then reaches the model as no policy at
   * all, so the model is not asked to clarify.
   */
  includeTimeZone?: boolean
  /** Minimum milliseconds between durable injections in one session. Defaults to 600000 (10 minutes); 0 injects at every eligible step. */
  refreshIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  overrideTimeZone: z.string(),
  includeTimeZone: z.boolean(),
  refreshIntervalMs: z.number(),
})

/**
 * Format a non-negative elapsed millisecond count as compact whole-second units.
 *
 * A backward wall-clock reading is a property of the clock rather than of the
 * span, so it clamps to zero here; the shared span type then supplies the whole
 * parts, and this package keeps the wording.
 */
function formatDuration(elapsedMs: number): string {
  const { days, hours, minutes, seconds } = Duration
    .fromMilliseconds(Math.max(0, elapsedMs))
    .decompose()
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** Preserve the original scan for typed pre-step callers requesting a nonlatest turn. */
function requestMessages(agent: Agent, turn: number, proposed: readonly UserMessage[]): UserMessage[] {
  const entered: UserMessage[] = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      return [...entered.reverse(), ...proposed]
    }
    if (event?.type === 'user/message') entered.push(event.data)
  }
  return [...proposed]
}

function renderText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
  browserText: string | undefined,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  const lines = [
    `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}`,
    ...(browserText === undefined ? [] : [browserText]),
    `Elapsed since the preceding ${baseline}: ${elapsed}.`,
  ]
  return lines.join('\n')
}

/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number): void {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * Steps admitted during activation await the projection registration; a
 * registration failure or owner disposal prevents the request from proceeding.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - time zone and durable refresh scheduling configuration.
 * @throws when the refresh interval is invalid or the configured or process time zone cannot be resolved.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const timeZone = config.timeZone
  const overrideTimeZone = config.overrideTimeZone
  const includeTimeZone = config.includeTimeZone ?? true
  const refreshIntervalMs = config.refreshIntervalMs ?? 600_000
  validateRefreshInterval(refreshIntervalMs)
  let fallbackFormatter: Intl.DateTimeFormat
  try {
    fallbackFormatter = createTimestampFormatter(timeZone)
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const fallbackTimeZone = fallbackFormatter.resolvedOptions().timeZone
  const formatters = new Map<string, Intl.DateTimeFormat>([[fallbackTimeZone, fallbackFormatter]])
  let overrideTimeZoneResolved: string | undefined
  if (overrideTimeZone !== undefined) {
    try {
      const formatter = createTimestampFormatter(overrideTimeZone)
      overrideTimeZoneResolved = formatter.resolvedOptions().timeZone
      formatters.set(overrideTimeZoneResolved, formatter)
    } catch (error: unknown) {
      throw new Error(
        `time-context: invalid IANA overrideTimeZone ${JSON.stringify(overrideTimeZone)}`,
        { cause: error },
      )
    }
  }

  /** Resolve and cache one request-local timestamp formatter. */
  const formatterFor = (selectedTimeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(selectedTimeZone)
    if (existing !== undefined) return existing
    const created = createTimestampFormatter(selectedTimeZone)
    formatters.set(selectedTimeZone, created)
    return created
  }

  const projectionReady = ctx.sessionProjections.register({
    key: 'timeContext',
    stateVersion: 3,
    stateSchema: timeContextStateSchema,
    init: () => ({
      lastMessageTime: null,
      lastInjectionTime: null,
      lastTurnInjectionTime: null,
      browserTurn: null,
      browserTimeZones: [],
    }),
    apply: (state, event) => {
      if (event.type === 'turn/start') {
        return { ...state, lastTurnInjectionTime: null, browserTurn: event.data.turn, browserTimeZones: [] }
      }
      if (event.type === 'turn/end') {
        return state.lastTurnInjectionTime === null ? state : { ...state, lastTurnInjectionTime: null }
      }
      if (event.type === 'user/message') {
        const injected = event.data.source.kind === name
        let withMessage = state.lastMessageTime === event.time
          ? state
          : { ...state, lastMessageTime: event.time }
        const timeZone = reportedBrowserTimeZone(event.data)
        if (state.browserTurn !== null && timeZone !== undefined && !state.browserTimeZones.includes(timeZone)) {
          withMessage = { ...withMessage, browserTimeZones: [...state.browserTimeZones, timeZone] }
        }
        if (!injected) return withMessage
        return {
          ...withMessage,
          lastInjectionTime: event.time,
          lastTurnInjectionTime: event.time,
        }
      }
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        return state.lastMessageTime === event.time ? state : { ...state, lastMessageTime: event.time }
      }
      return state
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const timeContextProjectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const now = Date.now()
    const state = timeContextProjectionHandle.stateOf(agent.session)
    if (refreshIntervalMs > 0) {
      const lastInjection = state.lastInjectionTime
      if (lastInjection != null
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return decision
    }
    /* v8 ignore next 3 -- every later step follows a recorded injection in the same turn */
    const previous = step === 1
      ? state.lastMessageTime ?? undefined
      : state.lastTurnInjectionTime ?? undefined
    const browser = state.browserTurn === turn
      ? deriveBrowserTimeZoneContext(decision.messages, state.browserTimeZones)
      : deriveBrowserTimeZoneContext(requestMessages(agent, turn, decision.messages))
    const selectedTimeZone = overrideTimeZoneResolved
      ?? (browser.kind === 'resolved' ? browser.timeZone : fallbackTimeZone)
    const text = renderText(
      now,
      turn,
      step,
      previous,
      formatterFor(selectedTimeZone),
      selectedTimeZone,
      includeTimeZone ? renderBrowserTimeZoneContext(browser) : undefined,
    )
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
  await projectionReady
}
