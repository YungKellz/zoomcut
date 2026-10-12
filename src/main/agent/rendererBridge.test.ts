import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentError, type AgentCommand } from '@shared/agent'
import { RendererBridge, type RendererTarget } from './rendererBridge'

class FakeTarget implements RendererTarget {
  sent: AgentCommand[] = []
  loaded = true
  gone: Array<() => void> = []
  throwOnSend = false
  send(command: AgentCommand): void {
    if (this.throwOnSend) throw new Error('Object has been destroyed')
    this.sent.push(command)
  }
  isLoaded(): boolean {
    return this.loaded
  }
  onGone(cb: () => void): void {
    this.gone.push(cb)
  }
}

async function rejection(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    return err as AgentError
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RendererBridge', () => {
  it('sends a command with a request id and resolves with the reply', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    const result = bridge.send('projects.edit', { projectId: 'p' })
    await vi.waitFor(() => expect(target.sent).toHaveLength(1))
    const command = target.sent[0]
    expect(command).toMatchObject({ method: 'projects.edit', params: { projectId: 'p' } })
    expect(command.requestId).toMatch(/^[0-9a-f-]{36}$/)
    bridge.reply({ requestId: command.requestId, ok: true, result: { done: 1 } })
    expect(await result).toEqual({ done: 1 })
  })

  it('rejects with the code and message the renderer sent', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    const result = bridge.send('projects.export', {})
    await vi.waitFor(() => expect(target.sent).toHaveLength(1))
    bridge.reply({ requestId: target.sent[0].requestId, ok: false, error: { code: 'busy', message: 'An export is running' } })
    const err = await rejection(result)
    expect(err.code).toBe('busy')
    expect(err.message).toBe('An export is running')
  })

  it('maps an unknown error code to failed and fills in a missing message', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    const result = bridge.send('projects.edit', {})
    await vi.waitFor(() => expect(target.sent).toHaveLength(1))
    bridge.reply({ requestId: target.sent[0].requestId, ok: false, error: { code: 'weird' } })
    const err = await rejection(result)
    expect(err.code).toBe('failed')
    expect(err.message).toBe('projects.edit failed')
  })

  it('ignores replies it cannot match, and a second reply for the same request', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    const result = bridge.send('projects.edit', {})
    await vi.waitFor(() => expect(target.sent).toHaveLength(1))
    const id = target.sent[0].requestId
    for (const junk of [null, 'x', {}, { requestId: 5 }, { requestId: 'nope', ok: true }]) bridge.reply(junk)
    bridge.reply({ requestId: id, ok: true, result: 1 })
    bridge.reply({ requestId: id, ok: false, error: { code: 'failed', message: 'late' } })
    expect(await result).toBe(1)
  })

  it('keeps concurrent requests apart', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    const a = bridge.send('projects.edit', 'a')
    const b = bridge.send('projects.export', 'b')
    await vi.waitFor(() => expect(target.sent).toHaveLength(2))
    const [first, second] = target.sent
    bridge.reply({ requestId: second.requestId, ok: true, result: 'for b' })
    bridge.reply({ requestId: first.requestId, ok: true, result: 'for a' })
    expect(await a).toBe('for a')
    expect(await b).toBe('for b')
  })

  it('rejects no_window without a window', async () => {
    const bridge = new RendererBridge(() => null)
    expect((await rejection(bridge.send('projects.edit', {}))).code).toBe('no_window')
  })

  it('rejects no_window when the target refuses the message', async () => {
    const target = new FakeTarget()
    target.throwOnSend = true
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'home', openProjectId: null })
    expect((await rejection(bridge.send('projects.edit', {}))).code).toBe('no_window')
  })

  it('rejects everything in flight when the window goes away, and forgets the status', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    bridge.setStatus({ screen: 'editor', openProjectId: 'p1' })
    const a = bridge.send('projects.edit', {})
    const b = bridge.send('projects.export', {})
    await vi.waitFor(() => expect(target.sent).toHaveLength(2))
    expect(target.gone).toHaveLength(1) // watched once, not per request
    target.gone[0]()
    expect((await rejection(a)).code).toBe('no_window')
    expect((await rejection(b)).code).toBe('no_window')
    expect(bridge.getStatus()).toBeNull()
  })

  it('loses the page again and again: every reload or crash rejects what is in flight, not just the first', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 0 })
    for (let round = 0; round < 3; round++) {
      bridge.setStatus({ screen: 'editor', openProjectId: 'p1' }) // the (re)loaded page announces itself
      const result = bridge.send('projects.export', {})
      await vi.waitFor(() => expect(target.sent).toHaveLength(round + 1))
      target.gone[0]() // the same persistent callback, as the Electron adapter keeps its listeners
      expect((await rejection(result)).code).toBe('no_window')
      expect(bridge.getStatus()).toBeNull()
    }
    expect(target.gone).toHaveLength(1)
  })

  it('holds a command back after a reload until the new page announces itself', async () => {
    const target = new FakeTarget()
    const bridge = new RendererBridge(() => target, { graceMs: 5_000 })
    bridge.setStatus({ screen: 'editor', openProjectId: 'p1' })
    const first = bridge.send('projects.edit', {})
    await vi.waitFor(() => expect(target.sent).toHaveLength(1))
    target.gone[0]() // Ctrl+R
    await rejection(first)
    const second = bridge.send('projects.edit', {})
    await new Promise((r) => setTimeout(r, 150))
    expect(target.sent).toHaveLength(1) // the old status is gone: nothing goes to a page without a listener
    bridge.setStatus({ screen: 'editor', openProjectId: 'p1' })
    await vi.waitFor(() => expect(target.sent).toHaveLength(2))
    bridge.reply({ requestId: target.sent[1].requestId, ok: true, result: 'fresh page' })
    expect(await second).toBe('fresh page')
  })

  describe('a reply that never comes', () => {
    it('fails an edit or a handover after the command timeout, and ignores a late reply', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0, commandTimeoutMs: 80 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      for (const method of ['projects.edit', 'recording.start', 'scenarios.record', 'capture.start'] as const) {
        const result = bridge.send(method, {})
        const err = await rejection(result)
        expect(err.code, method).toBe('failed')
        expect(err.message).toContain(method)
      }
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: 'late' }) // nothing pending any more: ignored
    })

    it('does not put a time limit on an export', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0, commandTimeoutMs: 40 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      let settled = false
      const result = bridge.send('projects.export', {}).finally(() => (settled = true))
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      await new Promise((r) => setTimeout(r, 200))
      expect(settled).toBe(false)
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: { bytes: 1 } })
      expect(await result).toEqual({ bytes: 1 })
    })

    it('stops the timer once the reply is there', async () => {
      vi.useFakeTimers()
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0, commandTimeoutMs: 1000 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      const result = bridge.send('projects.edit', {})
      await vi.advanceTimersByTimeAsync(60)
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: 1 })
      expect(await result).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('a caller that gave up', () => {
    it('rejects cancelled and tells the renderer to stop the command', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      const ac = new AbortController()
      const result = bridge.send('projects.export', { projectId: 'p1' }, { signal: ac.signal })
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      const exportId = target.sent[0].requestId
      ac.abort()
      expect((await rejection(result)).code).toBe('cancelled')
      expect(target.sent).toHaveLength(2)
      expect(target.sent[1]).toMatchObject({ method: 'cancel', params: { requestId: exportId } })
      expect(target.sent[1].requestId).not.toBe(exportId)
      // the export answers cancelled itself a moment later, and the cancel command is acknowledged: both ignored
      bridge.reply({ requestId: exportId, ok: false, error: { code: 'cancelled', message: 'x' } })
      bridge.reply({ requestId: target.sent[1].requestId, ok: true, result: {} })
    })

    it('sends no cancel for a command that already got its answer', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      const ac = new AbortController()
      const result = bridge.send('projects.export', {}, { signal: ac.signal })
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: 1 })
      expect(await result).toBe(1)
      ac.abort()
      expect(target.sent).toHaveLength(1)
    })

    it('sends nothing when the caller was already gone, or leaves while the window still loads', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      const gone = new AbortController()
      gone.abort()
      expect((await rejection(bridge.send('projects.export', {}, { signal: gone.signal }))).code).toBe('cancelled')

      const loading = new FakeTarget()
      loading.loaded = false
      const slow = new RendererBridge(() => loading, { loadTimeoutMs: 5_000 })
      const ac = new AbortController()
      const waiting = slow.send('projects.export', {}, { signal: ac.signal })
      setTimeout(() => {
        slow.setStatus({ screen: 'home', openProjectId: null }) // the page is up, but the caller left a moment before
        ac.abort()
      }, 80)
      expect((await rejection(waiting)).code).toBe('cancelled')
      expect(target.sent).toHaveLength(0)
      expect(loading.sent).toHaveLength(0)
    })

    it('keeps no listener on the signal after the command settled', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 0 })
      bridge.setStatus({ screen: 'home', openProjectId: null })
      const ac = new AbortController()
      const spy = vi.spyOn(ac.signal, 'removeEventListener')
      const result = bridge.send('projects.export', {}, { signal: ac.signal })
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: 1 })
      await result
      expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
    })
  })

  describe('readiness', () => {
    it('holds a command back until the renderer announces itself with a status push', async () => {
      const target = new FakeTarget()
      target.loaded = false
      const bridge = new RendererBridge(() => target)
      const result = bridge.send('recording.start', {})
      await new Promise((r) => setTimeout(r, 120))
      expect(target.sent).toHaveLength(0)
      bridge.setStatus({ screen: 'home', openProjectId: null })
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: {} })
      await result
    })

    it('goes ahead a grace period after the page loaded even if no status ever arrives', async () => {
      const target = new FakeTarget()
      const bridge = new RendererBridge(() => target, { graceMs: 150 })
      const started = Date.now()
      const result = bridge.send('recording.start', {})
      await vi.waitFor(() => expect(target.sent).toHaveLength(1))
      expect(Date.now() - started).toBeGreaterThanOrEqual(140)
      bridge.reply({ requestId: target.sent[0].requestId, ok: true, result: 1 })
      expect(await result).toBe(1)
    })

    it('gives up when the page never loads', async () => {
      const target = new FakeTarget()
      target.loaded = false
      const bridge = new RendererBridge(() => target, { loadTimeoutMs: 100 })
      const err = await rejection(bridge.send('recording.start', {}))
      expect(err.code).toBe('no_window')
      expect(err.message).toContain('finish loading')
    })

    it('does not wait once a status is known', async () => {
      const target = new FakeTarget()
      target.loaded = false
      const bridge = new RendererBridge(() => target)
      bridge.setStatus({ screen: 'editor', openProjectId: 'p1' })
      void bridge.send('projects.edit', {}).catch(() => undefined)
      await vi.waitFor(() => expect(target.sent).toHaveLength(1), { timeout: 200 })
    })
  })

  describe('status', () => {
    it('keeps what the renderer reports and ignores nonsense', () => {
      const bridge = new RendererBridge(() => null)
      expect(bridge.getStatus()).toBeNull()
      bridge.setStatus({ screen: 'editor', openProjectId: 'p1' })
      expect(bridge.getStatus()).toEqual({ screen: 'editor', openProjectId: 'p1', openScenarioId: null, compositionProjectIds: [] })
      bridge.setStatus({ screen: 'home', openProjectId: 7 })
      expect(bridge.getStatus()).toEqual({ screen: 'home', openProjectId: null, openScenarioId: null, compositionProjectIds: [] })
      bridge.setStatus(null)
      bridge.setStatus('editor')
      bridge.setStatus({ openProjectId: 'x' })
      expect(bridge.getStatus()).toEqual({ screen: 'home', openProjectId: null, openScenarioId: null, compositionProjectIds: [] })
    })

    it('keeps the open scenario and the projects of the open composition, ignoring junk in them', () => {
      const bridge = new RendererBridge(() => null)
      bridge.setStatus({ screen: 'scenario', openProjectId: null, openScenarioId: 's1', compositionProjectIds: [] })
      expect(bridge.getStatus()).toMatchObject({ openScenarioId: 's1', compositionProjectIds: [] })
      bridge.setStatus({ screen: 'composition', openProjectId: null, openScenarioId: 4, compositionProjectIds: ['a', 7, null, 'b'] })
      expect(bridge.getStatus()).toEqual({ screen: 'composition', openProjectId: null, openScenarioId: null, compositionProjectIds: ['a', 'b'] })
      bridge.setStatus({ screen: 'composition', openProjectId: null, compositionProjectIds: 'a' })
      expect(bridge.getStatus()?.compositionProjectIds).toEqual([])
    })
  })
})
