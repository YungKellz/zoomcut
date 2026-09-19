import { app, dialog, ipcMain, shell } from 'electron'
import type {
  AppInfo,
  AppSettings,
  ExportBeginRequest,
  ExportSettings,
  Project,
  RecordingStartMeta
} from '@shared/types'
import type { RecordingController } from './recorder/controller'
import type { ExportManager } from './exportManager'
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
import { getMainWindow } from './windows'

interface Deps {
  recorder: RecordingController
  exporter: ExportManager
}

export function registerIpc({ recorder, exporter }: Deps): void {
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
  ipcMain.handle('recording:prepare', (_e, displayId: number) => recorder.prepare(displayId))
  ipcMain.handle('recording:started', (_e, id: string, meta: RecordingStartMeta) => recorder.started(id, meta))
  ipcMain.handle('recording:chunk', (_e, id: string, data: ArrayBuffer) => recorder.chunk(id, data))
  ipcMain.handle('recording:finish', (_e, id: string) => recorder.finish(id))
  ipcMain.handle('recording:cancel', (_e, id: string) => recorder.cancel(id))

  // ---- floating bar ----
  ipcMain.handle('bar:request-state', () => recorder.getBarState())
  ipcMain.handle('bar:stop', () => recorder.requestStop())
  ipcMain.handle('bar:cancel', () => recorder.requestCancel())

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
}
