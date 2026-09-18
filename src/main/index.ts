import { app, BrowserWindow, globalShortcut, protocol } from 'electron'
import { MEDIA_SCHEME, registerMediaProtocol } from './mediaProtocol'
import { createMainWindow, getMainWindow } from './windows'
import { registerIpc } from './ipc'
import { RecordingController } from './recorder/controller'
import { ExportManager } from './exportManager'
import { ensureDirs } from './storage'

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

const gotLock = app.requestSingleInstanceLock()
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
    const exporter = new ExportManager()
    registerIpc({ recorder, exporter })

    createMainWindow()

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
  })
}
