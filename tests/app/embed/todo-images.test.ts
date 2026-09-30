import { beforeAll, expect, test } from 'bun:test'

import { deflateSync, unzipSync, zipSync } from 'fflate'

import { writeFigArchive } from '@open-pencil/fig'
import {
  createNodeChangesMessage,
  encodeMessage,
  getSchemaBytes,
  initCodec
} from '@open-pencil/kiwi/fig/codec'

import { readTodoDocument, writeTodoSnapshot } from '@/app/embed/todo/images'

beforeAll(() => initCodec())
const hash = 'ab'.repeat(20)
const manifest = { ['images/' + hash]: { sha256: 'cd'.repeat(32), size: 100 } }
function fig(referenced: boolean) {
  return writeFigArchive({
    schemaDeflated: deflateSync(getSchemaBytes()),
    kiwiData: encodeMessage(
      createNodeChangesMessage(0, 0, [
        {
          guid: { sessionID: 0, localID: 1 },
          type: 'CANVAS',
          visible: false,
          backgroundPaints: referenced
            ? [{ type: 'IMAGE', image: { hash: new Uint8Array(20).fill(171) } }]
            : []
        }
      ])
    ),
    thumbnailPNG: new Uint8Array([1, 2, 3]),
    metaJSON: '{}'
  })
}

test('unloaded references survive saves, deletion prunes them, and undo retains the session mapping', () => {
  const snapshot = writeTodoSnapshot(fig(true), manifest)
  const reopened = readTodoDocument(snapshot)
  expect(reopened.manifest).toEqual(manifest)
  expect(Object.keys(unzipSync(reopened.bytes)).some((name) => name.startsWith('images/'))).toBe(
    false
  )
  expect(readTodoDocument(writeTodoSnapshot(fig(false), manifest)).manifest).toEqual({})
  expect(readTodoDocument(writeTodoSnapshot(fig(true), manifest)).manifest).toEqual(manifest)
})

test('new images stay embedded for crash recovery; old thumbnail is preserved while loading', () => {
  const entries = unzipSync(fig(true))
  entries['images/' + hash] = new Uint8Array([8, 9])
  const result = readTodoDocument(writeTodoSnapshot(zipSync(entries), {}, new Uint8Array([7])))
  expect(unzipSync(result.bytes)['images/' + hash]).toEqual(new Uint8Array([8, 9]))
  expect(result.thumbnail).toEqual(new Uint8Array([7]))
})

test('plain fig files remain unchanged and unsupported cloud versions fail visibly', () => {
  const bytes = fig(true)
  expect(readTodoDocument(bytes).bytes).toBe(bytes)
  expect(readTodoDocument(bytes).external).toBe(false)
  expect(() => readTodoDocument(new TextEncoder().encode('todo-fig/2\n'))).toThrow()
})
