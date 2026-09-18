import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { ExportFinishResult, ExportProgress, ExportSettings, GifSettings } from '@shared/types'
import { GIF_FPS_OPTIONS, MP4_FPS_OPTIONS, SCALE_OPTIONS } from '@shared/defaults'
import { useProject, useStore } from '../store'
import type { FollowPath } from '../engine/cursor'
import { outputSize } from '../engine/compose'
import { keepSegments, outputDuration } from '../engine/timeline'
import { runExport, type RenderProgress } from '../export/exporter'
import { formatBytes, formatDuration } from '../util/format'

interface Props {
  followPath: FollowPath | null
}

const GIF_PRESETS: Array<{ id: string; label: string; hint: string; apply: (s: ExportSettings) => ExportSettings }> = [
  {
    id: 'crisp',
    label: 'Crisp UI',
    hint: 'No dithering, 256 colours, palette weighted on changing pixels. Best for grey/white interfaces with thin lines.',
    apply: (s) => ({ ...s, fps: 15, gif: { ...s.gif, colors: 256, dither: 'none', paletteMode: 'diff' } })
  },
  {
    id: 'smooth',
    label: 'Smooth gradients',
    hint: 'Sierra dithering hides banding in shadows and gradients at the cost of some grain.',
    apply: (s) => ({ ...s, fps: 15, gif: { ...s.gif, colors: 256, dither: 'sierra2_4a', paletteMode: 'diff' } })
  },
  {
    id: 'small',
    label: 'Smallest file',
    hint: '10 fps, half size, 64 colours with ordered dithering.',
    apply: (s) => ({ ...s, fps: 10, scale: 0.5, gif: { ...s.gif, colors: 64, dither: 'bayer', bayerScale: 3, paletteMode: 'global' } })
  }
]

