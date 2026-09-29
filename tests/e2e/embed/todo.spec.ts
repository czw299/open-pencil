import { readFile } from 'node:fs/promises'

import { expect, test, type Page } from '@playwright/test'

// The production bundle is tested against the same binary HTTP and message contract as Flutter.
async function connectHost(page: Page) {
  await page.waitForFunction(() => !!window.openPencil?.getStore?.())
  const bridge = await page.evaluateHandle(() => {
    const messages: Record<string, unknown>[] = []
    const receive = (event: MessageEvent) => {
      if (event.source !== window || typeof event.data !== 'string') return
      try {
        messages.push(JSON.parse(event.data))
      } catch {
        console.warn('Ignoring a non-JSON window message')
      }
    }
    window.addEventListener('message', receive)
    return {
      send: (message: Record<string, unknown>) =>
        window.postMessage(JSON.stringify(message), location.origin),
      last: (type: string) => messages.findLast((message) => message.type === type),
      dispose: () => window.removeEventListener('message', receive)
    }
  })
  await bridge.evaluate((b) => b.send({ type: 'op-bridge/init', token: 'todo-test-token' }))
  await expect
    .poll(() => bridge.evaluate((b) => b.last('op-bridge/ready')?.protocolVersion))
    .toBe(1)
  await bridge.evaluate((b) => b.send({ type: 'op-bridge/open-document' }))
  await expect
    .poll(() => bridge.evaluate((b) => b.last('op-bridge/opened')?.generation))
    .toEqual(expect.any(Number))
  return bridge
}

async function addShape(page: Page, name: string, offset: number) {
  await page.evaluate(
    ({ name, offset }) => {
      const store = window.openPencil?.getStore?.()
      if (!store) throw new Error('Editor unavailable')
      const id = store.createShape('RECTANGLE', offset, 100, 200, 120)
      store.graph.updateNode(id, { name })
      store.select([id])
      store.requestRender()
    },
    { name, offset }
  )
}

test('host saves binary .fig, preserves edits during upload, and reopens the saved document', async ({
  page
}) => {
  let document = await readFile('dist/empty.fig')
  const snapshots = new Map<string, Buffer>()
  await page.route('**/todo/**', async (route) => {
    const request = route.request()
    if (request.headers().authorization !== 'Bearer todo-test-token') {
      await route.fulfill({ status: 401 })
      return
    }
    const url = new URL(request.url())
    if (url.pathname === '/todo/document') {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: document })
      return
    }
    const id = url.searchParams.get('requestId')
    const data = request.postDataBuffer()
    if (!id || !data) throw new Error('Missing snapshot request')
    snapshots.set(id, data)
    await route.fulfill({ status: 204 })
  })
  await page.goto('/?embed=todo')
  const bridge = await connectHost(page)
  try {
    await expect(page.getByTestId('app-logo')).toHaveCount(0)
    await addShape(page, 'Saved rectangle', 100)
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(true)
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-shell/save')?.type))
      .toBe('op-shell/save')
    await bridge.evaluate((b) => b.send({ type: 'op-bridge/snapshot', requestId: 'save-1' }))
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/snapshot-result')?.requestId))
      .toBe('save-1')
    const snapshot = await bridge.evaluate((b) => b.last('op-bridge/snapshot-result'))
    if (!snapshot) throw new Error('Missing snapshot')
    expect(snapshots.get('save-1')?.subarray(0, 2).toString()).toBe('PK')
    // The upload has not been acknowledged. Additional edits must survive its completion.
    await addShape(page, 'Later rectangle', 400)
    await bridge.evaluate(
      (b, s) =>
        b.send({
          type: 'op-bridge/save-committed',
          generation: s.generation,
          revision: s.revision
        }),
      snapshot
    )
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(true)
    await bridge.evaluate((b) => b.send({ type: 'op-bridge/snapshot', requestId: 'save-2' }))
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/snapshot-result')?.requestId))
      .toBe('save-2')
    const finalSnapshot = await bridge.evaluate((b) => b.last('op-bridge/snapshot-result'))
    if (!finalSnapshot) throw new Error('Missing final snapshot')
    await bridge.evaluate(
      (b, s) =>
        b.send({
          type: 'op-bridge/save-committed',
          generation: s.generation,
          revision: s.revision
        }),
      finalSnapshot
    )
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(false)
    const saved = snapshots.get('save-2')
    if (!saved) throw new Error('Missing binary document')
    document = saved
    await page.screenshot({ path: 'scratch/todo-embed.png' })
  } finally {
    await bridge.evaluate((b) => b.dispose())
    await bridge.dispose()
  }
  await page.reload()
  const reopened = await connectHost(page)
  try {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = window.openPencil?.getStore?.()
          return store
            ? Array.from(store.graph.getAllNodes())
                .filter((n) => n.type === 'RECTANGLE')
                .map((n) => n.name)
                .sort()
            : []
        })
      )
      .toEqual(['Later rectangle', 'Saved rectangle'])
    await expect
      .poll(() => reopened.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(false)
    await page.keyboard.press('Control+t')
    await expect(page.getByTestId('layers-panel')).toBeVisible()
  } finally {
    await reopened.evaluate((b) => b.dispose())
    await reopened.dispose()
  }
})
