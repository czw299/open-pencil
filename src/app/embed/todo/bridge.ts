import * as v from 'valibot'
import { watch } from 'vue'

import type { Editor, EditorState } from '@open-pencil/core/editor'
import { readFigFile } from '@open-pencil/core/io/formats/fig'
import { setLocale } from '@open-pencil/vue'

import { readBoundedBody } from '@/app/document/io/browser'
import type { createDocumentChanges } from '@/app/document/io/changes'
import { applyImportedDocument } from '@/app/document/io/imported-document'
import { setAppTheme } from '@/app/shell/theme'

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
  let snapshotting = false
  let exportedRevision: number | null = null

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
    const response = await fetch(path, { ...options, signal: abort.signal, headers })
    if (!response.ok) throw new Error(`Todo document request failed (${response.status})`)
    return response
  }

  async function openDocument() {
    if (opened || opening) return
    opening = true
    try {
      const response = await request('/todo/document')
      const bytes = await readBoundedBody(response, 256 * 1024 * 1024)
      const graph = await readFigFile(new File([bytes], 'document.fig'), {
        populate: 'first-page',
        signal: abort.signal
      })
      abort.signal.throwIfAborted()
      await applyImportedDocument(editor, graph)
      state.documentName = 'document'
      changes.markSaved()
      opened = true
      editor.requestRender()
      post({ type: 'op-bridge/opened', generation })
      dirtyChanged()
    } finally {
      opening = false
    }
  }

  async function snapshot(requestId: string | undefined) {
    if (!opened || snapshotting || !requestId) throw new Error('Editor is not ready for a snapshot')
    snapshotting = true
    try {
      const revision = changes.capture()
      const bytes = await buildFigFile()
      // Export may await lazy pages/fonts. Never commit a mixed or stale revision.
      if (revision !== changes.capture()) {
        post({ type: 'op-bridge/snapshot-conflict', requestId: requestId })
        return
      }
      await request(`/todo/snapshot?requestId=${encodeURIComponent(requestId)}`, {
        method: 'PUT',
        body: new Uint8Array(bytes)
      })
      exportedRevision = revision
      post({ type: 'op-bridge/snapshot-result', requestId: requestId, generation, revision })
    } finally {
      snapshotting = false
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
      if (message.type === 'op-bridge/snapshot')
        post({ type: 'op-bridge/snapshot-conflict', requestId: message.requestId })
      post({
        type: 'op-bridge/error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

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
      abort.abort()
      stop()
      window.removeEventListener('message', onMessage)
    }
  }
}
