import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { expect, test, type Page } from '@playwright/test'
import { unzipSync, zipSync } from 'fflate'

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

test('deleting an image prunes saved resources while undo restores them after save', async ({
  page
}) => {
  const document = await readFile('dist/empty.fig')
  const snapshots = new Map<string, Buffer>()
  await page.route('**/todo/**', async (route) => {
    const request = route.request()
    if (request.headers().authorization !== 'Bearer todo-test-token') {
      await route.fulfill({ status: 401 })
      return
    }
    const url = new URL(request.url())
    if (url.pathname === '/todo/document') {
      await route.fulfill({ status: 200, body: document })
      return
    }
    const id = url.searchParams.get('requestId')
    const data = request.postDataBuffer()
    if (!id || !data) throw new Error('Missing snapshot')
    snapshots.set(id, data)
    await route.fulfill({ status: 204 })
  })
  await page.goto('/?embed=todo')
  const bridge = await connectHost(page)
  const imageHash = 'ab'.repeat(20)
  async function save(id: string) {
    await bridge.evaluate((b, requestId) => b.send({ type: 'op-bridge/snapshot', requestId }), id)
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/snapshot-result')?.requestId))
      .toBe(id)
    const result = await bridge.evaluate((b) => b.last('op-bridge/snapshot-result'))
    if (!result) throw new Error('Missing save metadata')
    await bridge.evaluate(
      (b, message) =>
        b.send({
          type: 'op-bridge/save-committed',
          generation: message.generation,
          revision: message.revision
        }),
      result
    )
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(false)
    const bytes = snapshots.get(id)
    if (!bytes) throw new Error('Missing saved bytes')
    return Object.keys(unzipSync(bytes)).filter((name) => name.startsWith('images/'))
  }
  try {
    await page.evaluate(async (hash) => {
      const store = window.openPencil?.getStore?.()
      if (!store) throw new Error('Editor unavailable')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve)
      })
      if (!blob) throw new Error('PNG generation failed')
      store.graph.images.set(hash, new Uint8Array(await blob.arrayBuffer()))
      const id = store.createShape('RECTANGLE', 100, 100, 200, 120)
      store.graph.updateNode(id, {
        fills: [
          {
            type: 'IMAGE',
            imageHash: hash,
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true
          }
        ]
      })
      store.select([id])
      store.requestRender()
    }, imageHash)
    expect(await save('image-present')).toEqual(['images/' + imageHash])
    await page.evaluate(() => window.openPencil?.getStore?.().deleteSelected())
    expect(await save('image-deleted')).toEqual([])
    expect(
      await page.evaluate(
        (hash) => window.openPencil?.getStore?.().graph.images.has(hash),
        imageHash
      )
    ).toBe(true)
    await page.keyboard.press('Control+z')
    expect(await save('image-restored')).toEqual(['images/' + imageHash])
  } finally {
    await bridge.evaluate((b) => b.dispose())
    await bridge.dispose()
  }
})

