import type { AgentCommand } from '@shared/agent'
import type { RendererTarget } from './rendererBridge'

/** The slice of a WebContents the adapter uses (a structural type, so the adapter is testable without Electron). */
export interface TargetContents {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  isCrashed(): boolean
  isLoading(): boolean
  getURL(): string
  on(event: 'render-process-gone', listener: () => void): unknown
  on(event: 'did-navigate', listener: () => void): unknown
}

/** The slice of a BrowserWindow the adapter uses. */
export interface TargetWindow {
  readonly webContents: TargetContents
  once(event: 'closed', listener: () => void): unknown
}

/**
 * A window as a place to send commands to. The page the commands go to is lost when the window
 * closes, when a navigation of the main frame commits (Ctrl+R, a dev full reload; `did-navigate`
 * is not emitted for a hash change or pushState, which keep the document) and when its renderer
 * process dies, as many times as that happens - so those listeners stay. Not on
 * `did-start-navigation`: a navigation that starts is not one that commits (windows.ts cancels
 * some in `will-navigate`, after the start), and the page lives on then. A crashed page still
 * looks loaded to isLoading() and getURL(), hence the extra isCrashed() check.
 */
export function createWindowTarget(win: TargetWindow): RendererTarget {
  const contents = win.webContents
  return {
    send: (command: AgentCommand) => contents.send('agent:command', command),
    isLoaded: () => !contents.isDestroyed() && !contents.isCrashed() && !contents.isLoading() && contents.getURL() !== '',
    onGone: (cb) => {
      win.once('closed', cb)
      contents.on('render-process-gone', cb)
      contents.on('did-navigate', cb)
    }
  }
}
