import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FileVideo, FolderOpen, X } from 'lucide-react'
import type { ExportFinishResult, GifConvertProgress, GifSettings, VideoFileInfo } from '@shared/types'
import { DEFAULT_GIF_SETTINGS, GIF_FPS_OPTIONS } from '@shared/defaults'
import { formatBytes, formatDuration } from '../util/format'
import { useT, type TKey } from '../i18n'

interface Props {
  onClose(): void
}

/** Output widths offered for the GIF (only those not larger than the video are shown). */
const WIDTH_OPTIONS = [1280, 960, 800, 640, 480, 320]

interface Options {
  fps: number
  width: number
  startMs: number
  endMs: number
  gif: GifSettings
}

const PRESETS: Array<{ id: string; label: TKey; hint: TKey; apply: (o: Options, video: VideoFileInfo) => Options }> = [
  {
    id: 'crisp',
    label: 'export.preset.crisp',
    hint: 'export.preset.crispHint',
    apply: (o) => ({ ...o, fps: 15, gif: { ...o.gif, colors: 256, dither: 'none', paletteMode: 'diff' } })
  },
  {
    id: 'smooth',
    label: 'export.preset.smooth',
    hint: 'export.preset.smoothHint',
    apply: (o) => ({ ...o, fps: 15, gif: { ...o.gif, colors: 256, dither: 'sierra2_4a', paletteMode: 'diff' } })
  },
  {
    id: 'small',
    label: 'export.preset.small',
    hint: 'export.preset.smallHint',
    apply: (o, v) => ({ ...o, fps: 10, width: Math.min(o.width, Math.max(320, Math.round(v.width / 2))), gif: { ...o.gif, colors: 64, dither: 'bayer', bayerScale: 3, paletteMode: 'global' } })
  }
]

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