test('cloud document opens and saves before images finish, then loads only the active page', async ({
  page
}) => {
  let document = await readFile('dist/empty.fig')
  const snapshots = new Map<string, Buffer>()
  const imageBodies = new Map<string, Buffer>()
  const requested: string[] = []
  let releaseImages: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseImages = resolve
  })
  await page.route('**/todo/**', async (route) => {
    const request = route.request()
    if (request.headers().authorization !== 'Bearer todo-test-token')
      return route.fulfill({ status: 401 })
    const url = new URL(request.url())
    if (url.pathname === '/todo/document') return route.fulfill({ body: document })
    if (url.pathname.startsWith('/todo/images/')) {
      requested.push(url.pathname)
      await gate
      const body = imageBodies.get(url.pathname)
      return route.fulfill({ status: body ? 200 : 404, body })
    }
    const id = url.searchParams.get('requestId')
    const body = request.postDataBuffer()
    if (!id || !body) throw new Error('Missing snapshot')
    snapshots.set(id, body)
    await route.fulfill({ status: 204 })
  })
  await page.goto('/?embed=todo')
  let bridge = await connectHost(page)
  const pages = await page.evaluate(async () => {
    const store = window.openPencil?.getStore?.()
    if (!store) throw new Error('Editor unavailable')
    const first = store.state.currentPageId
    const second = store.graph.createNode('CANVAS', store.graph.rootId, { name: 'Other page' }).id
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    for (const [index, parent] of [first, second].entries()) {
      context.fillStyle = index === 0 ? '#ff0000' : '#0000ff'
      context.fillRect(0, 0, 8, 8)
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve)
      })
      if (!blob) throw new Error('Missing image')
      const hash = (index === 0 ? 'ab' : 'cd').repeat(20)
      store.graph.images.set(hash, new Uint8Array(await blob.arrayBuffer()))
      store.graph.createNode('RECTANGLE', parent, {
        name: 'Image ' + index,
        x: 100,
        y: 100,
        width: 200,
        height: 120,
        fills: [
          {
            type: 'IMAGE',
            imageHash: hash,
            color: { r: 0, g: 0, b: 0, a: 1 },
            opacity: 1,
            visible: true
          }
        ]
      })
    }
    store.requestRender()
    return { first, second }
  })
  async function save(id: string) {
    await bridge.evaluate((b, requestId) => b.send({ type: 'op-bridge/snapshot', requestId }), id)
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/snapshot-result')?.requestId))
      .toBe(id)
    const bytes = snapshots.get(id)
    if (!bytes) throw new Error('Missing saved document')
    return bytes
  }
  const entries = unzipSync(await save('seed'))
  const manifest: Record<string, { sha256: string; size: number }> = {}
  const structure: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('images/')) {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      manifest[name] = { sha256, size: bytes.length }
      imageBodies.set('/todo/images/' + sha256, Buffer.from(bytes))
    } else structure[name] = bytes
  }
  structure['todo-images.json'] = new TextEncoder().encode(
    JSON.stringify({ version: 1, images: manifest })
  )
  document = Buffer.concat([Buffer.from('todo-fig/1\n'), zipSync(structure)])
  await bridge.dispose()
  await page.reload()
  bridge = await connectHost(page)
  try {
    await expect.poll(() => requested.length).toBe(1)
    expect(await page.evaluate(() => window.openPencil?.getStore?.().graph.images.size)).toBe(0)
    await addShape(page, 'Edit before download', 400)
    const saved = await save('before-images')
    const contents = unzipSync(saved.subarray('todo-fig/1\n'.length))
    expect(JSON.parse(new TextDecoder().decode(contents['todo-images.json'])).images).toEqual(
      manifest
    )
    expect(Object.keys(contents).some((name) => name.startsWith('images/'))).toBe(false)
    const committed = await bridge.evaluate((b) => b.last('op-bridge/snapshot-result'))
    if (!committed) throw new Error('Missing snapshot revision')
    await bridge.evaluate(
      (b, message) =>
        b.send({
          type: 'op-bridge/save-committed',
          generation: message.generation,
          revision: message.revision
        }),
      committed
    )
    await expect
      .poll(() => bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty))
      .toBe(false)
    releaseImages?.()
    await expect
      .poll(() => page.evaluate(() => window.openPencil?.getStore?.().graph.images.size))
      .toBe(1)
    // The image must actually be decoded by the renderer, not merely downloaded.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.openPencil
            ?.getStore?.()
            .canvasRenderers.reduce((sum, renderer) => sum + renderer.imageCache.size, 0)
        )
      )
      .toBeGreaterThan(0)
    await expect(page.locator('canvas:visible').first()).toHaveScreenshot('todo-async-page.png')
    expect(await bridge.evaluate((b) => b.last('op-bridge/dirty-changed')?.dirty)).toBe(false)
    expect(requested).toHaveLength(1)
    await page.evaluate(async (id) => {
      const store = window.openPencil?.getStore?.()
      const target = store?.graph.getPages().find((p) => p.name === 'Other page')
      if (!store || !target) throw new Error('Second page missing ' + id)
      await store.switchPage(target.id)
    }, pages.second)
    await expect
      .poll(() => page.evaluate(() => window.openPencil?.getStore?.().graph.images.size))
      .toBe(2)
    expect(requested).toHaveLength(2)
  } finally {
    releaseImages?.()
    await bridge.dispose()
  }
})
