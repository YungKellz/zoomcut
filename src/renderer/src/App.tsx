import type { JSX } from 'react'
import { Home } from './screens/Home'
import { RecorderBar } from './screens/RecorderBar'
import { Editor } from './screens/Editor'
import { useStore } from './store'

export function App(): JSX.Element {
  const isBar = window.location.hash.replace('#', '') === 'bar'
  const screen = useStore((s) => s.screen)
  if (isBar) return <RecorderBar />
  return screen === 'editor' ? <Editor /> : <Home />
}
