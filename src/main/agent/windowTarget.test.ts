import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCommand } from '@shared/agent'
import { createWindowTarget, type TargetWindow } from './windowTarget'

class FakeContents extends EventEmitter {
  sent: Array<{ channel: string; args: unknown[] }> = []
  destroyed = false
  crashed = false
  loading = false
  url = 'file:///app/index.html'
  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args })
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isCrashed(): boolean {
    return this.crashed
  }
  isLoading(): boolean {
    return this.loading
  }
  getURL(): string {
    return this.url
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents()
}

function setup(): { win: FakeWindow; contents: FakeContents; gone: ReturnType<typeof vi.fn>; target: ReturnType<typeof createWindowTarget> } {
  const win = new FakeWindow()
  const target = createWindowTarget(win as unknown as TargetWindow)
  const gone = vi.fn()
  target.onGone(gone)
  return { win, contents: win.webContents, gone, target }
}

describe('createWindowTarget', () => {
  it('sends commands over agent:command', () => {
    const { contents, target } = setup()
    const command: AgentCommand = { requestId: 'r1', method: 'projects.edit', params: { a: 1 } }
    target.send(command)
    expect(contents.sent).toEqual([{ channel: 'agent:command', args: [command] }])
  })

  describe('isLoaded', () => {
    it('is true for a page that finished loading', () => {
      expect(setup().target.isLoaded()).toBe(true)
    })

    it('is false while loading, without a URL, destroyed - and for a crashed renderer, which still looks loaded otherwise', () => {
      const { contents, target } = setup()
      contents.loading = true
      expect(target.isLoaded()).toBe(false)
      contents.loading = false
      contents.url = ''
      expect(target.isLoaded()).toBe(false)
      contents.url = 'file:///app/index.html'
      contents.crashed = true
      expect(target.isLoaded()).toBe(false)
      contents.crashed = false
      contents.destroyed = true
      expect(target.isLoaded()).toBe(false)
    })
  })

  describe('onGone', () => {
    it('fires when the window closes', () => {
      const { win, gone } = setup()
      win.emit('closed')
      expect(gone).toHaveBeenCalledTimes(1)
    })

    it('fires for every crash of the renderer process, not just the first', () => {
      const { contents, gone } = setup()
      contents.emit('render-process-gone', {}, { reason: 'crashed' })
      contents.emit('render-process-gone', {}, { reason: 'killed' })
      expect(gone).toHaveBeenCalledTimes(2)
    })

    it('fires for every reload: a main frame navigation that committed', () => {
      const { contents, gone } = setup()
      contents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
      contents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
      expect(gone).toHaveBeenCalledTimes(2)
    })

    it('does not fire for a navigation that started but never committed (windows.ts cancels some in will-navigate): the page lives on', () => {
      const { contents, gone } = setup()
      // a file dropped outside a drop zone: Chromium starts a main frame navigation, will-navigate cancels it
      contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      contents.emit('will-navigate', { url: 'file:///dropped/audio.mp3' })
      expect(gone).not.toHaveBeenCalled()
      // ... and the next reload that does commit still counts
      contents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
      expect(gone).toHaveBeenCalledTimes(1)
    })

    it('ignores navigations that keep the document: hash changes and pushState, and sub frames', () => {
      const { contents, gone } = setup()
      contents.emit('did-navigate-in-page', {}, 'file:///app/index.html#bar', true)
      contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      contents.emit('did-frame-navigate', {}, 'file:///app/frame.html', 200, 'OK', false)
      expect(gone).not.toHaveBeenCalled()
    })
  })
})
