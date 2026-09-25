import { app, BrowserWindow, globalShortcut, protocol } from 'electron'
import { MEDIA_SCHEME, registerMediaProtocol } from './mediaProtocol'
import { createMainWindow, getMainWindow } from './windows'
import { registerIpc } from './ipc'
import { RecordingController } from './recorder/controller'
import { ExportManager } from './exportManager'
import { GifConverter } from './media/gifConvert'
import { Updater } from './updater'
import { ensureDirs } from './storage'
import { ScenarioCapture } from './scenario/capture'
import { cleanupHelperScripts } from './scenario/inputHelper'

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

let recorder: RecordingController | null = null
let scenarioCapture: ScenarioCapture | null = null
let updater: Updater | null = null

// Tests launch their own instance next to a running dev app, so they skip the lock.
const gotLock = process.env['ZOOMCUT_E2E'] ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    await ensureDirs()
    registerMediaProtocol()

    recorder = new RecordingController()
    recorder.installDisplayMediaHandler()
    scenarioCapture = new ScenarioCapture()
    // recording and scenario capture are mutually exclusive
    recorder.setOtherBusyCheck(() => scenarioCapture!.isActive())
    scenarioCapture.setOtherBusyCheck(() => recorder!.isActive())
    const exporter = new ExportManager()
    updater = new Updater()
    registerIpc({ recorder, scenarioCapture, exporter, updater, converter: new GifConverter() })

    createMainWindow()
    updater.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    recorder?.dispose()
    scenarioCapture?.dispose()
    updater?.dispose()
    void cleanupHelperScripts()
  })
}
