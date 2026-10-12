import { describe, expect, it, vi } from 'vitest'
import { acquireMic } from './micRequest'

function fakeStream(): { stream: MediaStream; stops: ReturnType<typeof vi.fn> } {
  const stops = vi.fn()
  const stream = { getTracks: () => [{ stop: stops }, { stop: stops }] } as unknown as MediaStream
  return { stream, stops }
}

describe('acquireMic', () => {
  it('hands the stream over while the owner is still there', async () => {
    const { stream, stops } = fakeStream()
    await expect(acquireMic(async () => stream, () => false)).resolves.toBe(stream)
    expect(stops).not.toHaveBeenCalled()
  })

  it('releases every track and answers null when the owner went away while the mic was opening', async () => {
    const { stream, stops } = fakeStream()
    let disposed = false
    let resolveRequest!: (s: MediaStream) => void
    const pending = acquireMic(
      () => new Promise<MediaStream>((resolve) => (resolveRequest = resolve)),
      () => disposed
    )
    disposed = true // the editor closed while getUserMedia was pending
    resolveRequest(stream)
    await expect(pending).resolves.toBeNull()
    expect(stops).toHaveBeenCalledTimes(2)
  })

  it('passes a rejected request on unchanged', async () => {
    const failure = new Error('NotAllowedError')
    await expect(acquireMic(() => Promise.reject(failure), () => false)).rejects.toBe(failure)
  })
})
