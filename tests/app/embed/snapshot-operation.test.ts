import { expect, test } from 'bun:test'

import { createSnapshotOperation } from '@/app/embed/todo/snapshot-operation'

test('snapshot deadline rejects stalled work and allows independent retry', async () => {
  const operation = createSnapshotOperation(10)
  try {
    await expect(
      operation.run(
        () =>
          new Promise(() => {
            /* Deliberately stalled export. */
          })
      )
    ).rejects.toThrow('timed out')
    expect(operation.signal.aborted).toBe(true)
  } finally {
    operation.dispose()
  }
  const retry = createSnapshotOperation()
  try {
    expect(await retry.run(async () => 42)).toBe(42)
  } finally {
    retry.dispose()
  }
})

test('cancellation wins over late work and settles without an unhandled rejection', async () => {
  const operation = createSnapshotOperation()
  let finish: () => void = () => undefined
  const work = new Promise<void>((resolve) => {
    finish = resolve
  })
  const pending = operation.run(() => work)
  operation.cancel()
  await expect(pending).rejects.toThrow('cancelled')
  finish()
  operation.dispose()
})
