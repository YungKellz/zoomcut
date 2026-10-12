import type { AgentError } from '@shared/agent'

export interface Waiter<T> {
  promise: Promise<T>
  /** stops listening; the promise stays pending (call it when the wait is no longer needed) */
  cancel(): void
  /** restarts the timeout with a new length (a wait whose budget grows when a later phase begins); no-op once settled */
  rearm(ms: number): void
}

/**
 * A one-shot wait for something that happens on an emitter. `subscribe` attaches the listeners
 * and returns the function that detaches them; it calls `resolve` / `reject` from them. The
 * listeners are removed as soon as the wait settles or times out. Create the waiter BEFORE
 * triggering what it waits for, or the event can slip through.
 */
export function waitFor<T>(
  subscribe: (resolve: (value: T) => void, reject: (err: AgentError) => void) => () => void,
  timeout?: { ms: number; error: () => AgentError }
): Waiter<T> {
  let detach: () => void = () => undefined
  let timer: NodeJS.Timeout | null = null
  let settled = false
  const done = (): void => {
    settled = true
    if (timer) clearTimeout(timer)
    timer = null
    detach()
  }
  let rejectTimeout: (err: AgentError) => void = () => undefined
  const arm = (ms: number): void => {
    if (!timeout) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (settled) return
      done()
      rejectTimeout(timeout.error())
    }, ms)
  }
  const promise = new Promise<T>((resolve, reject) => {
    rejectTimeout = reject
    detach = subscribe(
      (value) => {
        if (settled) return
        done()
        resolve(value)
      },
      (err) => {
        if (settled) return
        done()
        reject(err)
      }
    )
    if (settled) detach() // settled while subscribing
    else if (timeout) arm(timeout.ms)
  })
  // a waiter whose owner stopped listening (an earlier step failed) must not end up as an unhandled rejection
  promise.catch(() => undefined)
  return { promise, cancel: () => done(), rearm: (ms) => (settled ? undefined : arm(ms)) }
}
