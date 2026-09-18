import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { Rect } from '@shared/types'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    spellcheck: false
  }
}

export function loadRenderer(win: BrowserWindow, hash = ''): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    return win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e0f12',
    autoHideMenuBar: true,
    title: 'ZoomCut',
    webPreferences: webPreferences()
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void loadRenderer(mainWindow)
  return mainWindow
}

export const BAR_WIDTH = 330
export const BAR_HEIGHT = 74

/**
 * The floating recorder bar: frameless, always on top and excluded from screen capture
 * (setContentProtection), so it never shows up in the recording.
 */
export function createBarWindow(displayBounds: Rect): BrowserWindow {
  const bar = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x: Math.round(displayBounds.x + (displayBounds.width - BAR_WIDTH) / 2),
    y: Math.round(displayBounds.y + displayBounds.height - BAR_HEIGHT - 28),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'ZoomCut recorder',
    webPreferences: webPreferences()
  })
  bar.setContentProtection(true)
  bar.setAlwaysOnTop(true, 'screen-saver')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bar.once('ready-to-show', () => bar.showInactive())
  void loadRenderer(bar, 'bar')
  return bar
}
