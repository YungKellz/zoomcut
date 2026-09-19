/* Renders build/logo.svg to build/icon.png (256×256, transparent) using Electron itself.
 * The SVG is drawn onto a canvas inside a hidden window, so no window edges end up in the icon.
 * Usage: npx electron scripts/render-icon.cjs, then convert with ffmpeg:
 *   ffmpeg -y -i build/icon.png build/icon.ico */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const buildDir = path.join(__dirname, '..', 'build')
const svg = fs.readFileSync(path.join(buildDir, 'logo.svg'), 'utf8').replace('<svg', '<svg width="256" height="256"')

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="256" height="256"></canvas>
<script>
window.render = () => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => {
    const c = document.getElementById('c')
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, 256, 256)
    ctx.drawImage(img, 0, 0, 256, 256)
    resolve(c.toDataURL('image/png'))
  }
  img.onerror = () => reject(new Error('svg failed to load'))
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)})
})
</script></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const dataUrl = await win.webContents.executeJavaScript('window.render()')
  fs.writeFileSync(path.join(buildDir, 'icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote build/icon.png')
  app.quit()
})
