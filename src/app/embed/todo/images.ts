import { limitAsync } from 'es-toolkit/promise'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import * as v from 'valibot'

import type { Editor } from '@open-pencil/core/editor'
import { registerImageResources, referencedImageResources } from '@open-pencil/core/io'
import { collectImageReferences, parseFigBuffer } from '@open-pencil/fig'

import { readBoundedBody } from '@/app/document/io/browser'

const HEADER = 'todo-fig/1\n'
const MANIFEST = 'todo-images.json'
const MAX_BYTES = 256 * 1024 * 1024
const manifestSchema = v.object({
  version: v.literal(1),
  images: v.record(
    v.pipe(v.string(), v.regex(/^images\/[^/\\]+$/)),
    v.object({
      sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
      size: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_BYTES))
    })
  )
})
type Manifest = v.InferOutput<typeof manifestSchema>['images']

export function readTodoDocument(bytes: Uint8Array) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, HEADER.length))
  if (!prefix.startsWith('todo-fig/'))
    return {
      bytes,
      manifest: {} as Manifest,
      thumbnail: undefined as Uint8Array | undefined,
      external: false
    }
  if (prefix !== HEADER) throw new Error('Unsupported Todo document version')
  const entries = unzipSync(bytes.subarray(HEADER.length))
  const manifest = v.parse(
    manifestSchema,
    JSON.parse(new TextDecoder().decode(entries[MANIFEST]))
  ).images
  let total = Object.values(entries).reduce((sum, data) => sum + data.length, 0)
  for (const [name, info] of Object.entries(manifest)) if (!entries[name]) total += info.size
  if (total > MAX_BYTES) throw new Error('Oversized Todo image resources')
  const output: Zippable = {}
  for (const [name, data] of Object.entries(entries))
    if (name !== MANIFEST) output[name] = [data, { level: 0 }]
  return { bytes: zipSync(output), manifest, thumbnail: entries['thumbnail.png'], external: true }
}

/** Keep external references even when their bytes have never been requested. */
export function writeTodoSnapshot(
  bytes: Uint8Array,
  manifest: Manifest,
  thumbnail?: Uint8Array
): Uint8Array {
  const entries = unzipSync(bytes)
  const names = new Set(Object.keys(manifest).map((name) => name.slice(7)))
  for (const name of Object.keys(entries)) if (name.startsWith('images/')) names.add(name.slice(7))
  const { nodeChanges } = parseFigBuffer(new Uint8Array(bytes).buffer)
  const referenced = collectImageReferences(nodeChanges, names)
  const retained: Manifest = {}
  for (const [name, info] of Object.entries(manifest))
    if (referenced.has(name.slice(7))) retained[name] = info
  const output: Zippable = {}
  for (const [name, data] of Object.entries(entries)) {
    if (
      name.startsWith('images/') &&
      (Object.hasOwn(manifest, name) || !referenced.has(name.slice(7)))
    )
      continue
    output[name] = [name === 'thumbnail.png' && thumbnail ? thumbnail : data, { level: 0 }]
  }
  output[MANIFEST] = new TextEncoder().encode(JSON.stringify({ version: 1, images: retained }))
  const archive = zipSync(output)
  const result = new Uint8Array(HEADER.length + archive.length)
  result.set(new TextEncoder().encode(HEADER))
  result.set(archive, HEADER.length)
  return result
}

function retryDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Image request cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function createTodoImages(
  editor: Editor,
  manifest: Manifest,
  request: (path: string) => Promise<Response>,
  signal: AbortSignal,
  onError: (error: unknown) => void
) {
  const graph = editor.graph
  const known = new Set(Object.keys(manifest).map((name) => name.slice(7)))
  const pending = new Map<string, Promise<void>>()
  const fetchImage = limitAsync(async (hash: string) => {
    signal.throwIfAborted()
    if (!Object.hasOwn(manifest, `images/${hash}`)) return
    const info = manifest[`images/${hash}`]
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bytes = await readBoundedBody(await request(`/todo/images/${info.sha256}`), info.size)
        if (bytes.length !== info.size) throw new Error('Incomplete Todo image')
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
        if ([...digest].map((b) => b.toString(16).padStart(2, '0')).join('') !== info.sha256)
          throw new Error('Corrupt Todo image')
        signal.throwIfAborted()
        if (editor.graph !== graph) throw new Error('Image document changed')
        graph.images.set(hash, bytes)
        for (const renderer of editor.canvasRenderers) renderer.invalidateAllPictures()
        editor.requestRender()
        return
      } catch (error) {
        signal.throwIfAborted()
        lastError = error
        if (attempt < 2) await retryDelay(signal, 300 * (attempt + 1))
      }
    }
    throw lastError
  }, 4)
  function load(hash: string): Promise<void> {
    if (graph.images.has(hash) || !known.has(hash)) return Promise.resolve()
    const active = pending.get(hash)
    if (active) return active
    const task = fetchImage(hash).finally(() => pending.delete(hash))
    pending.set(hash, task)
    return task
  }
  const unregister = registerImageResources(graph, { hashes: known, load })
  function loadPage(pageId: string) {
    for (const hash of referencedImageResources(graph, [pageId])) {
      void load(hash).catch((error: unknown) => {
        if (!signal.aborted) onError(error)
      })
    }
  }
  return { loadPage, dispose: unregister }
}
