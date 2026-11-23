// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { act, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { expect, onTestFinished } from 'vitest'

type ActionProps = InjectFace<{ hooks: { available: HostObservable<boolean> } }>

function LauncherAction({ useAvailable }: ActionProps) {
  return useAvailable(value => value) ? <button type="button">Launcher action</button> : null
}

const it = createClientTest({
  roster: webApp.without(['@deepseek-ai/dsh-client-ui-settings-models']),
}, { mount: true })

it('keeps a launcher action before a portal appended while the action is hidden', async ({ start }) => {
  const c = await start()
  const outlet = document.querySelector('[data-slot="settings.launcher.action"]')
  const row = document.querySelector('[data-slot="settings.launcher"]')?.parentElement
  expect(outlet?.parentElement).toBe(row)
  if (!row || !outlet) throw new Error('Expected the settings launcher row and action outlet')
  expect(row.lastElementChild).toBe(outlet)

  const available = createSnapshotStore(false)
  const plugin = c.ctx.plugin({
    name: 'test-launcher-action', inject: ['slots'],
    apply(ctx: Context) {
      ctx.slots.inject('settings.launcher.action', () => ctx.slots.register({
        name: 'settings.launcher.action', id: 'test-launcher-action',
        inject: () => ({ hooks: { available } }),
      }, LauncherAction))
    },
  })
  await act(async () => { await plugin })
  expect(outlet.childElementCount).toBe(0)

  const portalHost = row.appendChild(document.createElement('span'))
  const portal = render(createPortal(<button type="button">Remote action</button>, portalHost))
  onTestFinished(() => { portal.unmount(); portalHost.remove() })

  act(() => { available.set(true) })
  expect(outlet.contains(screen.getByRole('button', { name: 'Launcher action' }))).toBe(true)
  expect(outlet.nextElementSibling).toBe(portalHost)
  expect(portalHost.contains(screen.getByRole('button', { name: 'Remote action' }))).toBe(true)
}, 60_000)
