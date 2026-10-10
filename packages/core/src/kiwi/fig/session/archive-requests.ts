import { randomHex } from '#core/random'

import type { FigSessionResponse } from './protocol'

const ARCHIVE_REQUEST_TIMEOUT_MS = 20_000

/** Each archive request must settle even when its worker fails or is released. */
export function createArchiveRequests(port: MessagePort, timeoutMs = ARCHIVE_REQUEST_TIMEOUT_MS) {
  const pending = new Map<
    string,
    {
      resolve: (bytes: Uint8Array) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let closed = false
  const receive = (event: MessageEvent<FigSessionResponse>) => {
    const message = event.data
    if (message.type !== 'original-archive-result' && message.type !== 'original-archive-error')
      return
    const request = pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.requestId)
    if (message.type === 'original-archive-error') request.reject(new Error(message.error))
    else request.resolve(message.bytes)
  }
  port.addEventListener('message', receive)
  port.start()
  return {
    request(): Promise<Uint8Array> {
      if (closed) return Promise.reject(new Error('FIG archive session is closed'))
      return new Promise((resolve, reject) => {
        const requestId = randomHex()
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('FIG original archive request timed out'))
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        try {
          port.postMessage({ type: 'original-archive', requestId })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    dispose(error = new Error('FIG archive session is closed')) {
      closed = true
      port.removeEventListener('message', receive)
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(error instanceof Error ? error : new Error(String(error)))
      }
      pending.clear()
    }
  }
}