export function ExportDialog({ followPath }: Props): JSX.Element {
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
  const abortRef = useRef<AbortController | null>(null)

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
    ffmpeg?.phase === 'palette' ? 'Building palette' : ffmpeg?.phase === 'quantize' ? 'Writing GIF' : 'Encoding MP4'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Export</h2>
          <button className="btn btn-ghost" onClick={close} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="seg wide">
            <button className={'seg-btn' + (settings.format === 'mp4' ? ' active' : '')} disabled={running} onClick={() => set({ format: 'mp4', fps: MP4_FPS_OPTIONS.includes(settings.fps) ? settings.fps : 30 })}>
              MP4 video
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
              GIF animation
            </button>
          </div>

          <div className="row2">
            <label className="field">
              <span className="field-label">File name</span>
              <input value={settings.fileName} disabled={running} onChange={(e) => set({ fileName: e.target.value })} spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-label">Folder</span>
              <div className="folder-row">
                <input value={settings.folder} disabled={running} onChange={(e) => set({ folder: e.target.value })} spellCheck={false} placeholder="Choose a folder…" />
                <button className="btn btn-ghost" onClick={() => void chooseFolder()} disabled={running} title="Choose folder">
                  <FolderOpen size={15} />
                </button>
              </div>
            </label>
          </div>

          <div className="row2">
            <label className="field">
              <span className="field-label">Size</span>
              <div className="seg">
                {SCALE_OPTIONS.map((s) => (
                  <button key={s} className={'seg-btn' + (settings.scale === s ? ' active' : '')} disabled={running} onClick={() => set({ scale: s })}>
                    {Math.round(s * 100)}%
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span className="field-label">Frame rate</span>
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
              <span className="field-label">Quality</span>
              <div className="seg">
                {(['low', 'medium', 'high', 'max'] as const).map((q) => (
                  <button key={q} className={'seg-btn' + (settings.mp4Quality === q ? ' active' : '')} disabled={running} onClick={() => set({ mp4Quality: q })}>
                    {q}
                  </button>
                ))}
              </div>
              <span className="field-hint">H.264 with x264 CRF 28 / 23 / 20 / 17. "high" is a safe default for UI recordings.</span>
            </label>
          ) : (
            <>
              <div className="field">
                <span className="field-label">Presets</span>
                <div className="btn-row">
                  {GIF_PRESETS.map((p) => (
                    <button key={p.id} className="btn btn-small" disabled={running} title={p.hint} onClick={() => setSettings(p.apply)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="row2">
                <label className="field">
                  <span className="field-label">Colours</span>
                  <div className="seg">
                    {([256, 128, 64, 32] as const).map((c) => (
                      <button key={c} className={'seg-btn' + (settings.gif.colors === c ? ' active' : '')} disabled={running} onClick={() => setGif({ colors: c })}>
                        {c}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="field">
                  <span className="field-label">Palette</span>
                  <select value={settings.gif.paletteMode} disabled={running} onChange={(e) => setGif({ paletteMode: e.target.value as GifSettings['paletteMode'] })}>
                    <option value="diff">Changing pixels (best for UI)</option>
                    <option value="global">Global (whole video)</option>
                    <option value="perframe">Per frame (largest, most exact)</option>
                  </select>
                </label>
              </div>
              <div className="row2">
                <label className="field">
                  <span className="field-label">Dithering</span>
                  <select value={settings.gif.dither} disabled={running} onChange={(e) => setGif({ dither: e.target.value as GifSettings['dither'] })}>
                    <option value="none">None (sharp, best for flat UI)</option>
                    <option value="sierra2_4a">Sierra (smooth gradients)</option>
                    <option value="floyd_steinberg">Floyd–Steinberg</option>
                    <option value="bayer">Bayer (ordered, small files)</option>
                  </select>
                </label>
                {settings.gif.dither === 'bayer' ? (
                  <label className="field">
                    <span className="field-label">Bayer scale {settings.gif.bayerScale}</span>
                    <input type="range" min={0} max={5} step={1} value={settings.gif.bayerScale} disabled={running} onChange={(e) => setGif({ bayerScale: Number(e.target.value) })} />
                  </label>
                ) : (
                  <label className="field field-row">
                    <input type="checkbox" checked={settings.gif.loop} disabled={running} onChange={(e) => setGif({ loop: e.target.checked })} />
                    <span className="field-label">Loop forever</span>
                  </label>
                )}
              </div>
            </>
          )}

          <p className="muted small">
            Output: {size.outW}×{size.outH} px · {formatDuration(outMs)} · {frames} frames at {settings.fps} fps
            {settings.format === 'gif' && size.outW > 1280 && ' · large GIF – consider 75% or 50% size'}
          </p>

          {(running || result || error) && (
            <div className="export-status">
              {render && (
                <div className="progress-line">
                  <span>Rendering frames{render.frames ? ` (${render.frame ?? 0}/${render.frames})` : ''}</span>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${render.phase === 'finalize' || result ? 100 : render.percent}%` }} />
                  </div>
                </div>
              )}
              {(render?.phase === 'finalize' || result || ffmpeg) && (
                <div className="progress-line">
                  <span>{result ? 'Done' : ffmpegLabel}</span>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${result ? 100 : ffmpeg?.percent ?? 0}%` }} />
                  </div>
                </div>
              )}
              {result && (
                <div className="export-result">
                  <strong>{formatBytes(result.bytes)}</strong> · {result.outputPath}
                  <div className="btn-row">
                    <button className="btn btn-small" onClick={() => void window.zc.app.openPath(result.outputPath)}>
                      Open
                    </button>
                    <button className="btn btn-small" onClick={() => void window.zc.app.showInFolder(result.outputPath)}>
                      Show in folder
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
              Cancel
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                Close
              </button>
              <button className="btn btn-primary" onClick={() => void start()} disabled={!settings.fileName.trim() || outMs <= 0}>
                Export {settings.format.toUpperCase()}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
