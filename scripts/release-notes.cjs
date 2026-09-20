#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version plus the install footer. The release
// workflow uses the output as the body of the GitHub release:
//   node scripts/release-notes.cjs 0.2.0   (a leading "v" is accepted)
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const version = (process.argv[2] || '').replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.cjs <version>')
  process.exit(1)
}

const lines = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8').split(/\r?\n/)
const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `))
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
if (end < 0) end = lines.length
const body = lines.slice(start + 1, end).join('\n').trim()

const setup = `ZoomCut-Setup-${version}-x64.exe`
const portable = `ZoomCut-Portable-${version}-x64.exe`
const footer = [
  `**Установка:** скачайте \`${setup}\` и запустите. Файл не подписан сертификатом, поэтому Windows SmartScreen ` +
    'покажет предупреждение: нажмите «Подробнее» → «Выполнить в любом случае». Установленная версия дальше ' +
    `обновляется сама. \`${portable}\` работает без установки, но не обновляется автоматически.`,
  `**Install:** download \`${setup}\` and run it. The file is not code-signed, so Windows SmartScreen warns: ` +
    `click "More info" → "Run anyway". The installed app updates itself from then on. \`${portable}\` runs ` +
    'without installing but does not auto-update.'
]

process.stdout.write(`${body}\n\n---\n\n${footer.join('\n\n')}\n`)
