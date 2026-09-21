import { useCallback, useEffect, useRef, useState } from 'react'
import type { Scenario, ScenarioCaptureState } from '@shared/types'

export type ScenarioCapturePhase = 'idle' | 'starting' | 'countdown' | 'capturing' | 'saving' | 'error'

const IDLE_STATE: ScenarioCaptureState = { phase: 'idle', actions: 0, startedAt: null }

/**
 * Drives one scenario capture attempt from Home: asks the main process to start (a countdown
 * on the floating bar, then every click/drag/scroll/keystroke is recorded until Stop or
 * Ctrl+Alt+R), mirrors its state (scenario:state) and hands the finished Scenario back through
 * onDone (scenario:done). Stop / discard themselves happen from the floating bar or the
 * shortcut - same as a plain recording - this hook only starts the attempt and reports
 * progress. 'starting' covers the gap between pressing the button and the first state event
 * (mkdir + acquiring the global hook + spawning the keytext helper in main).
 */
export function useScenarioCapture(onDone: (scenario: Scenario) => void): {
  phase: ScenarioCapturePhase
  actions: number
  error: string | null
  start: (displayId: number) => Promise<void>
  reset: () => void
} {
  const [state, setState] = useState<ScenarioCaptureState>(IDLE_STATE)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    void window.zc.scenario.getState().then(setState)
    const offState = window.zc.scenario.onState((s) => {
      setState(s)
      if (s.phase !== 'idle') setStarting(false)
    })
    const offDone = window.zc.scenario.onDone((s) => {
      setStarting(false)
      setState(IDLE_STATE)
      if (s) onDoneRef.current(s)
    })
    return () => {
      offState()
      offDone()
    }
  }, [])

  const start = useCallback(async (displayId: number) => {
    setError(null)
    setStarting(true)
    try {
      await window.zc.scenario.start(displayId)
    } catch (err) {
      setStarting(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const phase: ScenarioCapturePhase = error ? 'error' : starting && state.phase === 'idle' ? 'starting' : state.phase

  return { phase, actions: state.actions, error, start, reset: () => setError(null) }
}
