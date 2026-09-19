import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { ExportFinishResult, ExportProgress, ExportSettings, GifSettings } from '@shared/types'
import { GIF_FPS_OPTIONS, MP4_FPS_OPTIONS, SCALE_OPTIONS } from '@shared/defaults'
import { useProject, useStore } from '../store'
import type { FollowPath } from '../engine/cursor'
import { outputSize, TRANSPARENT_BACKGROUND } from '../engine/compose'
import { keepSegments, outputDuration } from '../engine/timeline'
import { runExport, type RenderProgress } from '../export/exporter'
import { estimateExportSize, type SizeEstimate } from '../export/estimate'
import { formatBytes, formatDuration } from '../util/format'
import { useT, type TKey } from '../i18n'

interface Props {
  followPath: FollowPath | null
}

const GIF_PRESETS: Array<{ id: string; label: TKey; hint: TKey; apply: (s: ExportSettings) => ExportSettings }> = [
  {
    id: 'crisp',
    label: 'export.preset.crisp',
    hint: 'export.preset.crispHint',
    apply: (s) => ({ ...s, fps: 15, gif: { ...s.gif, colors: 256, dither: 'none', paletteMode: 'diff' } })
  },
  {
    id: 'smooth',
    label: 'export.preset.smooth',
    hint: 'export.preset.smoothHint',
    apply: (s) => ({ ...s, fps: 15, gif: { ...s.gif, colors: 256, dither: 'sierra2_4a', paletteMode: 'diff' } })
  },
  {
    id: 'small',
    label: 'export.preset.small',
    hint: 'export.preset.smallHint',
    apply: (s) => ({ ...s, fps: 10, scale: 0.5, gif: { ...s.gif, colors: 64, dither: 'bayer', bayerScale: 3, paletteMode: 'global' } })
  }
]

