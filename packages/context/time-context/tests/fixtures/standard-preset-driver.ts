/** Drive the shipped Web standard preset without a browser or HTTP listener. */
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('standard preset driver requires an overlay path')
const ctx = await bootProductionProfile({
  binName: 'standard-preset-time-context-test',
  profile: 'web',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
try {
  const handle = await ctx.agents.create({
    sessionId: SessionId('standard-preset-time-context'),
    meta: { cwd: process.cwd(), agentPreset: 'standard' },
    agentOptions: { provider: 'standard-preset-clock-mock', model: 'mock' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Read the clock.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
}
