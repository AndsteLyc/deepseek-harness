import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const driver = fileURLToPath(new URL('./fixtures/standard-preset-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/standard-preset.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function journalPaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return journalPaths(path)
    return entry.name.endsWith('.jsonl') ? [path] : []
  }))).flat()
}

function expectClockOnly(text: string): void {
  expect(text.split('\n')).toHaveLength(2)
  expect(text).toMatch(/^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00\[Asia\/Shanghai\]\n/)
  expect(text).toContain('Elapsed since the preceding model-visible message:')
  expect(text).not.toContain('Browser time zone for this request:')
}

it('keeps the shipped standard preset clock without the browser policy in requests and logs', async () => {
  const { stderr } = await runLoaderSmoke({
    label: 'standard preset time-context',
    tempDirPrefix: 'standard-preset-clock-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath,
    env: { TZ: 'Asia/Shanghai', DSH_TELEMETRY_DISABLED: '1' },
    inspect: async (cwd) => {
      const requests = JSON.parse(await readFile(join(cwd, 'standard-preset-request.json'), 'utf8')) as RequestMessage[]
      const readings = requests.filter(message => message.source?.kind === 'time-context')
      expect(readings).toHaveLength(1)
      const requestText = readings[0]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      expectClockOnly(requestText)

      const logs = await journalPaths(join(cwd, '.sessions'))
      expect(logs).toHaveLength(1)
      const lines = (await readFile(logs[0]!, 'utf8')).trimEnd().split('\n')
      expect(JSON.parse(lines[0]!)).toMatchObject({ agentPreset: 'standard' })
      const events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      const persisted = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'time-context')
      expect(persisted).toHaveLength(1)
      const event = persisted[0]!
      if (event.type !== 'user/message') throw new Error('missing persisted clock')
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      expectClockOnly(text)
      expect(text).toBe(requestText)
      expect(event.data.source).toMatchObject({ sections: [{ name: 'time-context', text }] })
      expect(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
