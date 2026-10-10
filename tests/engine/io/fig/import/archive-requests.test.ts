import { expect, test } from 'bun:test'

import { createArchiveRequests } from '#core/kiwi/fig/session/archive-requests'

test('archive replies coexist with another port subscriber', async () => {
  const channel = new MessageChannel()
  const requests = createArchiveRequests(channel.port1)
  let observed = 0
  channel.port1.onmessage = () => {
    observed++
  }
  channel.port2.onmessage = (event) =>
    channel.port2.postMessage({
      type: 'original-archive-result',
      requestId: event.data.requestId,
      bytes: new Uint8Array([1, 2])
    })
  try {
    expect(await requests.request()).toEqual(new Uint8Array([1, 2]))
    expect(await requests.request()).toEqual(new Uint8Array([1, 2]))
    expect(observed).toBe(2)
  } finally {
    requests.dispose()
    channel.port1.close()
    channel.port2.close()
  }
})

test('archive failure, timeout and disposal settle pending requests', async () => {
  const channel = new MessageChannel()
  const requests = createArchiveRequests(channel.port1, 20)
  try {
    await expect(requests.request()).rejects.toThrow('timed out')
    channel.port2.onmessage = (event) =>
      channel.port2.postMessage({
        type: 'original-archive-error',
        requestId: event.data.requestId,
        error: 'archive unavailable'
      })
    await expect(requests.request()).rejects.toThrow('archive unavailable')
    const pending = requests.request()
    requests.dispose()
    await expect(pending).rejects.toThrow('closed')
    await expect(requests.request()).rejects.toThrow('closed')
  } finally {
    requests.dispose()
    channel.port1.close()
    channel.port2.close()
  }
})
