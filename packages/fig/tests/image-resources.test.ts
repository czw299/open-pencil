import { beforeAll, expect, test } from 'bun:test'

import { deflateSync, unzipSync, zipSync } from 'fflate'

import {
  createNodeChangesMessage,
  encodeMessage,
  getSchemaBytes,
  initCodec,
  type NodeChange
} from '@open-pencil/kiwi/fig/codec'

import { collectImageReferences } from '../src/image-references'
import { pruneUnusedFigImages, writeFigArchive } from '../src/index'

beforeAll(() => initCodec())

const hash = (byte: number) => byte.toString(16).padStart(2, '0').repeat(20)
const source = (byte: number) => ({ hash: new Uint8Array(20).fill(byte) })
function archive(changes: NodeChange[]) {
  return writeFigArchive({
    schemaDeflated: deflateSync(getSchemaBytes()),
    kiwiData: encodeMessage(createNodeChangesMessage(0, 0, changes)),
    thumbnailPNG: new Uint8Array([1, 2, 3]),
    metaJSON: '{"preserve":"metadata"}',
    images: [1, 2, 3, 4, 5, 6].map((n) => ({
      name: 'images/' + hash(n),
      data: new Uint8Array([n])
    }))
  })
}

test('retains references in nested overrides, unknown fields and byte/string representations', () => {
  const available = new Set([hash(1), hash(2), hash(3), hash(4)])
  expect(
    collectImageReferences(
      {
        symbolOverrides: [{ nested: { imageThumbnail: source(1), animatedImage: source(2) } }],
        unknownFutureField: { hash: [...new Uint8Array(20).fill(3)] },
        pluginIdentifier: hash(4)
      },
      available
    )
  ).toEqual(available)
})

test('prunes only unused resources across serialized paints and hidden pages without rewriting canvas', () => {
  const original = archive([
    {
      guid: { sessionID: 0, localID: 1 },
      type: 'CANVAS',
      visible: false,
      backgroundPaints: [{ type: 'IMAGE', image: source(1) }]
    },
    {
      guid: { sessionID: 0, localID: 2 },
      type: 'RECTANGLE',
      visible: false,
      fillPaints: [
        { type: 'IMAGE', image: source(2), imageThumbnail: source(3), animatedImage: source(4) }
      ],
      strokePaints: [{ type: 'IMAGE', image: source(5) }]
    }
  ])
  const entries = unzipSync(original)
  entries['unknown.bin'] = new Uint8Array([9, 7, 5])
  const complete = zipSync(entries)
  const cleaned = unzipSync(pruneUnusedFigImages(complete))
  expect(
    Object.keys(cleaned)
      .filter((n) => n.startsWith('images/'))
      .sort()
  ).toEqual([1, 2, 3, 4, 5].map((n) => 'images/' + hash(n)))
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith('images/')) expect(cleaned[name]).toEqual(data)
  }
  expect(unzipSync(complete)['images/' + hash(6)]).toBeDefined()
})

test('removes the last image and leaves the source archive intact for undo', () => {
  const original = archive([{ guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT' }])
  const cleaned = pruneUnusedFigImages(original)
  expect(Object.keys(unzipSync(cleaned)).filter((n) => n.startsWith('images/'))).toEqual([])
  expect(Object.keys(unzipSync(original)).filter((n) => n.startsWith('images/'))).toHaveLength(6)
  expect(pruneUnusedFigImages(cleaned)).toBe(cleaned)
  const raw = unzipSync(original)['canvas.fig']
  expect(raw).toBeDefined()
  if (raw) expect(pruneUnusedFigImages(raw)).toBe(raw)
})
