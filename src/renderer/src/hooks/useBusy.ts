import { useEffect } from 'react'
import { useStore, type BusyKind } from '../store'

/** Marks `kind` as running in the store (see BusyKind) while `active` and the component is mounted. */
export function useBusy(kind: BusyKind, active: boolean): void {
  useEffect(() => {
    if (!active) return
    useStore.getState().setBusy(kind, true)
    return () => useStore.getState().setBusy(kind, false)
  }, [kind, active])
}