/** Standalone "MP4 → GIF": picks any video file and runs it through ffmpeg's two-pass GIF encode. */
export function GifConverterDialog({ onClose }: Props): JSX.Element {
  const t = useT()
  const [video, setVideo] = useState<VideoFileInfo | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [fileName, setFileName] = useState('')
  const [folder, setFolder] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<GifConvertProgress | null>(null)
  const [result, setResult] = useState<ExportFinishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const runningRef = useRef(false)
  runningRef.current = running

  useEffect(() => window.zc.converter.onProgress(setProgress), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (runningRef.current) void window.zc.converter.cancel()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = async (): Promise<void> => {
    setError(null)
    try {
      const info = await window.zc.converter.chooseVideo()
      if (!info) return
      const settings = await window.zc.app.getSettings()
      setVideo(info)
      setPreviewFailed(false)
      setResult(null)
      setProgress(null)
      setFileName(info.name)
      setFolder((cur) => cur || settings.lastExportFolder || dirname(info.path))
      setOptions({
        fps: 15,
        width: Math.min(info.width, info.width > 1400 ? 960 : info.width),
        startMs: 0,
        endMs: info.durationMs,
        gif: { ...DEFAULT_GIF_SETTINGS }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseFolder = async (): Promise<void> => {
    const chosen = await window.zc.app.chooseFolder(folder || undefined)
    if (chosen) setFolder(chosen)
  }

  const set = (patch: Partial<Options>): void => setOptions((o) => (o ? { ...o, ...patch } : o))
  const setGif = (patch: Partial<GifSettings>): void => setOptions((o) => (o ? { ...o, gif: { ...o.gif, ...patch } } : o))

  const run = async (): Promise<void> => {
    if (!video || !options) return
    if (!folder) {
      await chooseFolder()
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress(null)
    try {
      setResult(
        await window.zc.converter.toGif({
          input: video.path,
          folder,
          fileName: fileName.trim() || video.name,
          fps: options.fps,
          width: options.width,
          startMs: options.startMs,
          endMs: options.endMs,
          gif: options.gif
        })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/cancelled/i.test(message)) setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setRunning(false)
    }
  }

  const close = (): void => {
    if (running) void window.zc.converter.cancel()
    onClose()
  }

  const widths = video ? [video.width, ...WIDTH_OPTIONS.filter((w) => w < video.width)] : []
  const outH = video && options ? Math.round((options.width / video.width) * video.height / 2) * 2 : 0
  const spanMs = options ? Math.max(0, options.endMs - options.startMs) : 0
  const phaseLabel = progress?.phase === 'palette' ? t('export.palettePhase') : t('export.writingGif')

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('converter.title')}</h2>
          <button className="btn btn-ghost" onClick={close} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="converter-file">
            <button className="btn" onClick={() => void choose()} disabled={running}>
              <FileVideo size={15} /> {video ? t('converter.chooseOther') : t('converter.choose')}
            </button>
            {video ? (
              <span className="muted small converter-file-info" title={video.path}>
                {video.path} · {video.width}×{video.height} · {Math.round(video.fps)} fps · {formatDuration(video.durationMs)}
              </span>
            ) : (
              <span className="muted small">{t('converter.help')}</span>
            )}
          </div>

          {video && !previewFailed && (
            <video
              className="converter-preview"
              src={window.zc.media.url(video.path)}
              controls
              muted
              preload="metadata"
              onError={() => setPreviewFailed(true)}
            />
          )}

          {video && options && (
            <>
              <div className="row2">
                <label className="field">
                  <span className="field-label">{t('export.fileName')}</span>
                  <input value={fileName} disabled={running} onChange={(e) => setFileName(e.target.value)} spellCheck={false} />
                </label>
                <label className="field">
                  <span className="field-label">{t('export.folder')}</span>
                  <div className="folder-row">
                    <input value={folder} disabled={running} onChange={(e) => setFolder(e.target.value)} spellCheck={false} placeholder={t('export.chooseFolder')} />
                    <button className="btn btn-ghost" onClick={() => void chooseFolder()} disabled={running} title={t('export.folder')}>
                      <FolderOpen size={15} />
                    </button>
                  </div>
                </label>
              </div>

              <div className="row2">
                <label className="field">
                  <span className="field-label">{t('converter.width')}</span>
                  <select value={options.width} disabled={running} onChange={(e) => set({ width: Number(e.target.value) })}>
                    {widths.map((w) => (
                      <option key={w} value={w}>
                        {w === video.width ? t('converter.widthOriginal', { w }) : `${w} px`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{t('export.fps')}</span>
                  <div className="seg">
                    {GIF_FPS_OPTIONS.map((f) => (
                      <button key={f} className={'seg-btn' + (options.fps === f ? ' active' : '')} disabled={running} onClick={() => set({ fps: f })}>
                        {f}
                      </button>
                    ))}
                  </div>
                </label>
              </div>

              <div className="row2">
                <label className="field">
                  <span className="field-label">{t('converter.start')}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(options.startMs / 1000).toFixed(1)}
                    disabled={running}
                    onChange={(e) => set({ startMs: Math.max(0, Math.min(options.endMs - 100, Number(e.target.value) * 1000)) })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('converter.end')}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(options.endMs / 1000).toFixed(1)}
                    disabled={running}
                    onChange={(e) => set({ endMs: Math.min(video.durationMs, Math.max(options.startMs + 100, Number(e.target.value) * 1000)) })}
                  />
                </label>
              </div>

              <div className="field">
                <span className="field-label">{t('export.presets')}</span>
                <div className="btn-row">
                  {PRESETS.map((p) => (
                    <button key={p.id} className="btn btn-small" disabled={running} title={t(p.hint)} onClick={() => setOptions((o) => (o ? p.apply(o, video) : o))}>
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
                        <button key={c} className={'seg-btn' + (options.gif.colors === c ? ' active' : '')} disabled={running} onClick={() => setGif({ colors: c })}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label className="field">
                    <span className="field-label">{t('export.palette')}</span>
                    <select value={options.gif.paletteMode} disabled={running} onChange={(e) => setGif({ paletteMode: e.target.value as GifSettings['paletteMode'] })}>
                      <option value="diff">{t('export.palette.diff')}</option>
                      <option value="global">{t('export.palette.global')}</option>
                      <option value="perframe">{t('export.palette.perframe')}</option>
                    </select>
                  </label>
                </div>
                <div className="row2">
                  <label className="field">
                    <span className="field-label">{t('export.dither')}</span>
                    <select value={options.gif.dither} disabled={running} onChange={(e) => setGif({ dither: e.target.value as GifSettings['dither'] })}>
                      <option value="none">{t('export.dither.none')}</option>
                      <option value="sierra2_4a">{t('export.dither.sierra')}</option>
                      <option value="floyd_steinberg">{t('export.dither.fs')}</option>
                      <option value="bayer">{t('export.dither.bayer')}</option>
                    </select>
                  </label>
                  {options.gif.dither === 'bayer' && (
                    <label className="field">
                      <span className="field-label">{t('export.bayerScale', { n: options.gif.bayerScale })}</span>
                      <input type="range" min={0} max={5} step={1} value={options.gif.bayerScale} disabled={running} onChange={(e) => setGif({ bayerScale: Number(e.target.value) })} />
                    </label>
                  )}
                </div>
                <label className="field field-row">
                  <input type="checkbox" checked={options.gif.loop} disabled={running} onChange={(e) => setGif({ loop: e.target.checked })} />
                  <span className="field-label">{t('export.loop')}</span>
                </label>
              </details>

              <p className="muted small">
                {t('converter.output', { w: options.width, h: outH, duration: formatDuration(spanMs), frames: Math.round((spanMs / 1000) * options.fps), fps: options.fps })}
                {options.width > 1280 && ` · ${t('export.largeGif')}`}
              </p>
            </>
          )}

          {(running || result || error) && (
            <div className="export-status">
              {(running || result) && (
                <div className="progress-line">
                  <span>{result ? t('export.done') : phaseLabel}</span>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${result ? 100 : (progress?.percent ?? 0)}%` }} />
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
            <button className="btn" onClick={() => void window.zc.converter.cancel()}>
              {t('common.cancel')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {t('common.close')}
              </button>
              <button className="btn btn-primary" onClick={() => void run()} disabled={!video || !options || spanMs <= 0}>
                {t('converter.run')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
