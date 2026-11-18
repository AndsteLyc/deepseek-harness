/** Restore the primary window in Electron's display coordinates before it is shown. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { screen, type BrowserWindow, type Rectangle, type Size } from 'electron'
import { z } from 'zod'

const point = z.object({ x: z.int32(), y: z.int32() })
const placement = z.object({
  bounds: point.extend({ width: z.int32().positive(), height: z.int32().positive() }),
  displayId: z.int(),
  displayOrigin: point,
})

function placementPath(userData: string): string {
  return join(userData, 'desktop', 'window-placement.json')
}

/**
 * Restore normal bounds on the original display, or fit them to the nearest surviving display.
 * @param userData - Electron userData directory.
 * @param minimum - Normal window minimum, reduced only to fit the display.
 * @returns Bounds for window creation, or undefined to use defaults if the record is unavailable.
 */
export function restoreWindowBounds(userData: string, minimum: Size): Rectangle | undefined {
  let saved: z.infer<typeof placement>
  try {
    const value: unknown = JSON.parse(readFileSync(placementPath(userData), 'utf8'))
    const result = placement.safeParse(value)
    if (!result.success) throw new Error('invalid window placement fields')
    saved = result.data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop window placement: using default bounds because the saved placement could not be read',
        error instanceof SyntaxError ? 'invalid JSON' : error)
    }
    return undefined
  }

  const { bounds, displayOrigin } = saved
  const original = screen.getAllDisplays().find(display => display.id === saved.displayId)
  const { workArea } = original ?? screen.getDisplayNearestPoint({
    x: Math.min(0x7fffffff, bounds.x + Math.floor(bounds.width / 2)),
    y: Math.min(0x7fffffff, bounds.y + Math.floor(bounds.height / 2)),
  })
  const x = bounds.x + (original === undefined ? 0 : original.bounds.x - displayOrigin.x)
  const y = bounds.y + (original === undefined ? 0 : original.bounds.y - displayOrigin.y)
  const width = Math.min(Math.max(bounds.width, minimum.width), workArea.width)
  const height = Math.min(Math.max(bounds.height, minimum.height), workArea.height)
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width,
    height,
  }
}

/**
 * Save normal bounds after moves and resizes settle, once the main window has been shown.
 * @param userData - Electron userData directory.
 * @param window - Initially hidden main window with listeners and timer owned by its lifetime.
 * @returns A callback that saves the final bounds synchronously at quit and stops autosaving. Write failures are logged.
 */
export function trackWindowBounds(userData: string, window: BrowserWindow): () => void {
  const path = placementPath(userData)
  let shown = false
  let pending: ReturnType<typeof setTimeout> | undefined
  let lastSaved: string | undefined
  const save = (): void => {
    if (!shown || window.isDestroyed()) return
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const bounds = window.getNormalBounds()
      const { id, bounds: { x, y } } = screen.getDisplayMatching(bounds)
      const state = { bounds, displayId: id, displayOrigin: { x, y } } satisfies z.infer<typeof placement>
      const contents = `${JSON.stringify(state)}\n`
      if (contents === lastSaved) return
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
      lastSaved = contents
    } catch (error) {
      console.warn('desktop window placement: could not save bounds for the next startup', error)
      try { rmSync(temporary, { force: true }) } catch (cleanupError) {
        console.warn('desktop window placement: could not remove temporary file', cleanupError)
      }
    }
  }
  const scheduleSave = (): void => {
    if (!shown) return
    clearTimeout(pending)
    pending = setTimeout(save, 250)
  }
  window.once('show', () => { shown = true })
  window.on('move', scheduleSave)
  window.on('resize', scheduleSave)
  window.once('closed', () => { clearTimeout(pending) })
  return () => {
    clearTimeout(pending)
    save()
    shown = false
  }
}
