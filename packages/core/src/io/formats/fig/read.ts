import { parseFigBuffer } from '@open-pencil/fig'
import type { FigPageManifestEntry } from '@open-pencil/kiwi/fig'
import type { SceneGraph } from '@open-pencil/scene-graph'

import { IS_BROWSER } from '#core/constants'
import { importNodeChanges } from '#core/kiwi/fig/import'
import { deserializeSceneGraph } from '#core/kiwi/fig/parse/transfer'
import {
  registerFigPopulationWorker,
  registerOriginalArchiveRequest
} from '#core/kiwi/fig/population/client'
import { createArchiveRequests } from '#core/kiwi/fig/session/archive-requests'
import { createFigSessionWorker } from '#core/kiwi/fig/session/client'
import type { FigSessionOpenRequest, FigSessionResponse } from '#core/kiwi/fig/session/protocol'

export interface ParseFigFileOptions {
  populate?: 'all' | 'first-page' | 'none'
  onPages?: (pages: readonly FigPageManifestEntry[]) => void
  signal?: AbortSignal
}

function parseFigFileSync(buffer: ArrayBuffer, options: ParseFigFileOptions = {}): SceneGraph {
  const {
    nodeChanges,
    blobs,
    images: imageEntries,
    figKiwiVersion,
    figSchemaDeflated
  } = parseFigBuffer(buffer, options.onPages)
  const graph = importNodeChanges(nodeChanges, blobs, new Map(imageEntries), options)
  graph.figKiwiVersion = figKiwiVersion
  graph.figSchemaDeflated = figSchemaDeflated
  return graph
}

function parseViaWorker(buffer: ArrayBuffer, options: ParseFigFileOptions): Promise<SceneGraph> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const worker = createFigSessionWorker()
    const channel = new MessageChannel()
    const archives = createArchiveRequests(channel.port1)
    const abort = () => {
      archives.dispose()
      channel.port1.postMessage({ type: 'dispose' })
      channel.port1.close()
      worker.terminate()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const cleanupAbort = () => options.signal?.removeEventListener('abort', abort)

    channel.port1.onmessage = (e: MessageEvent<FigSessionResponse>) => {
      if (e.data.type === 'page-manifest') {
        options.onPages?.(e.data.pages)
        return
      }
      if (e.data.type !== 'graph') return
      if (e.data.error || !e.data.graph) {
        cleanupAbort()
        archives.dispose()
        channel.port1.close()
        worker.terminate()
        reject(new Error(e.data.error ?? 'Worker failed to parse .fig file'))
        return
      }
      try {
        const graph = deserializeSceneGraph(e.data.graph)
        if (options.populate === 'first-page') {
          cleanupAbort()
          registerFigPopulationWorker(graph, worker, channel.port1)
          registerOriginalArchiveRequest(
            graph,
            () => archives.request(),
            () => archives.dispose()
          )
        } else {
          cleanupAbort()
          archives.dispose()
          channel.port1.close()
          worker.terminate()
        }
        resolve(graph)
      } catch (error) {
        cleanupAbort()
        archives.dispose()
        channel.port1.close()
        worker.terminate()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    channel.port1.start()
    worker.addEventListener('error', (err) => {
      cleanupAbort()
      archives.dispose(new Error(err.message || 'FIG worker failed'))
      channel.port1.close()
      worker.terminate()
      reject(new Error(err.message || 'Worker failed to parse .fig file'))
    })
    channel.port1.addEventListener('messageerror', () =>
      archives.dispose(new Error('Invalid FIG worker response'))
    )
    const workerBuffer = buffer.slice(0)
    const archiveBuffer = buffer.slice(0)
    const request: FigSessionOpenRequest = {
      type: 'open',
      originalBuffer: workerBuffer,
      archiveBuffer,
      options: { populate: options.populate },
      port: channel.port2
    }
    worker.postMessage(request, [workerBuffer, archiveBuffer, channel.port2])
  })
}

export async function parseFigFile(
  buffer: ArrayBuffer,
  options: ParseFigFileOptions = {}
): Promise<SceneGraph> {
  options.signal?.throwIfAborted()
  if (typeof Worker !== 'undefined' && IS_BROWSER) {
    const copy = buffer.slice(0)
    try {
      return await parseViaWorker(buffer, options)
    } catch (error) {
      if (options.signal?.aborted) throw error
      console.warn('Worker parsing failed, falling back to main thread:', error)
      const graph = parseFigFileSync(copy, options)
      registerOriginalArchiveRequest(graph, async () => new Uint8Array(copy.slice(0)))
      return graph
    }
  }
  options.signal?.throwIfAborted()
  return parseFigFileSync(buffer, options)
}

export async function readFigFile(
  file: File,
  options: ParseFigFileOptions = {}
): Promise<SceneGraph> {
  options.signal?.throwIfAborted()
  const buffer = await file.arrayBuffer()
  options.signal?.throwIfAborted()
  return parseFigFile(buffer, options)
}
