/**
 * Ref-counted access to the single global uIOhook instance. libuiohook can only be started
 * once per process, but the cursor tracker (recorder/cursorTracker.ts), the scenario capture
 * and the scenario replay's Escape-abort listener may all want it live at the same time.
 *
 * Contract: call acquireHook() and check the result; call releaseHook() exactly once for
 * every call that returned a non-null hook (never for a call that returned null – there is
 * nothing to release). The hook actually stops only once every acquirer has released it.
 */

type UioModule = typeof import('uiohook-napi')
export type UioHook = UioModule['uIOhook']

let hook: UioHook | null = null
let starting: Promise<UioHook | null> | null = null
let refCount = 0

async function startHook(): Promise<UioHook | null> {
  try {
    const mod = (await import('uiohook-napi')) as UioModule
    mod.uIOhook.start()
    hook = mod.uIOhook
    return hook
  } catch (err) {
    console.warn('[scenario] global input hook unavailable:', err)
    hook = null
    return null
  }
}

export async function acquireHook(): Promise<UioHook | null> {
  if (!starting) starting = startHook()
  const h = await starting
  if (h) refCount++
  return h
}

export function releaseHook(): void {
  if (refCount <= 0) return
  refCount--
  if (refCount === 0 && hook) {
    const h = hook
    hook = null
    // Allow a later acquireHook() to start the native listener again.
    starting = null
    try {
      h.stop()
    } catch (err) {
      console.warn('[scenario] failed to stop the input hook', err)
    }
  }
}

/** Test/diagnostics only. */
export function hookRefCount(): number {
  return refCount
}
