import type { JSX } from 'react'
import { Home } from './screens/Home'
import { RecorderBar } from './screens/RecorderBar'
import { Editor } from './screens/Editor'
import { E2eTarget } from './screens/E2eTarget'
import { ScenarioReview } from './screens/ScenarioReview'
import { ReplayOverlay } from './screens/ReplayOverlay'
import { UpdateToast } from './components/UpdateToast'
import { useStore } from './store'

export function App(): JSX.Element {
  const hash = window.location.hash.replace('#', '')
  const screen = useStore((s) => s.screen)
  if (hash === 'bar') return <RecorderBar />
  if (hash === 'target') return <E2eTarget />
  if (hash === 'overlay') return <ReplayOverlay />
  return (
    <>
      {screen === 'editor' ? <Editor /> : screen === 'scenario' ? <ScenarioReview /> : <Home />}
      <UpdateToast />
    </>
  )
}
