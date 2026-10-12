import { app, desktopCapturer, ipcMain, screen, type BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { AgentError, type AgentDataChanged, type AgentMcpConfig } from '@shared/agent'
import type { RecordingController } from '../recorder/controller'
import type { ScenarioCapture } from '../scenario/capture'
import type { ScenarioPreview } from '../scenario/preview'
import { deleteScenario, listScenarios, loadScenario, newScenarioId, saveScenario, scenarioDir } from '../scenario/storage'
import { deleteProject, exists, getSettings, listProjects, loadProject, projectDir } from '../storage'
import { getMainWindow } from '../windows'
import { bridgeSourcePath, buildMcpConfig, portableBridgePath } from './mcpConfig'
import { createAgentMethods, type AgentDisplayInfo } from './methods'
import { RendererBridge, type RendererTarget } from './rendererBridge'
import { AgentServer } from './server'

export const AGENT_CONTROL_FLAG = '--agent-control'
export const DISCOVERY_FILE = 'agent-control.json'

/** Agent control only runs when asked for: `--agent-control` on the command line, or ZOOMCUT_AGENT_CONTROL=1. */
export function agentControlRequested(argv: readonly string[]): boolean {
  return argv.includes(AGENT_CONTROL_FLAG) || process.env['ZOOMCUT_AGENT_CONTROL'] === '1'
}

export interface AgentControl {
  /** starts the loopback server and writes the discovery file; safe to call again */
  enable(): Promise<void>
  isEnabled(): boolean
  /** app quit: stops the server and removes the discovery file synchronously */
  dispose(): void
}

interface Deps {
  recorder: RecordingController
  scenarioCapture: ScenarioCapture
  scenarioPreview: ScenarioPreview
}

/** The main window as a place to send commands to; one adapter per window, since the bridge watches each for its end. */
function windowTargetProvider(): () => RendererTarget | null {
  let cached: { win: BrowserWindow; target: RendererTarget } | null = null
  return () => {
    const win = getMainWindow()
    if (!win) return null
    if (cached?.win !== win) {
      const contents = win.webContents
      cached = {
        win,
        target: {
          send: (command) => contents.send('agent:command', command),
          isLoaded: () => !contents.isDestroyed() && !contents.isLoading() && contents.getURL() !== '',
          onGone: (cb) => {
            win.once('closed', cb)
            contents.once('render-process-gone', cb)
          }
        }
      }
    }
    return cached.target
  }
}

function listDisplays(): AgentDisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    name: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary
  }))
}

async function captureScreen(display: AgentDisplayInfo, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }> {
  // the thumbnail is asked for at the display's size in DIP (never upscaled), so one image pixel is at least one DIP
  const width = Math.min(display.bounds.width, maxWidth)
  const height = Math.round((width * display.bounds.height) / display.bounds.width)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
  const index = screen.getAllDisplays().findIndex((d) => d.id === display.id)
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[index] ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new AgentError('failed', 'Windows did not return a picture of the screen')
  const size = source.thumbnail.getSize()
  return { png: source.thumbnail.toPNG(), width: size.width, height: size.height }
}

function mcpConfig(): Promise<AgentMcpConfig> {
  const portable = Boolean(process.env['PORTABLE_EXECUTABLE_DIR'])
  const config = buildMcpConfig({
    packaged: app.isPackaged,
    portable,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    portableExe: process.env['PORTABLE_EXECUTABLE_FILE']
  })
  // the config must not point at a file that is not there yet
  return (portable ? copyBridgeForPortable() : Promise.resolve()).then(() => config)
}

/** A portable exe unpacks to a new temp folder on every run, so MCP clients are pointed at a copy of the bridge in userData. */
async function copyBridgeForPortable(): Promise<void> {
  const from = bridgeSourcePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  const to = portableBridgePath(app.getPath('userData'))
  try {
    await fsp.mkdir(dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
  } catch (err) {
    console.warn('[agent] could not copy the MCP bridge for the portable build:', err)
  }
}

/**
 * Wires agent control into the app. The renderer-facing IPC (`agent:status`, `agent:reply`,
 * `agent:mcp-config`) is always registered – the UI shows the MCP configuration whether or not
 * this run has the control server on. The server itself (`enable()`) listens on a random
 * loopback port with a random token only when the run asked for it.
 */
export function setupAgentControl({ recorder, scenarioCapture, scenarioPreview }: Deps): AgentControl {
  const bridge = new RendererBridge(windowTargetProvider())
  ipcMain.handle('agent:reply', (_e, reply: unknown) => bridge.reply(reply))
  ipcMain.handle('agent:status', (_e, status: unknown) => bridge.setStatus(status))
  ipcMain.handle('agent:mcp-config', () => mcpConfig())

  const methods = createAgentMethods({
    version: app.getVersion(),
    recorder,
    capture: scenarioCapture,
    otherBusy: () => scenarioPreview.isActive(),
    renderer: bridge,
    displays: listDisplays,
    captureScreen,
    settings: getSettings,
    projects: {
      list: listProjects,
      load: loadProject,
      exists: (id) => exists(projectDir(id)),
      remove: deleteProject
    },
    scenarios: {
      list: listScenarios,
      load: loadScenario,
      exists: (id) => exists(scenarioDir(id)),
      remove: deleteScenario,
      newId: newScenarioId,
      reserve: async (id) => {
        const dir = scenarioDir(id)
        await fsp.mkdir(join(dir, 'shots'), { recursive: true })
        return dir
      },
      save: saveScenario
    },
    notifyChanged: (what) => {
      const message: AgentDataChanged = { what }
      getMainWindow()?.webContents.send('agent:data-changed', message)
    }
  })

  let server: AgentServer | null = null
  let starting: Promise<void> | null = null

  return {
    enable(): Promise<void> {
      if (server && starting) return starting
      const s = new AgentServer({ methods, discoveryPath: join(app.getPath('userData'), DISCOVERY_FILE), version: app.getVersion() })
      server = s
      starting = s.start().then(
        (info) => {
          console.log(`[agent] control server listening on 127.0.0.1:${info.port}`)
          if (process.env['PORTABLE_EXECUTABLE_DIR']) void copyBridgeForPortable()
        },
        (err) => {
          server = null
          starting = null
          console.error('[agent] control server could not start:', err)
        }
      )
      return starting
    },
    isEnabled: () => server !== null,
    dispose(): void {
      // stop() removes the discovery file before its first await, which is all that must happen while quitting
      void server?.stop()
      server = null
      bridge.rejectAll('no_window', 'ZoomCut is closing')
    }
  }
}
