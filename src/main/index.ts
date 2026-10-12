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
import { ScenarioPreview } from './scenario/preview'
import { cleanupHelperScripts } from './scenario/inputHelper'
import { setupAgentControl, type AgentControl } from './agent'
import { agentControlRequested, secondInstanceAction } from './agent/launchArgs'

// Lets a test (or a second install) keep this run's userData - settings, agent-control.json - apart from
// the real one; must happen before anything reads the path, the single-instance lock included.
const userDataOverride = process.env['ZOOMCUT_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

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
let scenarioPreview: ScenarioPreview | null = null
let updater: Updater | null = null
let agentControl: AgentControl | null = null
// MCP agent control is off unless this run (or a second launch handing over to it) asks for it
let agentWanted = agentControlRequested(process.argv)

/**
 * The main window is hidden exactly while the recorder's bar is up (countdown, recording, the first
 * part of saving), a scenario capture runs or a scenario is replayed. Not recorder.isActive(): that
 * stays true while the finished recording is transcoded, long after the window came back.
 */
function mainWindowHidden(): boolean {
  return Boolean((recorder && recorder.getBarState().phase !== 'idle') || scenarioCapture?.isActive() || scenarioPreview?.isActive())
}

// Tests launch their own instance next to a running dev app, so they skip the lock.
const gotLock = process.env['ZOOMCUT_E2E'] ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const action = secondInstanceAction(argv, mainWindowHidden())
    // `ZoomCut.exe --agent-control` started while the app already runs: this copy switches it on
    if (action.enableAgentControl) {
      agentWanted = true
      void agentControl?.enable()
    }
    // the window stays hidden while it is out of the way for a recording or a replay, and a launch that only wanted agent control leaves it alone
    const win = getMainWindow()
    if (win && action.showWindow) {
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
    scenarioPreview = new ScenarioPreview()
    // recording, scenario capture and a scenario preview (dry run) are mutually exclusive
    recorder.setOtherBusyCheck(() => scenarioCapture!.isActive() || scenarioPreview!.isActive())
    scenarioCapture.setOtherBusyCheck(() => recorder!.isActive() || scenarioPreview!.isActive())
    scenarioPreview.setOtherBusyCheck(() => recorder!.isActive() || scenarioCapture!.isActive())
    const exporter = new ExportManager()
    updater = new Updater()
    registerIpc({ recorder, scenarioCapture, scenarioPreview, exporter, updater, converter: new GifConverter() })

    agentControl = setupAgentControl({ recorder, scenarioCapture, scenarioPreview })
    if (agentWanted) void agentControl.enable()

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
    scenarioPreview?.dispose()
    agentControl?.dispose()
    updater?.dispose()
    void cleanupHelperScripts()
  })
}
