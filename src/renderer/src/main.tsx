import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { useStore } from './store'
import { useI18n } from './i18n'
import './styles.css'

// Language: system by default, overridden by the saved setting.
void window.zc.app
  .getSettings()
  .then((s) => useI18n.getState().apply(s.language ?? 'system'))
  .catch(() => undefined)

// Autosave: persist the project ~700 ms after the last change.
let saveTimer: number | null = null
let lastSaved: unknown = null
useStore.subscribe((state, prev) => {
  if (state.project === prev.project || !state.project) return
  if (saveTimer) window.clearTimeout(saveTimer)
  const project = state.project
  saveTimer = window.setTimeout(() => {
    if (project === lastSaved) return
    lastSaved = project
    void window.zc.projects.save(project).catch((err) => console.error('autosave failed', err))
  }, 700)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
