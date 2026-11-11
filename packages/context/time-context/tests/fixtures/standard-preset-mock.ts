/** Capture the actual model request from the assembled standard preset. */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class StandardPresetClockAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.messages.some(message => message.source?.kind === 'time-context')) {
      await writeFile('standard-preset-request.json', JSON.stringify(options.messages))
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Clock received.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'standard-preset-clock-mock'
export const inject = ['llm']

/** Register the deterministic adapter for this isolated process. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['standard-preset-clock-mock'], new StandardPresetClockAdapter())
}
