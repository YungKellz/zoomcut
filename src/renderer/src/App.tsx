import type { JSX } from 'react'
import { useEffect } from 'react'
import { Home } from './screens/Home'
import { RecorderBar } from './screens/RecorderBar'
import { Editor } from './screens/Editor'
import { E2eTarget } from './screens/E2eTarget'
import { UpdateToast } from './components/UpdateToast'
import { useStore } from './store'

/**
 * Placeholder for hash `overlay` until B2 adds the real ReplayOverlay.tsx (click ripples, HUD).
 * Without a route here the overlay window would render Home (opaque) on top of the display
 * during a replay; this keeps the tree safe to run on its own: transparent, same background
 * treatment as the floating bar.
 */
function ReplayOverlayPlaceholder(): JSX.Element {
  useEffect(() => {
    document.documentElement.classList.add('bar-window')
    document.body.classList.add('bar-window')
    return () => {
      document.documentElement.classList.remove('bar-window')
      document.body.classList.remove('bar-window')
    }
  }, [])
  return <div className="replay-overlay bar-window" />
}

export function App(): JSX.Element {
  const hash = window.location.hash.replace('#', '')
  const screen = useStore((s) => s.screen)
  if (hash === 'bar') return <RecorderBar />
  if (hash === 'target') return <E2eTarget />
  if (hash === 'overlay') return <ReplayOverlayPlaceholder />
  return (
    <>
      {screen === 'editor' ? <Editor /> : <Home />}
      <UpdateToast />
    </>
  )
}
