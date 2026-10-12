import type { JSX } from 'react'
import { Home } from './screens/Home'
import { RecorderBar } from './screens/RecorderBar'
import { Editor } from './screens/Editor'
import { E2eTarget } from './screens/E2eTarget'
import { ScenarioReview } from './screens/ScenarioReview'
import { ReplayOverlay } from './screens/ReplayOverlay'
import { CompositionScreen } from './screens/Composition'
import { UpdateToast } from './components/UpdateToast'
import { NoticeBar } from './components/NoticeBar'
import { ConfirmHost } from './components/ConfirmPopover'
import { useStore } from './store'

export function App(): JSX.Element {
  const hash = window.location.hash.replace('#', '')
  const screen = useStore((s) => s.screen)
  const scenarioId = useStore((s) => s.scenario?.id)
  if (hash === 'bar') return <RecorderBar />
  if (hash === 'target') return <E2eTarget />
  if (hash === 'overlay') return <ReplayOverlay />
  return (
    <>
      {screen === 'editor' ? (
        <Editor />
      ) : screen === 'scenario' ? (
        // keyed: another scenario (an agent can switch in place) never inherits this one's selection and notices
        <ScenarioReview key={scenarioId} />
      ) : screen === 'composition' ? (
        <CompositionScreen />
      ) : (
        <Home />
      )}
      <NoticeBar />
      <UpdateToast />
      <ConfirmHost />
    </>
  )
}
