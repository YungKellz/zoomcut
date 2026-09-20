import { _electron as electron, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { restoreUserSettings, tmpRoot, useEnglish } from './adv-helpers'

/**
 * Auto-update against a local feed: a folder with a latest.yml announcing version 9.9.9
 * and a dummy installer, served over HTTP. ZOOMCUT_UPDATE_URL points the app at it, so
 * the check, the download and the sha512 verification run for real through
 * electron-updater. Only the install step is left out: the test never clicks
 * "Restart and update", and under ZOOMCUT_E2E nothing is installed on quit either.
 */
const feedDir = join(tmpRoot, 'update-feed')
const recordingsDir = join(tmpRoot, 'update-recordings')
// electron-updater keeps downloads in %LOCALAPPDATA%\<updaterCacheDirName>; tests use their own name
const cacheDir = join(process.env['LOCALAPPDATA'] ?? join(tmpRoot, 'localappdata'), 'zoomcut-updater-test')

const INSTALLER_NAME = 'ZoomCut-Setup-9.9.9-x64.exe'

function buildFeed(): number {
  rmSync(feedDir, { recursive: true, force: true })
  mkdirSync(feedDir, { recursive: true })
  const installer = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < installer.length; i++) installer[i] = (i * 7919) & 0xff
  writeFileSync(join(feedDir, INSTALLER_NAME), installer)
  const sha512 = createHash('sha512').update(installer).digest('base64')
  writeFileSync(
    join(feedDir, 'latest.yml'),
    [
      'version: 9.9.9',
      'files:',
      `  - url: ${INSTALLER_NAME}`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`,
      `path: ${INSTALLER_NAME}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-09-21T00:00:00.000Z'",
      ''
    ].join('\n')
  )
  return installer.length
}

function serveFeed(requested: string[]): Promise<Server> {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''))
      requested.push(name)
      const file = join(feedDir, name)
      if (!name || name.includes('..') || !existsSync(file)) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      const data = readFileSync(file)
      res.setHeader('Content-Type', name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream')
      res.setHeader('Content-Length', data.length)
      res.end(data)
    })
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

test('update: a newer version in the feed is downloaded and offered', async () => {
  const installerSize = buildFeed()
  const requested: string[] = []
  const server = await serveFeed(requested)
  const port = (server.address() as AddressInfo).port
  rmSync(cacheDir, { recursive: true, force: true })
  rmSync(recordingsDir, { recursive: true, force: true })
  mkdirSync(recordingsDir, { recursive: true })

  const exe = process.env['ZOOMCUT_EXE']
  const app = await electron.launch({
    ...(exe ? { executablePath: resolve(exe) } : { args: ['.'] }),
    env: {
      ...process.env,
      ZOOMCUT_RECORDINGS_DIR: recordingsDir,
      ZOOMCUT_E2E: '1',
      ZOOMCUT_UPDATE_URL: `http://127.0.0.1:${port}/`
    }
  })
  const errors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    win.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
    await useEnglish(win)

    // no update card before anything was found
    await expect(win.locator('.update-toast')).toHaveCount(0)
    // the manual check (the automatic one fires a few seconds after start anyway)
    await win
      .locator('.update-status button:has-text("Check for updates")')
      .click({ timeout: 3000 })
      .catch(() => undefined)

    await expect(win.locator('.update-status[data-status="downloaded"]')).toBeVisible({ timeout: 60_000 })
    const toast = win.locator('.update-toast')
    await expect(toast).toContainText('9.9.9')
    await expect(toast.locator('button:has-text("Restart and update")')).toBeVisible()

    expect(requested).toContain('latest.yml')
    expect(requested).toContain(INSTALLER_NAME)
    // the installer landed in the updater cache, verified against the sha512 of the feed
    const pendingDir = join(cacheDir, 'pending')
    const downloaded = existsSync(pendingDir)
      ? readdirSync(pendingDir).filter((f) => statSync(join(pendingDir, f)).size === installerSize)
      : []
    expect(downloaded.length).toBe(1)

    // "Later" hides the card; the status line keeps offering the restart
    await toast.locator('button:has-text("Later")').click()
    await expect(toast).toHaveCount(0)
    await expect(win.locator('.update-status button:has-text("Restart and update")')).toBeVisible()

    expect(errors).toEqual([])
    await restoreUserSettings(win)
  } finally {
    await app.close()
    server.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})
