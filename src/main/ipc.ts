import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppInfo,
  AppSettings,
  ExportBeginRequest,
  ExportSettings,
  Project,
  Rect,
  RecordingStartMeta,
  Scenario
} from '@shared/types'
import type { RecordingController } from './recorder/controller'
import type { ExportManager } from './exportManager'
import type { Updater } from './updater'
import type { ScenarioCapture } from './scenario/capture'
import { ffmpegPath } from './media/ffmpeg'
import {
  deleteProject,
  getSettings,
  listProjects,
  loadProject,
  projectDir,
  recordingsRoot,
  saveProject,
  updateSettings
} from './storage'
import type { ReplayStep } from '@shared/scenario'
import { deleteScenario, listScenarios, loadScenario, saveScenario } from './scenario/storage'
import { runStepsOnce } from './scenario/replay'
import { createE2eTargetWindow, getMainWindow } from './windows'

interface Deps {
  recorder: RecordingController
  scenarioCapture: ScenarioCapture
  exporter: ExportManager
  updater: Updater
}

// scenario ids come from newScenarioId() (a timestamp, optionally "-N" deduplicated) - never
// accept anything else from the renderer here, so a crafted id cannot walk `join()` outside
// userData/scenarios (see scenarioDir()).
const SCENARIO_ID_RE = /^[0-9A-Za-z_-]+$/
function assertValidScenarioId(id: string): void {
  if (typeof id !== 'string' || !SCENARIO_ID_RE.test(id)) throw new Error('Invalid scenario id')
}

export function registerIpc({ recorder, scenarioCapture, exporter, updater }: Deps): void {
  // ---- app ----
  ipcMain.handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    recordingsDir: recordingsRoot(),
    ffmpegPath: ffmpegPath(),
    platform: process.platform
  }))
  ipcMain.handle('app:get-settings', () => getSettings())
  ipcMain.handle('app:set-settings', (_e, patch: Partial<AppSettings>) => updateSettings(patch))
  ipcMain.handle('app:open-path', async (_e, p: string) => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
  })
  ipcMain.handle('app:show-in-folder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('app:open-external', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app:choose-folder', async (_e, defaultPath?: string) => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---- displays / recording ----
  ipcMain.handle('displays:list', () => recorder.listDisplays())
  ipcMain.handle('recording:prepare', (_e, displayId: number, options?: { scenario?: Scenario }) =>
    recorder.prepare(displayId, options))
  ipcMain.handle('recording:started', (_e, id: string, meta: RecordingStartMeta) => recorder.started(id, meta))
  ipcMain.handle('recording:chunk', (_e, id: string, data: ArrayBuffer) => recorder.chunk(id, data))
  ipcMain.handle('recording:finish', (_e, id: string) => recorder.finish(id))
  ipcMain.handle('recording:cancel', (_e, id: string) => recorder.cancel(id))

  // ---- floating bar ----
  // a scenario capture and a recording never run at once, so whichever is active owns the bar
  ipcMain.handle('bar:request-state', () => (scenarioCapture.isActive() ? scenarioCapture.getBarState() : recorder.getBarState()))
  ipcMain.handle('bar:stop', () => (scenarioCapture.isActive() ? scenarioCapture.requestStop() : recorder.requestStop()))
  ipcMain.handle('bar:cancel', () => (scenarioCapture.isActive() ? scenarioCapture.requestCancel() : recorder.requestCancel()))

  // ---- projects ----
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:load', (_e, id: string) => loadProject(id))
  ipcMain.handle('projects:save', (_e, project: Project) => saveProject(project))
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('projects:reveal', (_e, id: string) => shell.openPath(projectDir(id)))

  // ---- export ----
  ipcMain.handle('export:begin', (e, req: ExportBeginRequest) => exporter.begin(req, e.sender))
  ipcMain.handle('export:write', (_e, exportId: string, position: number, data: ArrayBuffer) =>
    exporter.write(exportId, position, data))
  ipcMain.handle('export:write-raw', (_e, exportId: string, data: ArrayBuffer) => exporter.writeRaw(exportId, data))
  ipcMain.handle('export:finish', (_e, exportId: string, settings: ExportSettings, meta: { durationMs: number; alpha?: boolean }) =>
    exporter.finish(exportId, settings, meta))
  ipcMain.handle('export:cancel', (_e, exportId: string) => exporter.cancel(exportId))

  // ---- updates ----
  ipcMain.handle('update:state', () => updater.getState())
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:install', () => updater.install())

  // ---- scenario ----
  ipcMain.handle('scenario:start', (_e, displayId: number) => scenarioCapture.start(displayId))
  ipcMain.handle('scenario:stop', () => scenarioCapture.requestStop())
  ipcMain.handle('scenario:cancel', () => scenarioCapture.requestCancel())
  ipcMain.handle('scenario:state', () => scenarioCapture.getState())
  ipcMain.handle('scenario:list', () => listScenarios())
  ipcMain.handle('scenario:load', (_e, id: string) => {
    assertValidScenarioId(id)
    return loadScenario(id)
  })
  ipcMain.handle('scenario:save', (_e, scenario: Scenario) => {
    assertValidScenarioId(scenario.id)
    return saveScenario(scenario)
  })
  ipcMain.handle('scenario:delete', (_e, id: string) => {
    assertValidScenarioId(id)
    return deleteScenario(id)
  })

  // Test-only: exists only under ZOOMCUT_E2E, so the e2e suite can open a page with known
  // coordinates and drive it through the real capture/replay path with real input.
  if (process.env['ZOOMCUT_E2E']) {
    let targetWindow: BrowserWindow | null = null
    ipcMain.handle('e2e:open-target', (_e, bounds: Rect) => {
      if (targetWindow && !targetWindow.isDestroyed()) targetWindow.close()
      targetWindow = createE2eTargetWindow(bounds)
      targetWindow.on('closed', () => {
        targetWindow = null
      })
    })
    ipcMain.handle('e2e:inject-steps', (_e, steps: ReplayStep[]) => runStepsOnce(steps, true))
  }
}
