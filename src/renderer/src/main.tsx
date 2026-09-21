import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { useStore } from './store'
import { useI18n } from './i18n'
import type { Project, Scenario } from '@shared/types'
import './styles.css'

// Language: system by default, overridden by the saved setting.
void window.zc.app
  .getSettings()
  .then((s) => useI18n.getState().apply(s.language ?? 'system'))
  .catch(() => undefined)

// Autosave: persist the project ~700 ms after the last change. Closing the editor
// flushes the pending save at once, so a project deleted right afterwards cannot be
// resurrected by a late write.
let saveTimer: number | null = null
let lastSaved: unknown = null
let pending: Project | null = null
function flushSave(): void {
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = null
  const project = pending
  pending = null
  if (!project || project === lastSaved) return
  lastSaved = project
  void window.zc.projects.save(project).catch((err) => console.error('autosave failed', err))
}
useStore.subscribe((state, prev) => {
  if (state.project === prev.project) return
  if (!state.project) {
    flushSave()
    return
  }
  pending = state.project
  if (saveTimer) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushSave, 700)
})

// Scenario autosave: persist review-screen edits (retiming, deleting, renaming) ~500ms after
// the last change, same reasoning as the project autosave above. closeScenario() sets
// state.scenario back to null, which flushes the pending save immediately.
let scenarioSaveTimer: number | null = null
let lastSavedScenario: unknown = null
let pendingScenario: Scenario | null = null
function flushScenarioSave(): void {
  if (scenarioSaveTimer) window.clearTimeout(scenarioSaveTimer)
  scenarioSaveTimer = null
  const scenario = pendingScenario
  pendingScenario = null
  if (!scenario || scenario === lastSavedScenario) return
  lastSavedScenario = scenario
  void window.zc.scenario.save(scenario).catch((err) => console.error('scenario autosave failed', err))
}
useStore.subscribe((state, prev) => {
  if (state.scenario === prev.scenario) return
  if (!state.scenario) {
    flushScenarioSave()
    return
  }
  // Opening a scenario (fresh from disk/IPC, a different id than whatever was open before)
  // is not an edit: seed the "already saved" reference so it is not rewritten to disk until
  // something in it actually changes. openScenario always follows a closeScenario (scenario:
  // null) first when switching between two open scenarios, so prev.scenario here is either
  // null or the SAME scenario being edited - never a different one whose pending save this
  // would otherwise clobber.
  if (!prev.scenario || prev.scenario.id !== state.scenario.id) {
    lastSavedScenario = state.scenario
    pendingScenario = null
    if (scenarioSaveTimer) window.clearTimeout(scenarioSaveTimer)
    scenarioSaveTimer = null
    return
  }
  pendingScenario = state.scenario
  if (scenarioSaveTimer) window.clearTimeout(scenarioSaveTimer)
  scenarioSaveTimer = window.setTimeout(flushScenarioSave, 500)
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
