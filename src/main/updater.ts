import { app, BrowserWindow } from 'electron'
import { promises as fsp, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

const FIRST_CHECK_DELAY_MS = 8_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LOG_MAX_BYTES = 256 * 1024

/**
 * Background updates for the installed (NSIS) build, backed by electron-updater and the
 * GitHub Releases feed that electron-builder writes into resources/app-update.yml.
 *
 * The app checks shortly after start and every few hours, downloads a newer installer
 * quietly and pushes the state to the renderer, which offers "Restart and update"; an
 * update that was not applied by hand is installed silently when the app quits. The
 * portable exe, unpackaged dev runs and e2e runs report `disabled` with a reason, so the
 * UI can hide or explain the feature.
 *
 * Environment overrides for testing:
 *   ZOOMCUT_UPDATE_URL=http://host/folder/  read a generic feed (a folder with latest.yml
 *                                           and the installer) instead of GitHub, also in dev
 *   ZOOMCUT_UPDATE_CHECK=1                  keep the updater on under ZOOMCUT_E2E
 * Under ZOOMCUT_E2E nothing is ever installed on quit.
 */
export class Updater {
  private state: UpdateState
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private manualCheck = false
  private readonly logPath = join(app.getPath('userData'), 'updater.log')
  private logQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.state = {
      status: 'disabled',
      reason: disabledReason(),
      currentVersion: app.getVersion(),
      version: null,
      percent: 0,
      message: null,
      checkedAt: null
    }
  }

  getState(): UpdateState {
    return this.state
  }

  /** Configures electron-updater and schedules the checks. Does nothing when disabled. */
  start(): void {
    if (this.started || this.state.reason !== null) return
    this.started = true
    const testing = Boolean(process.env['ZOOMCUT_E2E'])

    autoUpdater.logger = {
      info: (m: unknown) => this.log('info', m),
      warn: (m: unknown) => this.log('warn', m),
      error: (m: unknown) => this.log('error', m)
    }
    autoUpdater.autoDownload = true
    // tests must never spawn the (fake) installer when the app closes
    autoUpdater.autoInstallOnAppQuit = !testing
    autoUpdater.allowPrerelease = false
    autoUpdater.disableWebInstaller = true

    const feedUrl = process.env['ZOOMCUT_UPDATE_URL']
    if (feedUrl) {
      // electron-updater takes the provider and the cache dir name from a yml file
      // (resources/app-update.yml when packaged, dev-app-update.yml otherwise); pointing it
      // at our own file makes the override work in both cases.
      const configPath = join(app.getPath('userData'), 'update-feed.yml')
      const cacheDir = testing ? 'zoomcut-updater-test' : 'zoomcut-updater'
      writeFileSync(configPath, `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: ${cacheDir}\n`, 'utf8')
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.updateConfigPath = configPath
    }

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', message: null }))
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'downloaded', version: info.version, percent: 100, checkedAt: Date.now() })
    )
    autoUpdater.on('update-not-available', () =>
      this.set({ status: 'upToDate', version: null, percent: 0, checkedAt: Date.now() })
    )
    autoUpdater.on('update-cancelled', () => this.set({ status: 'idle', version: null, percent: 0 }))
    autoUpdater.on('error', (err) => {
      // a failed re-check (offline) must not hide an update that is already downloaded
      if (this.state.status === 'downloaded') return
      // automatic checks fail quietly (the log has the details); a manual check shows why
      if (!this.manualCheck) {
        this.set({ status: 'idle', version: null, percent: 0, checkedAt: Date.now() })
        return
      }
      this.set({ status: 'error', version: null, percent: 0, message: shortMessage(err), checkedAt: Date.now() })
    })

    this.set({ status: 'idle' })
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  /** One check; resolves once the feed has answered. Errors end up in the state, not here. */
  async check(manual = false): Promise<UpdateState> {
    const s = this.state.status
    if (this.state.reason !== null || s === 'checking' || s === 'available' || s === 'downloading' || s === 'downloaded') {
      return this.state
    }
    this.manualCheck = manual
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // also reported through the 'error' event
      this.log('error', shortMessage(err))
    } finally {
      this.manualCheck = false
    }
    return this.state
  }

  /** Quits, installs the downloaded update silently into the same folder and relaunches. */
  install(): void {
    if (this.state.status !== 'downloaded') throw new Error('No update has been downloaded')
    autoUpdater.quitAndInstall(true, true)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:changed', this.state)
    }
  }

  /** Small rolling log in userData (updater.log) for "why did it not update" questions. */
  private log(level: string, message: unknown): void {
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message)
    const line = `${new Date().toISOString()} ${level} ${text}\n`
    this.logQueue = this.logQueue.then(async () => {
      try {
        const size = await fsp.stat(this.logPath).then((st) => st.size).catch(() => 0)
        if (size > LOG_MAX_BYTES) await fsp.rm(this.logPath, { force: true })
        await fsp.appendFile(this.logPath, line, 'utf8')
      } catch {
        // logging must never break the updater
      }
    })
  }
}

function disabledReason(): UpdateState['reason'] {
  if (process.env['ZOOMCUT_UPDATE_URL'] || process.env['ZOOMCUT_UPDATE_CHECK']) return null
  // electron-builder's portable launcher sets this; a portable exe cannot be replaced in place
  if (process.env['PORTABLE_EXECUTABLE_DIR']) return 'portable'
  if (!app.isPackaged) return 'dev'
  if (process.env['ZOOMCUT_E2E']) return 'test'
  return null
}

function shortMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.split('\n')[0].slice(0, 200)
}
