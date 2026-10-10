import * as v from 'valibot'
import { watch } from 'vue'

import type { Editor, EditorState } from '@open-pencil/core/editor'
import { imageResourcesReady } from '@open-pencil/core/io'
import { readFigFile } from '@open-pencil/core/io/formats/fig'
import { pruneUnusedFigImages } from '@open-pencil/fig'
import { setLocale } from '@open-pencil/vue'

import { readBoundedBody } from '@/app/document/io/browser'
import type { createDocumentChanges } from '@/app/document/io/changes'
import { applyImportedDocument } from '@/app/document/io/imported-document'
import { setAppTheme } from '@/app/shell/theme'

import { createTodoImages, readTodoDocument, writeTodoSnapshot } from './images'
import { createSnapshotOperation } from './snapshot-operation'

const messageSchema = v.object({
  type: v.string(),
  token: v.optional(v.string()),
  requestId: v.optional(v.string()),
  generation: v.optional(v.number()),
  revision: v.optional(v.number()),
  colorScheme: v.optional(v.picklist(['dark', 'light'])),
  locale: v.optional(v.string())
})

function parseMessage(event: MessageEvent): v.InferOutput<typeof messageSchema> | undefined {
  if (event.source !== window || event.origin !== location.origin || typeof event.data !== 'string')
    return undefined
  let raw: unknown
  try {
    raw = JSON.parse(event.data)
  } catch {
    return undefined
  }
  const result = v.safeParse(messageSchema, raw)
  if (!result.success) return undefined
  return result.output
}

type BridgeOptions = {
  editor: Editor
  state: EditorState & { documentName: string }
  changes: ReturnType<typeof createDocumentChanges>
  buildFigFile: () => Promise<Uint8Array>
}

