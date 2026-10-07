import type { AudioCaptureOptions, Project, Scenario } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'

/**
 * Delete / "Record again" for recordings and scenarios, shared by the editor, the scenario
 * review and Home. Everything destructive asks first, and nothing is deleted before everything
 * the follow-up needs (the scenario, a display) has been checked: an aborted "Record again"
 * must leave the old recording untouched.
 *
 * The follow-up recording is not started here: it is handed to the screen that owns the
 * recorder through store.pendingStart, which behaves exactly like pressing its button.
 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Asks, then removes a recording's folder. True once it is gone; false when the user declined or the delete failed (alerted). */
export async function confirmDeleteProject(id: string, name: string): Promise<boolean> {
  if (!confirm(t('home.deleteConfirm', { name }))) return false
  try {
    await window.zc.projects.remove(id)
    return true
  } catch (err) {
    alert(t('editor.deleteFailed', { error: errorText(err) }))
    return false
  }
}

/** Same for a scenario; the recordings made from it are kept (main only removes the scenario folder). */
export async function confirmDeleteScenario(id: string, name: string): Promise<boolean> {
  if (!confirm(t('editor.deleteScenarioConfirm', { name }))) return false
  try {
    await window.zc.scenario.remove(id)
    return true
  } catch (err) {
    alert(t('editor.deleteFailed', { error: errorText(err) }))
    return false
  }
}

/** Editor header, Delete: removes the open recording and leaves the editor (to the composition it was opened from, if any). */
export async function deleteOpenProject(project: Project): Promise<void> {
  // no more media requests for a folder that is about to disappear
  useStore.getState().setPlaying(false)
  if (!(await confirmDeleteProject(project.id, project.name))) return
  // closing flushes the project autosave; main knows the folder is gone by then and ignores it
  useStore.getState().closeProject()
}

/** What an old project without `origin` is recorded with: the last used display and audio choice. */
async function legacyConditions(): Promise<{ displayId: number; audio: AudioCaptureOptions | null } | null> {
  const settings = await window.zc.app.getSettings()
  let displayId = settings.lastDisplayId
  if (displayId === null) displayId = (await window.zc.displays.list()).find((d) => d.primary)?.id ?? null
  return displayId === null ? null : { displayId, audio: settings.audioDefaults }
}

/**
 * Editor header, Record again: deletes the open recording and starts a new attempt under the
 * same conditions (project.origin: display, audio, scenario). A scenario recording replays the
 * same scenario, so the scenario is loaded first - when it is gone nothing is deleted.
 */
export async function recordProjectAgain(project: Project): Promise<void> {
  const origin = project.origin
  let scenario: Scenario | null = null
  if (origin?.scenarioId) {
    try {
      scenario = await window.zc.scenario.load(origin.scenarioId)
    } catch {
      alert(t('editor.recordAgainScenarioMissing'))
      return
    }
  }
  let conditions: { displayId: number; audio: AudioCaptureOptions | null } | null = origin ?? null
  if (!conditions) {
    conditions = await legacyConditions()
    if (!conditions) {
      alert(t('editor.recordAgainNoDisplay'))
      return
    }
  }
  const question = scenario ? 'editor.recordAgainScenarioConfirm' : origin ? 'editor.recordAgainConfirm' : 'editor.recordAgainLegacyConfirm'
  if (!confirm(t(question))) return

  useStore.getState().setPlaying(false)
  try {
    await window.zc.projects.remove(project.id)
  } catch (err) {
    alert(t('editor.deleteFailed', { error: errorText(err) }))
    return
  }
  const store = useStore.getState()
  // the project goes first, so no stale one is left in the store behind the next screen
  store.closeProject()
  // the new recording is not part of the composition the editor may have been opened from
  if (store.composition) store.closeComposition()
  if (scenario) {
    store.setPendingStart({ kind: 'replay', scenarioId: scenario.id, audio: conditions.audio })
    store.openScenario(scenario)
  } else {
    // closeProject()/closeComposition() above already landed on Home
    store.setPendingStart({ kind: 'record', displayId: conditions.displayId, audio: conditions.audio })
  }
}

/** Scenario review header, Delete: removes the scenario (its recordings stay) and returns to Home. */
export async function deleteOpenScenario(scenario: Scenario): Promise<void> {
  if (!(await confirmDeleteScenario(scenario.id, scenario.name))) return
  useStore.getState().closeScenario()
}

/** Scenario review header, Record again: replaces the scenario by a freshly captured one on the same display. */
export async function recaptureScenario(scenario: Scenario): Promise<void> {
  if (!confirm(t('editor.recaptureConfirm'))) return
  try {
    await window.zc.scenario.remove(scenario.id)
  } catch (err) {
    alert(t('editor.deleteFailed', { error: errorText(err) }))
    return
  }
  const store = useStore.getState()
  // main falls back to the primary display when this one is gone
  store.setPendingStart({ kind: 'capture', displayId: scenario.displayId })
  store.closeScenario()
}
