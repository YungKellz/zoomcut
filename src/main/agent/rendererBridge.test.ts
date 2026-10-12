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
      expect(bridge.getStatus()).toEqual({ screen: 'editor', openProjectId: 'p1' })
      bridge.setStatus({ screen: 'home', openProjectId: 7 })
      expect(bridge.getStatus()).toEqual({ screen: 'home', openProjectId: null })
      bridge.setStatus(null)
      bridge.setStatus('editor')
      bridge.setStatus({ openProjectId: 'x' })
      expect(bridge.getStatus()).toEqual({ screen: 'home', openProjectId: null })
    })
  })
})