export function ExportDialog({ followPath }: Props): JSX.Element {
  const t = useT()
  const project = useProject()
  const setExportOpen = useStore((s) => s.setExportOpen)
  const updateExport = useStore((s) => s.updateExport)
  const [settings, setSettings] = useState<ExportSettings>(() => ({
    ...project.export,
    fileName: project.export.fileName || project.name.replace(/[^\w\- ]+/g, '').trim() || 'recording'
  }))
  const [running, setRunning] = useState(false)
  const [render, setRender] = useState<RenderProgress | null>(null)
  const [ffmpeg, setFfmpeg] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportFinishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<SizeEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const probeVideo = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!settings.folder) {
      void window.zc.app.getSettings().then((s) => {
        if (s.lastExportFolder) setSettings((cur) => ({ ...cur, folder: s.lastExportFolder! }))
      })
    }
  }, [settings.folder])

  useEffect(() => window.zc.export.onProgress(setFfmpeg), [])

  const segments = useMemo(() => keepSegments(project.recording.durationMs, project.cuts), [project.recording.durationMs, project.cuts])
  const outMs = outputDuration(segments)
  const size = outputSize(project, settings.scale)
  const frames = Math.round((outMs / 1000) * settings.fps)
  const fpsOptions = settings.format === 'gif' ? GIF_FPS_OPTIONS : MP4_FPS_OPTIONS
  const transparent = project.frame.background === TRANSPARENT_BACKGROUND

  // rough size estimate, recomputed (debounced) when anything relevant changes
  const estimateKey = JSON.stringify([settings.format, settings.scale, settings.fps, settings.mp4Quality, settings.gif, project.cuts, project.zooms.length, project.crop, project.frame])
  useEffect(() => {
    const video = probeVideo.current
    if (!video || running) return
    const abort = new AbortController()
    setEstimating(true)
    const timer = window.setTimeout(async () => {
      try {
        if (video.readyState < 1) {
          await new Promise<void>((resolve) => {
            video.addEventListener('loadedmetadata', () => resolve(), { once: true })
            video.load()
          })
        }
        const est = await estimateExportSize(project, settings, followPath, video, abort.signal)
        if (!abort.signal.aborted) setEstimate(est)
      } catch (err) {
        console.error('size estimate failed', err)
        if (!abort.signal.aborted) setEstimate(null)
      } finally {
        if (!abort.signal.aborted) setEstimating(false)
      }
    }, 350)
    return () => {
      abort.abort()
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, running])

  const set = (patch: Partial<ExportSettings>): void => setSettings((s) => ({ ...s, ...patch }))
  const setGif = (patch: Partial<GifSettings>): void => setSettings((s) => ({ ...s, gif: { ...s.gif, ...patch } }))

  const chooseFolder = async (): Promise<void> => {
    const folder = await window.zc.app.chooseFolder(settings.folder || undefined)
    if (folder) set({ folder })
  }

  const start = async (): Promise<void> => {
    if (!settings.folder) {
      await chooseFolder()
      return
    }
    const effective: ExportSettings = { ...settings, fps: fpsOptions.includes(settings.fps) ? settings.fps : fpsOptions[0] }
    updateExport(effective)
    setRunning(true)
    setError(null)
    setResult(null)
    setRender({ phase: 'render', percent: 0 })
    setFfmpeg(null)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const res = await runExport({ project, settings: effective, followPath, onProgress: setRender, signal: abort.signal })
      setResult(res)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const cancel = (): void => abortRef.current?.abort()

  const close = (): void => {
    if (running) cancel()
    setExportOpen(false)
  }

  const ffmpegLabel =
    ffmpeg?.phase === 'palette' ? t('export.palettePhase') : ffmpeg?.phase === 'quantize' ? t('export.writingGif') : t('export.encodingMp4')

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('export.title')}</h2>
          <button className="btn btn-ghost" onClick={close} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="seg wide">
            <button
              className={'seg-btn' + (settings.format === 'mp4' ? ' active' : '')}
              disabled={running}
              onClick={() => set({ format: 'mp4', fps: MP4_FPS_OPTIONS.includes(settings.fps) ? settings.fps : 30 })}
            >
              {t('export.mp4')}
            </button>
            <button
              className={'seg-btn' + (settings.format === 'gif' ? ' active' : '')}
              disabled={running}
              onClick={() =>
                set({
                  format: 'gif',
                  fps: GIF_FPS_OPTIONS.includes(settings.fps) ? settings.fps : 15,
                  // big GIFs get huge fast: default to half size for large recordings
                  scale: settings.scale === 1 && outputSize(project, 1).outW > 1400 ? 0.5 : settings.scale
                })
              }
            >
              {t('export.gif')}
            </button>
          </div>

          <div className="row2">
            <label className="field">
              <span className="field-label">{t('export.fileName')}</span>
              <input value={settings.fileName} disabled={running} onChange={(e) => set({ fileName: e.target.value })} spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-label">{t('export.folder')}</span>
              <div className="folder-row">
                <input value={settings.folder} disabled={running} onChange={(e) => set({ folder: e.target.value })} spellCheck={false} placeholder={t('export.chooseFolder')} />
                <button className="btn btn-ghost" onClick={() => void chooseFolder()} disabled={running} title={t('export.folder')}>
                  <FolderOpen size={15} />
                </button>
              </div>
            </label>
          </div>

          <div className="row2">
            <label className="field">
              <span className="field-label">{t('export.size')}</span>
              <div className="seg">
                {SCALE_OPTIONS.map((s) => (
                  <button key={s} className={'seg-btn' + (settings.scale === s ? ' active' : '')} disabled={running} onClick={() => set({ scale: s })}>
                    {Math.round(s * 100)}%
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span className="field-label">{t('export.fps')}</span>
              <div className="seg">
                {fpsOptions.map((f) => (
                  <button key={f} className={'seg-btn' + (settings.fps === f ? ' active' : '')} disabled={running} onClick={() => set({ fps: f })}>
                    {f}
                  </button>
                ))}
              </div>
            </label>
          </div>

          {settings.format === 'mp4' ? (
            <label className="field">
              <span className="field-label">{t('export.quality')}</span>
              <div className="seg">
                {(['low', 'medium', 'high', 'max'] as const).map((q) => (
                  <button key={q} className={'seg-btn' + (settings.mp4Quality === q ? ' active' : '')} disabled={running} onClick={() => set({ mp4Quality: q })}>
                    {t(`export.q.${q}`)}
                  </button>
                ))}
              </div>
              <span className="field-hint">{t('export.qualityHelp')}</span>
            </label>
          ) : (
            <>
              <div className="field">
                <span className="field-label">{t('export.presets')}</span>
                <div className="btn-row">
                  {GIF_PRESETS.map((p) => (
                    <button key={p.id} className="btn btn-small" disabled={running} title={t(p.hint)} onClick={() => setSettings(p.apply)}>
                      {t(p.label)}
                    </button>
                  ))}
                </div>
              </div>
              <details className="adv">
                <summary>{t('common.advanced')}</summary>
                <div className="row2">
                  <label className="field">
                    <span className="field-label">{t('export.colors')}</span>
                    <div className="seg">
                      {([256, 128, 64, 32] as const).map((c) => (
                        <button key={c} className={'seg-btn' + (settings.gif.colors === c ? ' active' : '')} disabled={running} onClick={() => setGif({ colors: c })}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label className="field">
                    <span className="field-label">{t('export.palette')}</span>
                    <select value={settings.gif.paletteMode} disabled={running} onChange={(e) => setGif({ paletteMode: e.target.value as GifSettings['paletteMode'] })}>
                      <option value="diff">{t('export.palette.diff')}</option>
                      <option value="global">{t('export.palette.global')}</option>
                      <option value="perframe">{t('export.palette.perframe')}</option>
                    </select>
                  </label>
                </div>
                <div className="row2">
                  <label className="field">
                    <span className="field-label">{t('export.dither')}</span>
                    <select value={settings.gif.dither} disabled={running} onChange={(e) => setGif({ dither: e.target.value as GifSettings['dither'] })}>
                      <option value="none">{t('export.dither.none')}</option>
                      <option value="sierra2_4a">{t('export.dither.sierra')}</option>
                      <option value="floyd_steinberg">{t('export.dither.fs')}</option>
                      <option value="bayer">{t('export.dither.bayer')}</option>
                    </select>
                  </label>
                  {settings.gif.dither === 'bayer' ? (
                    <label className="field">
                      <span className="field-label">{t('export.bayerScale', { n: settings.gif.bayerScale })}</span>
                      <input type="range" min={0} max={5} step={1} value={settings.gif.bayerScale} disabled={running} onChange={(e) => setGif({ bayerScale: Number(e.target.value) })} />
                    </label>
                  ) : (
                    <label className="field field-row">
                      <input type="checkbox" checked={settings.gif.loop} disabled={running} onChange={(e) => setGif({ loop: e.target.checked })} />
                      <span className="field-label">{t('export.loop')}</span>
                    </label>
                  )}
                </div>
              </details>
            </>
          )}

          <p className="muted small">
            {t('export.output', { w: size.outW, h: size.outH, duration: formatDuration(outMs), frames, fps: settings.fps })}
            {settings.format === 'gif' && size.outW > 1280 && ` · ${t('export.largeGif')}`}
            {' · '}
            {estimating || !estimate ? t('export.estimating') : t('export.estimate', { size: formatBytes(estimate.bytes) })}
          </p>
          {transparent && settings.format === 'mp4' && <p className="warn small">{t('export.transparentMp4')}</p>}

          {(running || result || error) && (
            <div className="export-status">
              {render && (
                <div className="progress-line">
                  <span>
                    {t('export.rendering')}
                    {render.frames ? ` (${render.frame ?? 0}/${render.frames})` : ''}
                  </span>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${render.phase === 'finalize' || result ? 100 : render.percent}%` }} />
                  </div>
                </div>
              )}
              {(render?.phase === 'finalize' || result || ffmpeg) && (
                <div className="progress-line">
                  <span>{result ? t('export.done') : ffmpegLabel}</span>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${result ? 100 : (ffmpeg?.percent ?? 0)}%` }} />
                  </div>
                </div>
              )}
              {result && (
                <div className="export-result">
                  <strong>{formatBytes(result.bytes)}</strong> · {result.outputPath}
                  <div className="btn-row">
                    <button className="btn btn-small" onClick={() => void window.zc.app.openPath(result.outputPath)}>
                      {t('common.open')}
                    </button>
                    <button className="btn btn-small" onClick={() => void window.zc.app.showInFolder(result.outputPath)}>
                      {t('common.showInFolder')}
                    </button>
                  </div>
                </div>
              )}
              {error && <div className="error-box">{error}</div>}
            </div>
          )}
        </div>

        <div className="modal-foot">
          {running ? (
            <button className="btn" onClick={cancel}>
              {t('common.cancel')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {t('common.close')}
              </button>
              <button className="btn btn-primary" onClick={() => void start()} disabled={!settings.fileName.trim() || outMs <= 0}>
                {t('export.run', { format: settings.format.toUpperCase() })}
              </button>
            </>
          )}
        </div>
        <video
          ref={probeVideo}
          className="hidden-video"
          muted
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          src={window.zc.media.url(project.recording.videoPath)}
        />
      </div>
    </div>
  )
}
