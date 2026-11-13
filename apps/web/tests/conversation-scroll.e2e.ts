/** Conversation scrollports keep the surrounding window stationary. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture, watchConsole } from './scaffold.ts'
import { openSettings } from './support.ts'

async function expectStationaryPage(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo(0, 100)
    document.body.scrollTop = 100
    return {
      viewport: innerHeight,
      page: document.documentElement.scrollHeight,
      top: document.querySelector('#root')!.getBoundingClientRect().top,
      scroll: scrollY,
      bodyScroll: document.body.scrollTop,
    }
  })).toEqual({ viewport: page.viewportSize()!.height, page: page.viewportSize()!.height,
    top: 0, scroll: 0, bodyScroll: 0 })
}

it('contains inline plugin filter overflow without blocking panels or composer scrolling', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const fixture = await selectedSessionFixture(fileURLToPath(
    new URL('../../../snapshots/web/goal-multi-turn-actions/session.v3.jsonl', import.meta.url),
  ))
  await seedSession(scaffold, await readFile(fixture, 'utf8'), 'conversation-scroll')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1896, height: 1153 }, locale: 'en-US' })
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.locator('[data-turn-process]').first().waitFor()
  await page.evaluate(() => {
    // Legacy plugins append inline SVG filter definitions beside the shell.
    // Even a zero-size SVG creates a line box after the full-height root.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.setAttribute('aria-hidden', 'true')
    svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'defs'))
    document.body.append(svg)
  })

  for (const platform of ['darwin', 'windows', 'browser']) {
    await page.evaluate((value) => {
      document.documentElement.removeAttribute('data-platform')
      document.documentElement.toggleAttribute('data-windows-titlebar', value === 'windows')
      if (value === 'darwin') document.documentElement.setAttribute('data-platform', value)
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
    }, platform)
    for (const viewport of [{ width: 1896, height: 1153 }, { width: 800, height: 600 }, { width: 740, height: 600 }]) {
      await page.setViewportSize(viewport)
      await expectStationaryPage(page)
      const scroll = page.locator('[data-conversation-scroll]')
      await scroll.evaluate((element) => { element.scrollTop = 0 })
      const box = await scroll.boundingBox()
      if (box === null) throw new Error('conversation has no scrollport')
      await page.mouse.move(box.x + box.width / 2, box.y + 80)
      await page.mouse.wheel(0, 400)
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await expectStationaryPage(page)
    }
  }

  await page.setViewportSize({ width: 1896, height: 1153 })
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.fill(Array.from({ length: 40 }, (_, index) => `Draft line ${String(index + 1)}`).join('\n'))
  const draft = page.locator('[data-input-scroll]')
  await expect.poll(() => draft.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
  await draft.evaluate((element) => { element.scrollTop = 0 })
  await input.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => draft.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expectStationaryPage(page)
  await input.fill('')
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-panel]').waitFor()
  await page.getByText('Built-in plugin settings', { exact: true }).waitFor()
  await expectStationaryPage(page)
  await openSettings(page, 'en')
  await page.getByRole('dialog').waitFor()
  await expectStationaryPage(page)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  expect(console.pageErrors).toEqual([])
})
