import { expect, test } from 'bun:test'

import { createEditor } from '@open-pencil/core/editor'
import {
  ensureImageResources,
  registerImageResources,
  referencedImageResources
} from '@open-pencil/core/io'
import { exportFigFile } from '@open-pencil/core/io/formats/fig'
import { parseFigBuffer } from '@open-pencil/fig'
import { SceneGraph } from '@open-pencil/scene-graph'

const hash = 'ab'.repeat(20)
const otherHash = 'cd'.repeat(20)
function document() {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]
  const node = graph.createNode('RECTANGLE', page.id, {
    width: 100,
    height: 100,
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
  let requests = 0
  const dispose = registerImageResources(graph, {
    hashes: new Set([hash, otherHash]),
    load: async (key) => {
      requests++
      graph.images.set(key, new Uint8Array([1, 2, 3]))
    }
  })
  return { graph, node, page, requests: () => requests, dispose }
}

test('page loading selects only referenced resources without editing the document', async () => {
  const doc = document()
  const editor = createEditor({ graph: doc.graph })
  let edits = 0
  const stop = editor.onEditorEvent('node:updated', () => {
    edits++
  })
  expect(referencedImageResources(doc.graph, [doc.page.id])).toEqual(new Set([hash]))
  await ensureImageResources(doc.graph, referencedImageResources(doc.graph, [doc.page.id]))
  expect(doc.requests()).toBe(1)
  expect(edits).toBe(0)
  stop()
  doc.dispose()
  editor.dispose()
})

test('Todo snapshots omit external bytes while standalone exports include them', async () => {
  const doc = document()
  const partial = await exportFigFile(doc.graph, undefined, undefined, undefined, false, true)
  expect(doc.requests()).toBe(0)
  expect(parseFigBuffer(new Uint8Array(partial).buffer).images).toHaveLength(0)
  const complete = await exportFigFile(doc.graph)
  expect(doc.requests()).toBe(2)
  expect(parseFigBuffer(new Uint8Array(complete).buffer).images).toHaveLength(2)
  const hydratedSnapshot = await exportFigFile(
    doc.graph,
    undefined,
    undefined,
    undefined,
    false,
    true
  )
  expect(parseFigBuffer(new Uint8Array(hydratedSnapshot).buffer).images).toHaveLength(0)
  doc.dispose()
})

test('clipboard waits for referenced images and includes their bytes', async () => {
  const doc = document()
  const editor = createEditor({ graph: doc.graph })
  editor.select([doc.node.id])
  const payload = await editor.prepareCopy()
  expect(payload.snapshot?.images.has(hash)).toBe(true)
  expect(doc.requests()).toBe(1)
  doc.dispose()
  editor.dispose()
})
