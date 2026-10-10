const SNAPSHOT_TIMEOUT_MS = 120_000

/** Cancellation settles the host operation and suppresses any late export result. */
export function createSnapshotOperation(timeoutMs = SNAPSHOT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Todo snapshot timed out')), timeoutMs)
  return {
    signal: controller.signal,
    cancel: () => controller.abort(new Error('Todo snapshot cancelled')),
    async run<T>(work: () => Promise<T>): Promise<T> {
      const signal = controller.signal
      signal.throwIfAborted()
      let onAbort: () => void = () => undefined
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([work(), cancelled])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => clearTimeout(timer)
  }
}