/** Control messages travel over the WebView bridge; .fig bytes stay on loopback HTTP. */
export function createTodoBridge({ editor, state, changes, buildFigFile }: BridgeOptions) {
  const generation = crypto.getRandomValues(new Uint32Array(1))[0]
  const abort = new AbortController()
  let token: string | null = null
  let initializing = false
  let opening = false
  let opened = false
  let activeSnapshot:
    | { requestId: string; operation: ReturnType<typeof createSnapshotOperation> }
    | undefined
  let exportedRevision: number | null = null
  let source: ReturnType<typeof readTodoDocument> | undefined
  let images: ReturnType<typeof createTodoImages> | undefined

  function post(message: Record<string, unknown>) {
    if (!abort.signal.aborted) window.postMessage(JSON.stringify(message), location.origin)
  }

  function dirtyChanged() {
    if (opened)
      post({
        type: 'op-bridge/dirty-changed',
        generation,
        revision: changes.capture(),
        dirty: changes.hasUnsavedChanges()
      })
  }

  async function request(path: string, options: RequestInit = {}) {
    if (!token) throw new Error('Todo bridge is not initialized')
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(path, {
      ...options,
      signal: options.signal ?? abort.signal,
      headers
    })
    if (!response.ok) throw new Error(`Todo document request failed (${response.status})`)
    return response
  }

  async function openDocument() {
    if (opened || opening) return
    opening = true
    const started = performance.now()
    const trace = (stage: string) => {
      const elapsedMs = Math.round(performance.now() - started)
      console.debug('[Todo load]', { stage, elapsedMs })
      post({ type: 'op-bridge/load-progress', stage, elapsedMs })
    }
    try {
      trace('download-start')
      const response = await request('/todo/document')
      const bytes = await readBoundedBody(response, 256 * 1024 * 1024)
      trace('download-complete')
      source = readTodoDocument(bytes)
      trace('parse-start')
      const graph = await readFigFile(new File([new Uint8Array(source.bytes)], 'document.fig'), {
        populate: 'first-page',
        signal: abort.signal
      })
      abort.signal.throwIfAborted()
      trace('parse-complete')
      trace('apply-start')
      await applyImportedDocument(editor, graph)
      abort.signal.throwIfAborted()
      trace('apply-complete')
      if (source.external)
        images = createTodoImages(editor, source.manifest, request, abort.signal, (error) => {
          post({
            type: 'op-bridge/error',
            message: error instanceof Error ? error.message : String(error)
          })
        })
      state.documentName = 'document'
      changes.markSaved()
      opened = true
      editor.requestRender()
      post({ type: 'op-bridge/opened', generation })
      dirtyChanged()
      images?.loadPage(state.currentPageId)
    } finally {
      opening = false
    }
  }

  async function snapshot(requestId: string | undefined) {
    if (!opened || activeSnapshot || !requestId)
      throw new Error('Editor is not ready for a snapshot')
    const operation = createSnapshotOperation()
    activeSnapshot = { requestId, operation }
    const started = performance.now()
    const trace = (stage: string, bytes?: number) => {
      const elapsedMs = Math.round(performance.now() - started)
      console.debug('[Todo save]', { requestId, stage, elapsedMs, bytes })
      post({ type: 'op-bridge/snapshot-progress', requestId, stage, elapsedMs, bytes })
    }
    try {
      await operation.run(async () => {
        const revision = changes.capture()
        trace('export-start')
        const exported = await buildFigFile()
        operation.signal.throwIfAborted()
        trace('export-complete', exported.byteLength)
        const bytes = source?.external
          ? writeTodoSnapshot(
              exported,
              source.manifest,
              imageResourcesReady(editor.graph) ? undefined : source.thumbnail
            )
          : pruneUnusedFigImages(exported)
        // Export may await lazy pages/fonts. Never commit a mixed or stale revision.
        if (revision !== changes.capture()) {
          post({ type: 'op-bridge/snapshot-conflict', requestId: requestId })
          return
        }
        trace('upload-start', bytes.byteLength)
        await request(`/todo/snapshot?requestId=${encodeURIComponent(requestId)}`, {
          method: 'PUT',
          body: new Uint8Array(bytes),
          signal: operation.signal
        })
        operation.signal.throwIfAborted()
        trace('upload-complete', bytes.byteLength)
        exportedRevision = revision
        post({ type: 'op-bridge/snapshot-result', requestId, generation, revision })
      })
    } catch (error) {
      trace('failed')
      throw error
    } finally {
      operation.dispose()
      activeSnapshot = undefined
    }
  }

  async function initialize(newToken: string | undefined) {
    if (!newToken || token || initializing) return
    initializing = true
    token = newToken
    try {
      // Authenticate before advertising readiness. Do not retain a caller's invalid token.
      await request('/todo/document', { method: 'GET' }).then((r) => r.body?.cancel())
      post({ type: 'op-bridge/ready', protocolVersion: 1 })
    } catch (error) {
      token = null
      throw error
    } finally {
      initializing = false
    }
  }

  function cancelSnapshot(requestId: string | undefined) {
    if (activeSnapshot && activeSnapshot.requestId === requestId) activeSnapshot.operation.cancel()
  }

  async function receive(event: MessageEvent) {
    const message = parseMessage(event)
    if (!message) return
    try {
      if (message.type === 'op-bridge/init') {
        await initialize(message.token)
        return
      }
      if (!token || initializing) return
      switch (message.type) {
        case 'op-bridge/theme':
          if (message.colorScheme) setAppTheme(message.colorScheme)
          break
        case 'op-bridge/locale':
          setLocale(message.locale === 'zh-CN' ? 'zh-CN' : 'en')
          break
        case 'op-bridge/open-document':
          await openDocument()
          break
        case 'op-bridge/snapshot-cancel':
          cancelSnapshot(message.requestId)
          break
        case 'op-bridge/snapshot':
          await snapshot(message.requestId)
          break
        case 'op-bridge/save-committed':
          if (message.generation === generation && message.revision === exportedRevision) {
            changes.markSaved(exportedRevision)
            exportedRevision = null
            dirtyChanged()
          }
          break
      }
    } catch (error) {
      if (abort.signal.aborted) return
      post({
        type:
          message.type === 'op-bridge/snapshot' ? 'op-bridge/snapshot-error' : 'op-bridge/error',
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const stopPage = editor.onEditorEvent('page:changed', (pageId) => images?.loadPage(pageId))
  const stopHistory = editor.onEditorEvent('history:changed', () =>
    images?.loadPage(state.currentPageId)
  )
  const onMessage = (event: MessageEvent) => {
    void receive(event)
  }
  const stop = watch(() => [changes.capture(), changes.hasUnsavedChanges()], dirtyChanged, {
    flush: 'sync'
  })
  window.addEventListener('message', onMessage)
  post({ type: 'op-bridge/listening' })
  return {
    requestSave: async () => {
      if (opened) post({ type: 'op-shell/save' })
      return false
    },
    dispose() {
      activeSnapshot?.operation.cancel()
      abort.abort()
      stop()
      stopPage()
      stopHistory()
      images?.dispose()
      window.removeEventListener('message', onMessage)
    }
  }
}
