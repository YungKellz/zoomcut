import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import {
  flushedProject,
  launch,
  projectIds,
  readProject,
  restoreUserSettings,
  sleep,
  useEnglish,
  waitForBar,
  type Harness
} from './adv-helpers'

/**
 * Audio: recording with the microphone / system audio enabled, the Audio tab, music presets,
 * voiceover, undo, the sweep of orphaned clip files and the AAC track in the exported MP4.
 * System audio (WASAPI loopback) is not available on every machine – then the app must record
 * without it and say so in the notice bar instead of failing.
 */
let h: Harness
let projectId = ''

interface AudioClipJson {
  id: string
  kind: string
  file: string
  start: number
  durationMs: number
  loop: boolean
  volume: number
}

function audioClips(id: string): AudioClipJson[] {
  return (readProject(h.recordingsDir, id) as unknown as { audio?: AudioClipJson[] }).audio ?? []
}

function ffmpegInfo(file: string): string {
  const r = spawnSync(String(ffmpegStatic), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  return r.stderr
}

test.beforeAll(async () => {
  h = await launch('audio')
  await useEnglish(h.win)
})

test.afterAll(async () => {
  await restoreUserSettings(h.win)
  await h.app?.close()
})

test('recording with microphone and system audio enabled yields audio clips or a notice', async () => {
  const checks = h.win.locator('.audio-check input')
  await expect(checks).toHaveCount(2)
  await checks.nth(0).check()
  await checks.nth(1).check()
  await expect(h.win.locator('.mic-select')).toBeVisible()

  await h.win.click('.btn-record')
  const bar = await waitForBar(h.app)
  await bar.waitForSelector('.bar-dot-live', { timeout: 30_000 })
  await sleep(4000)
  await bar.click('.bar-stop')
  await h.win.waitForSelector('.editor', { timeout: 180_000 })
  await h.win.waitForSelector('.preview-loading', { state: 'detached', timeout: 60_000 })

  const ids = projectIds(h.recordingsDir)
  expect(ids).toHaveLength(1)
  projectId = ids[0]
  const clips = audioClips(projectId)
  const noticeVisible = (await h.win.locator('.notice-bar').count()) > 0
  const notice = noticeVisible ? await h.win.locator('.notice-bar').textContent() : null
  console.log('[audio] clips:', JSON.stringify(clips.map((c) => [c.kind, c.file, c.start, c.durationMs])), '| notice:', notice)

  // either the sources were captured, or the app explains why not – silently dropping them is a bug
  expect(clips.length > 0 || noticeVisible, 'no audio clip and no notice after recording with audio enabled').toBe(true)
  const files = readdirSync(join(h.recordingsDir, projectId))
  expect(files.filter((f) => f.endsWith('.webm')), 'raw audio files must be converted and removed').toEqual([])
  for (const c of clips) {
    expect(['mic', 'system']).toContain(c.kind)
    expect(c.file.endsWith('.m4a')).toBe(true)
    expect(existsSync(join(h.recordingsDir, projectId, c.file))).toBe(true)
    expect(c.durationMs).toBeGreaterThan(1000)
    // recorded clips sit at (or a little before) the first video frame
    expect(Math.abs(c.start)).toBeLessThan(2000)
  }
  if (noticeVisible) await h.win.click('.notice-bar .btn-ghost')

  await h.win.click('.tab:has-text("Audio")')
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(clips.length)
  await h.win.screenshot({ path: join(h.shotsDir, 'audio-tab.png') })
})

test('a music preset adds a looping clip on the timeline; undo and redo keep its file', async () => {
  await h.win.click('.tab:has-text("Audio")')
  const before = await h.win.locator('.audio-list .list-item').count()
  await h.win.click('.btn-add-music')
  await expect(h.win.locator('.music-presets .music-preset')).toHaveCount(5)
  await h.win.screenshot({ path: join(h.shotsDir, 'music-presets.png') })
  await h.win.locator('.btn-use-preset').first().click()
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(before + 1, { timeout: 90_000 })
  await expect(h.win.locator('.track-audio .region.audio:not(.recorded)')).toHaveCount(1)

  const project = await flushedProject(h.recordingsDir, projectId)
  const music = ((project as unknown as { audio: AudioClipJson[] }).audio ?? []).find((c) => c.kind === 'music')
  expect(music, 'the music clip must be saved in project.json').toBeTruthy()
  expect(music!.loop).toBe(true)
  expect(music!.durationMs).toBeGreaterThan(20_000)
  const musicFile = join(h.recordingsDir, projectId, music!.file)
  expect(existsSync(musicFile)).toBe(true)
  await h.win.screenshot({ path: join(h.shotsDir, 'timeline-audio-track.png') })

  // undo removes the clip from the project but must not destroy its file; redo brings it back intact
  await h.win.click('.timeline-toolbar .timeline-hint')
  await h.win.keyboard.press('Control+z')
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(before)
  await sleep(1100)
  expect(existsSync(musicFile), 'undo must keep the clip file').toBe(true)
  await h.win.keyboard.press('Control+y')
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(before + 1)
  await expect(h.win.locator('.audio-warn')).toHaveCount(0)
})

test('a voiceover recorded in the editor becomes a clip at the playhead', async () => {
  await h.win.click('.tab:has-text("Audio")')
  const before = await h.win.locator('.audio-list .list-item').count()
  await h.win.keyboard.press('Home')
  await h.win.click('.btn-voiceover')
  const started = await h.win
    .waitForSelector('.btn-voiceover.recording', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!started) {
    const err = await h.win.locator('.voiceover .error-box').textContent().catch(() => null)
    console.log('[voiceover] could not start (no microphone?):', err)
    expect(err, 'voiceover neither started nor reported an error').toBeTruthy()
    return
  }
  await sleep(2500)
  await h.win.click('.btn-voiceover')
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(before + 1, { timeout: 60_000 })
  const project = await flushedProject(h.recordingsDir, projectId)
  const vo = ((project as unknown as { audio: AudioClipJson[] }).audio ?? []).find((c) => c.kind === 'voiceover')
  expect(vo).toBeTruthy()
  expect(vo!.durationMs).toBeGreaterThan(1500)
  expect(Math.abs(vo!.start)).toBeLessThan(1500)
  expect(existsSync(join(h.recordingsDir, projectId, vo!.file))).toBe(true)
  // the editor is not stuck muted or recording afterwards
  await expect(h.win.locator('.btn-voiceover.recording')).toHaveCount(0)
})

test('MP4 export carries an AAC track, GIF export ignores audio', async () => {
  await h.win.click('button:has-text("Export")')
  await h.win.fill('input[placeholder="Choose a folder…"]', h.exportDir)
  await h.win.fill('.modal input[spellcheck="false"] >> nth=0', 'with-audio')
  await h.win.click('.seg-btn:has-text("MP4 video")')
  await h.win.click('button:has-text("Export MP4")')
  await h.win.waitForSelector('.export-result:has-text(".mp4")', { timeout: 180_000 })
  const mp4 = join(h.exportDir, 'with-audio.mp4')
  expect(existsSync(mp4)).toBe(true)
  const info = ffmpegInfo(mp4)
  console.log('[export] streams:', info.split(/\r?\n/).filter((l) => l.includes('Stream #')).join(' | '))
  expect(info).toMatch(/Video: h264/)
  expect(info).toMatch(/Audio: aac/)

  await h.win.click('.seg-btn:has-text("GIF animation")')
  await h.win.click('button:has-text("Export GIF")')
  await h.win.waitForSelector('.export-result:has-text(".gif")', { timeout: 180_000 })
  expect(existsSync(join(h.exportDir, 'with-audio.gif'))).toBe(true)
  await h.win.click('.modal-foot button:has-text("Close")')
})

test('a deleted clip keeps its file until the editor closes, then the orphan is swept', async () => {
  await h.win.click('.tab:has-text("Audio")')
  const clipsBefore = audioClips(projectId)
  const music = clipsBefore.find((c) => c.kind === 'music')
  expect(music).toBeTruthy()
  const musicFile = join(h.recordingsDir, projectId, music!.file)
  const row = h.win.locator('.audio-list .list-item').filter({ hasText: /calm|Calm|Спокой/ }).first()
  await row.locator('.btn-ghost.danger').click()
  await expect(h.win.locator('.audio-list .list-item')).toHaveCount(clipsBefore.length - 1)
  await sleep(1100)
  expect(existsSync(musicFile), 'the file must survive while the delete is undoable').toBe(true)

  await h.win.click('.editor-top button:has-text("Recordings")')
  await h.win.waitForSelector('.home')
  await sleep(2000)
  expect(existsSync(musicFile), 'closing the editor sweeps the orphaned clip file').toBe(false)
  for (const c of audioClips(projectId)) {
    expect(existsSync(join(h.recordingsDir, projectId, c.file)), `${c.kind} file must survive the sweep`).toBe(true)
  }
})

test('no unexpected renderer errors during the audio scenarios', async () => {
  const unexpected = h.errors.filter((e) => !/Autofill|Electron Security Warning/i.test(e))
  console.log('[console errors]', JSON.stringify(unexpected, null, 1))
  expect(unexpected, 'renderer console errors: ' + unexpected.join(' | ')).toEqual([])
})
