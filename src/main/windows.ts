import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { Rect } from '@shared/types'

let mainWindow: BrowserWindow | null = null

/** In development the exe has no icon, so point the window at the icon in build/. */
function windowIcon(): string | undefined {
  return app.isPackaged ? undefined : join(process.cwd(), 'build', 'icon.png')
}

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
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e0f12',
    autoHideMenuBar: true,
    title: 'ZoomCut',
    icon: windowIcon(),
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

/**
 * Transparent, click-through overlay drawn on top of the display during a scenario replay
 * (click ripples, typed text, the progress HUD). Must never take focus or show up in the
 * recording: content-protected, ignores mouse events, and shown inactive.
 */
export function createOverlayWindow(displayBounds: Rect): BrowserWindow {
  const overlay = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'ZoomCut overlay',
    webPreferences: webPreferences()
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setContentProtection(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.once('ready-to-show', () => overlay.showInactive())
  void loadRenderer(overlay, 'overlay')
  return overlay
}

/**
 * Test-only: a plain, visible window loading the E2eTarget page, used by the e2e suite to
 * drive real mouse/keyboard input against known real screen coordinates. Only ever created
 * behind the `e2e:open-target` IPC handler, itself gated on ZOOMCUT_E2E.
 */
export function createE2eTargetWindow(bounds: Rect): BrowserWindow {
  const win = new BrowserWindow({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    frame: true,
    alwaysOnTop: true,
    title: 'ZoomCut e2e target',
    webPreferences: webPreferences()
  })
  win.once('ready-to-show', () => win.show())
  void loadRenderer(win, 'target')
  return win
}
