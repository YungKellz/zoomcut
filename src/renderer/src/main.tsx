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

// The last used cursor / frame settings become the defaults for new projects.
let defaultsTimer: number | null = null
useStore.subscribe((state, prev) => {
  const p = state.project
  const q = prev.project
  if (!p || !q || p.id !== q.id) return
  if (p.cursor === q.cursor && p.frame === q.frame) return
  if (defaultsTimer) window.clearTimeout(defaultsTimer)
  defaultsTimer = window.setTimeout(() => {
    void window.zc.app
      .setSettings({ cursorDefaults: { ...p.cursor, offsetMs: 0 }, frameDefaults: { ...p.frame } })
      .catch((err) => console.error('saving defaults failed', err))
  }, 800)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
