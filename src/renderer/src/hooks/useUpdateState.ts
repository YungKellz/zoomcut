import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'

// "disabled/dev" until the real state arrives, so nothing update-related flashes on screen
const INITIAL: UpdateState = {
  status: 'disabled',
  reason: 'dev',
  currentVersion: '',
  version: null,
  percent: 0,
  message: null,
  checkedAt: null
}

/** The auto-update state kept by the main process, refreshed on every change. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(INITIAL)
  useEffect(() => {
    let alive = true
    void window.zc.update
      .getState()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    const off = window.zc.update.onState((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}
