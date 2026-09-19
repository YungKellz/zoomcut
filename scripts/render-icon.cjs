/* Renders build/logo.svg to build/icon.png (256×256, transparent) using Electron itself.
 * Usage: npx electron scripts/render-icon.cjs   (then: npm run icon:ico) */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const buildDir = path.join(__dirname, '..', 'build')
const svg = fs.readFileSync(path.join(buildDir, 'logo.svg'), 'utf8').replace('<svg', '<svg width="512" height="512"')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  fs.writeFileSync(path.join(buildDir, 'icon.png'), image.resize({ width: 256, height: 256 }).toPNG())
  console.log('wrote build/icon.png')
  app.quit()
})
