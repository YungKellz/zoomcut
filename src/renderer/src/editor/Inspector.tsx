import type React from 'react'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  AppWindow,
  AudioLines,
  Crosshair,
  Crop,
  Droplet,
  Loader2,
  Mic,
  MousePointer2,
  Music,
  Play,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  ZoomIn
} from 'lucide-react'
import type { AudioClip, BlurRegion, MusicTrack, TextOverlay, ZoomSegment } from '@shared/types'
import { DEFAULT_AUDIO_CAPTURE, GRADIENT_PRESETS } from '@shared/defaults'
import { isRecordedClip, newAudioClipDefaults } from '@shared/audio'
import { useProject, useStore } from '../store'
import { uid } from '../engine/ids'
import { generateZoomsFromClicks } from '../engine/zoomAuto'
import { findZoom } from '../engine/camera'
import { uniqueWindows, windowToCrop } from '../engine/windows'
import { TRANSPARENT_BACKGROUND } from '../engine/compose'
import { keepSegments, outputDuration, srcToOut } from '../engine/timeline'
import { clipIcon, clipLabel } from '../audio/clipLabel'
import { formatElapsed, formatTimecode } from '../util/format'
import { useT, type Translate, type TKey } from '../i18n'

type Tab = 'clip' | 'zoom' | 'text' | 'blur' | 'audio' | 'cursor' | 'style'

export function Inspector(): JSX.Element {
  const t = useT()
  const selection = useStore((s) => s.selection)
  const [tab, setTab] = useState<Tab>('clip')

  useEffect(() => {
    if (selection?.kind === 'zoom') setTab('zoom')
    else if (selection?.kind === 'text') setTab('text')
    else if (selection?.kind === 'audio') setTab('audio')
    else if (selection?.kind === 'blur') setTab('blur')
    else if (selection?.kind === 'cut') setTab('clip')
  }, [selection])

  const tabs: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'clip', label: t('tab.clip'), icon: <Scissors size={14} /> },
    { id: 'zoom', label: t('tab.zoom'), icon: <ZoomIn size={14} /> },
    { id: 'text', label: t('tab.text'), icon: <Type size={14} /> },
    { id: 'blur', label: t('tab.blur'), icon: <Droplet size={14} /> },
    { id: 'audio', label: t('tab.audio'), icon: <AudioLines size={14} /> },
    { id: 'cursor', label: t('tab.cursor'), icon: <MousePointer2 size={14} /> },
    { id: 'style', label: t('tab.style'), icon: <Sparkles size={14} /> }
  ]

  return (
    <aside className="inspector">
      <div className="tabs">
        {tabs.map((x) => (
          <button key={x.id} className={'tab' + (tab === x.id ? ' active' : '')} onClick={() => setTab(x.id)}>
            {x.icon} {x.label}
          </button>
        ))}
      </div>
      <div className="panel">
        {tab === 'clip' && <ClipPanel t={t} />}
        {tab === 'zoom' && <ZoomPanel t={t} />}
        {tab === 'text' && <TextPanel t={t} />}
        {tab === 'blur' && <BlurPanel t={t} />}
        {tab === 'audio' && <AudioPanel t={t} />}
        {tab === 'cursor' && <CursorPanel t={t} />}
        {tab === 'style' && <StylePanel t={t} />}
      </div>
    </aside>
  )
}

interface PanelProps {
  t: Translate
}

// ---------- shared controls ----------

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
  onBegin?: () => void
}): JSX.Element {
  const { label, value, min, max, step, format, onChange, onBegin } = props
  return (
    <label className="field">
      <span className="field-label">
        {label} <span className="field-value">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onPointerDown={onBegin} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <label className="field field-row">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="field-label">{label}</span>
    </label>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="field field-row">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="field-label">{label}</span>
    </label>
  )
}

function TimeInput({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <Field label={label}>
      <input
        type="number"
        min={0}
        max={max / 1000}
        step={0.1}
        value={(value / 1000).toFixed(2)}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) * 1000)))}
      />
    </Field>
  )
}

// ---------- panels ----------

function ClipPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const playheadMs = useStore((s) => s.playheadMs)
  const range = useStore((s) => s.range)
  const addCut = useStore((s) => s.addCut)
  const removeCut = useStore((s) => s.removeCut)
  const select = useStore((s) => s.select)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const setCrop = useStore((s) => s.setCrop)
  const duration = project.recording.durationMs
  const crop = project.crop
  const isCropped = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1
  const windows = uniqueWindows(project.windows)

  return (
    <>
      <h3>{t('clip.trimCut')}</h3>
      <div className="btn-row">
        <button className="btn btn-small" onClick={() => addCut(0, playheadMs)} disabled={playheadMs < 50}>
          {t('clip.trimStart')}
        </button>
        <button className="btn btn-small" onClick={() => addCut(playheadMs, duration)} disabled={playheadMs > duration - 50}>
          {t('clip.trimEnd')}
        </button>
      </div>
      <button className="btn btn-small" disabled={!range} onClick={() => range && addCut(range.start, range.end)}>
        <Scissors size={14} /> {t('clip.cutRange')}
      </button>
      <p className="muted small">{t('clip.help')}</p>
      {project.cuts.length > 0 && (
        <>
          <h3>{t('clip.removedPieces')}</h3>
          <ul className="list cuts-list">
            {project.cuts.map((c) => (
              <li key={c.id} className="list-item">
                <button className="list-main" onClick={() => select({ kind: 'cut', id: c.id })}>
                  {formatTimecode(c.start)} – {formatTimecode(c.end)}
                </button>
                <button className="btn btn-ghost" onClick={() => removeCut(c.id)} title={t('clip.restore')}>
                  <Undo2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>{t('clip.crop')}</h3>
      <div className="btn-row">
        <button className={'btn btn-small' + (mode === 'crop' ? ' active' : '')} onClick={() => setMode(mode === 'crop' ? 'normal' : 'crop')}>
          <Crop size={14} /> {mode === 'crop' ? t('common.done') : t('clip.editCrop')}
        </button>
        <button className="btn btn-small" disabled={!isCropped} onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
          {t('common.reset')}
        </button>
      </div>
      <p className="muted small">
        {isCropped
          ? t('clip.cropInfo', {
              w: Math.round(crop.w * project.recording.width),
              h: Math.round(crop.h * project.recording.height),
              x: Math.round(crop.x * project.recording.width),
              y: Math.round(crop.y * project.recording.height)
            })
          : t('clip.cropFull')}
      </p>
      <h3>{t('clip.windows')}</h3>
      {windows.length === 0 ? (
        <p className="muted small">{t('clip.noWindows')}</p>
      ) : (
        <>
          <ul className="list windows-list">
            {windows.map((w, i) => (
              <li key={i} className="list-item">
                <button className="list-main" onClick={() => setCrop(windowToCrop(w))} title={w.title}>
                  <AppWindow size={13} /> {w.title}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">{t('clip.windowsHelp')}</p>
        </>
      )}
    </>
  )
}

function ZoomPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const addZoom = useStore((s) => s.addZoom)
  const updateZoom = useStore((s) => s.updateZoom)
  const removeZoom = useStore((s) => s.removeZoom)
  const setZooms = useStore((s) => s.setZooms)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const beginPick = useStore((s) => s.beginPick)
  const checkpoint = useStore((s) => s.checkpoint)
  const duration = project.recording.durationMs
  const zoom: ZoomSegment | undefined = selection?.kind === 'zoom' ? project.zooms.find((z) => z.id === selection.id) : undefined
  const playheadMs = useStore((s) => s.playheadMs)
  const zoomAtPlayhead = findZoom(project.zooms, playheadMs)
  // no point in an "edit" button when the zoom under the playhead is the one being edited
  const showAddEdit = !(zoomAtPlayhead && zoom && zoomAtPlayhead.id === zoom.id)

  const autoZooms = (): void => {
    const generated = generateZoomsFromClicks(project.cursorData.clicks, duration, project.cuts)
    if (generated.length === 0) {
      alert(t('zoom.noClicks'))
      return
    }
    if (project.zooms.length > 0 && !confirm(t('zoom.replaceConfirm', { n: project.zooms.length, m: generated.length }))) return
    setZooms(generated)
  }

  return (
    <>
      <div className="btn-row">
        {showAddEdit && (
          <button className="btn btn-small" onClick={() => addZoom()}>
            <ZoomIn size={14} /> {zoomAtPlayhead ? t('zoom.edit') : t('zoom.add')}
          </button>
        )}
        <button className="btn btn-small" onClick={autoZooms} title={t('zoom.autoTitle')}>
          <Sparkles size={14} /> {t('zoom.auto')}
        </button>
      </div>

      {zoom ? (
        <>
          <h3>{t('zoom.selected')}</h3>
          <Slider label={t('zoom.scale')} value={zoom.scale} min={1.2} max={5} step={0.1} format={(v) => `${v.toFixed(1)}×`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { scale: v }, false)} />
          <Field label={t('zoom.focus')}>
            <div className="seg">
              <button className={'seg-btn' + (zoom.mode === 'follow' ? ' active' : '')} onClick={() => updateZoom(zoom.id, { mode: 'follow' })}>
                {t('zoom.follow')}
              </button>
              <button className={'seg-btn' + (zoom.mode === 'fixed' ? ' active' : '')} onClick={() => updateZoom(zoom.id, { mode: 'fixed' })}>
                {t('zoom.fixed')}
              </button>
            </div>
          </Field>
          {zoom.mode === 'fixed' && (
            <>
              <button className="btn btn-small" onClick={() => beginPick(zoom.id)}>
                <Crosshair size={14} /> {t('zoom.pick')}
              </button>
              <p className="muted small">{t('zoom.pickHelp')}</p>
            </>
          )}
          <div className="row2">
            <TimeInput label={t('zoom.start')} value={zoom.start} max={duration} onChange={(v) => updateZoom(zoom.id, { start: Math.min(v, zoom.end - 200) })} />
            <TimeInput label={t('zoom.end')} value={zoom.end} max={duration} onChange={(v) => updateZoom(zoom.id, { end: Math.max(v, zoom.start + 200) })} />
          </div>
          <details className="adv">
            <summary>{t('common.advanced')}</summary>
            <Slider label={t('zoom.easeIn')} value={zoom.easeInMs} min={0} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeInMs: v }, false)} />
            <Slider label={t('zoom.easeOut')} value={zoom.easeOutMs} min={0} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeOutMs: v }, false)} />
          </details>
          <button className="btn btn-small danger" onClick={() => removeZoom(zoom.id)}>
            <Trash2 size={14} /> {t('zoom.delete')}
          </button>
        </>
      ) : (
        <p className="muted small">{t('zoom.empty')}</p>
      )}

      {project.zooms.length > 0 && (
        <>
          <h3>{t('zoom.all')}</h3>
          <ul className="list">
            {project.zooms.map((z) => (
              <li key={z.id} className={'list-item' + (zoom?.id === z.id ? ' active' : '')}>
                <button
                  className="list-main"
                  onClick={() => {
                    select({ kind: 'zoom', id: z.id })
                    setPlayhead(z.start + Math.min(z.easeInMs, (z.end - z.start) / 2), true)
                  }}
                >
                  {formatTimecode(z.start)} – {formatTimecode(z.end)} · {z.scale.toFixed(1)}× {z.mode === 'follow' ? t('timeline.follow') : t('timeline.fixed')}
                </button>
                <button className="btn btn-ghost danger" onClick={() => removeZoom(z.id)} title={t('zoom.delete')}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">{t('zoom.help')}</p>
    </>
  )
}

function TextPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const addText = useStore((s) => s.addText)
  const updateText = useStore((s) => s.updateText)
  const removeText = useStore((s) => s.removeText)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const checkpoint = useStore((s) => s.checkpoint)
  const duration = project.recording.durationMs
  const text: TextOverlay | undefined = selection?.kind === 'text' ? project.texts.find((x) => x.id === selection.id) : undefined

  return (
    <>
      <button className="btn btn-small" onClick={() => addText()}>
        <Type size={14} /> {t('text.add')}
      </button>
      {text ? (
        <>
          <h3>{t('text.selected')}</h3>
          <Field label={t('text.text')}>
            <textarea rows={3} value={text.text} onFocus={checkpoint} onChange={(e) => updateText(text.id, { text: e.target.value }, false)} />
          </Field>
          <div className="row2">
            <TimeInput label={t('zoom.start')} value={text.start} max={duration} onChange={(v) => updateText(text.id, { start: Math.min(v, text.end - 100) })} />
            <TimeInput label={t('zoom.end')} value={text.end} max={duration} onChange={(v) => updateText(text.id, { end: Math.max(v, text.start + 100) })} />
          </div>
          <Slider label={t('text.size')} value={text.fontSize} min={0.02} max={0.14} step={0.005} format={(v) => `${Math.round(v * 1080)} px @1080p`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { fontSize: v }, false)} />
          <div className="row2">
            <ColorField label={t('text.color')} value={text.color} onChange={(v) => updateText(text.id, { color: v })} />
            <ColorField label={t('text.background')} value={text.background} onChange={(v) => updateText(text.id, { background: v })} />
          </div>
          <Slider label={t('text.bgOpacity')} value={text.backgroundOpacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { backgroundOpacity: v }, false)} />
          <Slider label={t('text.radius')} value={text.cornerRadius} min={0} max={40} step={1} format={(v) => `${v} px`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { cornerRadius: v }, false)} />
          <div className="row2">
            <Toggle label={t('text.bold')} value={text.bold} onChange={(v) => updateText(text.id, { bold: v })} />
            <Field label={t('text.align')}>
              <select value={text.align} onChange={(e) => updateText(text.id, { align: e.target.value as TextOverlay['align'] })}>
                <option value="left">{t('text.align.left')}</option>
                <option value="center">{t('text.align.center')}</option>
                <option value="right">{t('text.align.right')}</option>
              </select>
            </Field>
          </div>
          <div className="row2">
            <Field label={t('text.animation')}>
              <select value={text.animation} onChange={(e) => updateText(text.id, { animation: e.target.value as TextOverlay['animation'] })}>
                <option value="none">{t('text.anim.none')}</option>
                <option value="fade">{t('text.anim.fade')}</option>
                <option value="pop">{t('text.anim.pop')}</option>
              </select>
            </Field>
            <Slider label={t('text.animTime')} value={text.animationMs} min={0} max={800} step={20} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { animationMs: v }, false)} />
          </div>
          <p className="muted small">{t('text.dragHint')}</p>
          <button className="btn btn-small danger" onClick={() => removeText(text.id)}>
            <Trash2 size={14} /> {t('text.delete')}
          </button>
        </>
      ) : (
        <p className="muted small">{t('text.empty')}</p>
      )}
      {project.texts.length > 0 && (
        <>
          <h3>{t('text.all')}</h3>
          <ul className="list">
            {project.texts.map((x) => (
              <li key={x.id} className={'list-item' + (text?.id === x.id ? ' active' : '')}>
                <button
                  className="list-main"
                  onClick={() => {
                    select({ kind: 'text', id: x.id })
                    setPlayhead(x.start + 50, true)
                  }}
                >
                  {formatTimecode(x.start)} · {x.text.split('\n')[0] || '…'}
                </button>
                <button className="btn btn-ghost danger" onClick={() => removeText(x.id)} title={t('text.delete')}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function BlurPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const select = useStore((s) => s.select)
  const setMode = useStore((s) => s.setMode)
  const addBlur = useStore((s) => s.addBlur)
  const updateBlur = useStore((s) => s.updateBlur)
  const removeBlur = useStore((s) => s.removeBlur)
  const beginBlurEdit = useStore((s) => s.beginBlurEdit)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const checkpoint = useStore((s) => s.checkpoint)
  const duration = project.recording.durationMs
  const blur: BlurRegion | undefined = selection?.kind === 'blur' ? project.blurs.find((b) => b.id === selection.id) : undefined
  const editing = mode === 'blur' && blur !== undefined

  return (
    <>
      <button className="btn btn-small" onClick={() => addBlur()}>
        <Droplet size={14} /> {t('blur.add')}
      </button>
      {blur ? (
        <>
          <h3>{t('blur.selected')}</h3>
          <div className="btn-row">
            <button className={'btn btn-small' + (editing ? ' active' : '')} onClick={() => (editing ? setMode('normal') : beginBlurEdit(blur.id))}>
              <Crop size={14} /> {editing ? t('common.done') : t('blur.editArea')}
            </button>
          </div>
          <Field label={t('blur.style')}>
            <div className="seg">
              <button className={'seg-btn' + (blur.style === 'blur' ? ' active' : '')} onClick={() => updateBlur(blur.id, { style: 'blur' })}>
                {t('blur.style.blur')}
              </button>
              <button className={'seg-btn' + (blur.style === 'pixelate' ? ' active' : '')} onClick={() => updateBlur(blur.id, { style: 'pixelate' })}>
                {t('blur.style.pixelate')}
              </button>
            </div>
          </Field>
          <Slider
            label={blur.style === 'pixelate' ? t('blur.blockSize') : t('blur.strength')}
            value={blur.strength}
            min={4}
            max={80}
            step={1}
            format={(v) => `${v} px @1080p`}
            onBegin={checkpoint}
            onChange={(v) => updateBlur(blur.id, { strength: v }, false)}
          />
          <div className="row2">
            <TimeInput label={t('zoom.start')} value={blur.start} max={duration} onChange={(v) => updateBlur(blur.id, { start: Math.min(v, blur.end - 100) })} />
            <TimeInput label={t('zoom.end')} value={blur.end} max={duration} onChange={(v) => updateBlur(blur.id, { end: Math.max(v, blur.start + 100) })} />
          </div>
          <div className="btn-row">
            <button className="btn btn-small" onClick={() => updateBlur(blur.id, { start: 0, end: duration })}>
              {t('blur.wholeRecording')}
            </button>
          </div>
          <p className="muted small">{t('blur.editHelp')}</p>
          <button className="btn btn-small danger" onClick={() => removeBlur(blur.id)}>
            <Trash2 size={14} /> {t('blur.delete')}
          </button>
        </>
      ) : (
        <p className="muted small">{t('blur.empty')}</p>
      )}
      {project.blurs.length > 0 && (
        <>
          <h3>{t('blur.all')}</h3>
          <ul className="list">
            {project.blurs.map((b) => (
              <li key={b.id} className={'list-item' + (blur?.id === b.id ? ' active' : '')}>
                <button
                  className="list-main"
                  onClick={() => {
                    select({ kind: 'blur', id: b.id })
                    setPlayhead(b.start + 50, true)
                  }}
                >
                  {formatTimecode(b.start)} – {formatTimecode(b.end)} · {b.style === 'pixelate' ? t('blur.style.pixelate') : t('blur.style.blur')}
                </button>
                <button className="btn btn-ghost danger" onClick={() => removeBlur(b.id)} title={t('blur.delete')}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">{t('blur.help')}</p>
    </>
  )
}

// ---- audio panel ----

interface VoiceoverSession {
  recorder: MediaRecorder
  stream: MediaStream
  /** unsubscribes the store watcher used to anchor the clip's start, see startRecording */
  unsubscribe: () => void
}

/** Mic <select> + "Record voiceover" button. Starts a MediaRecorder from getUserMedia while
 * playing the project back (muted for every other clip) from the current playhead, and turns
 * the recorded blob into a `voiceover` AudioClip positioned where the recording began. */
function VoiceoverRecorder({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const addAudioClip = useStore((s) => s.addAudioClip)
  const playing = useStore((s) => s.playing)
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [recording, setRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<VoiceoverSession | null>(null)
  const discardRef = useRef(false)
  // MediaRecorder.state flips to 'inactive' SYNCHRONOUSLY inside .stop(), before the 'stop'
  // event fires – so recorder.state alone cannot tell "never started" apart from "stop() was
  // already called, onstop just has not run yet". This guards stopRecording so a second call
  // (double-click, Escape racing the button) cannot re-enter and stop the mic tracks early.
  const stoppingRef = useRef(false)
  const startWallRef = useRef(0)

  // the last used device is shared with Home's mic checkbox (AppSettings.audioDefaults.micDeviceId)
  useEffect(() => {
    void window.zc.app
      .getSettings()
      .then((s) => setMicDeviceId(s.audioDefaults?.micDeviceId ?? null))
      .catch(() => undefined)
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const list = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
      setMicDevices(list)
      // a stale exact deviceId (unplugged mic, a project reopened on another machine) makes
      // getUserMedia reject with OverconstrainedError instead of falling back to the default
      setMicDeviceId((current) => (current && !list.some((d) => d.deviceId === current) ? null : current))
    } catch {
      setMicDevices([])
    }
  }, [])
  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [refreshDevices])

  const chooseMic = (value: string): void => {
    const id = value || null
    setMicDeviceId(id)
    void window.zc.app
      .getSettings()
      .then((s) => window.zc.app.setSettings({ audioDefaults: { ...(s.audioDefaults ?? DEFAULT_AUDIO_CAPTURE), micDeviceId: id } }))
      .catch(() => undefined)
  }

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startWallRef.current), 200)
    return () => window.clearInterval(timer)
  }, [recording])

  const finishSession = useCallback(
    (chunks: Blob[], clipStart: number, resumePlayheadMs: number, discard: boolean) => {
      sessionRef.current = null
      setRecording(false)
      useStore.getState().setAudioMuted(false)
      useStore.getState().setPlaying(false)
      useStore.getState().setPlayhead(resumePlayheadMs, true)
      if (discard || chunks.length === 0) return
      setBusy(true)
      void (async () => {
        try {
          const blob = new Blob(chunks, { type: 'audio/webm' })
          const data = await blob.arrayBuffer()
          const name = 'Voiceover' // English in data, like "System audio" / "Microphone"; UI translates via clipLabel
          const result = await window.zc.audio.importClip(project.id, { kind: 'voiceover', name, ext: 'webm', data })
          addAudioClip({
            id: uid('audio'),
            kind: 'voiceover',
            file: result.file,
            name,
            start: clipStart,
            durationMs: result.durationMs,
            ...newAudioClipDefaults('voiceover')
          })
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
    },
    [addAudioClip, project.id]
  )

  const stopRecording = useCallback((discard: boolean) => {
    const s = sessionRef.current
    // stoppingRef makes this idempotent: a second call for the same session (double-click,
    // Escape firing right after the button) must not re-run the cleanup below, or it would
    // stop the mic tracks itself instead of leaving that to the pending recorder.onstop
    if (!s || stoppingRef.current) return
    stoppingRef.current = true
    discardRef.current = discard
    if (s.recorder.state !== 'inactive') {
      // tracks are stopped inside recorder.onstop, after the last chunk has been flushed –
      // stopping them here too would race the recorder's own finalization
      s.recorder.stop()
    } else {
      // defensive: the recorder never actually reached recorder.start() (or was somehow
      // already inactive) – onstop will not fire, so this is the only place left to release
      // the mic and reset the UI; nothing was ever captured, so there is nothing to keep
      s.unsubscribe()
      s.stream.getTracks().forEach((tr) => tr.stop())
      sessionRef.current = null
      setRecording(false)
      useStore.getState().setAudioMuted(false)
      useStore.getState().setPlaying(false)
    }
  }, [])

  // stop when the recorder's own Stop button is not the trigger: Escape, or playback reaching
  // the end (the preview render loop flips `playing` to false by itself, see Preview.tsx)
  useEffect(() => {
    if (recording && !playing) stopRecording(false)
  }, [playing, recording, stopRecording])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') stopRecording(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [recording, stopRecording])

  // unmounting (switching tabs, closing the project) mid-recording discards cleanly: this
  // must release the mic and reset audioMuted/playing unconditionally, even for a recorder
  // that never actually reached recorder.start() (its onstop would then never fire to do it)
  useEffect(
    () => () => {
      const s = sessionRef.current
      if (!s) return
      discardRef.current = true
      if (stoppingRef.current) {
        // a stop was already requested (e.g. the user clicked Stop just before switching
        // tabs): the recorder is finishing on its own account – forcing the tracks stopped
        // here too would cut it off before recorder.onstop flushes/releases them itself
        return
      }
      stoppingRef.current = true
      s.unsubscribe()
      if (s.recorder.state !== 'inactive') s.recorder.stop()
      s.stream.getTracks().forEach((tr) => tr.stop())
      sessionRef.current = null
      useStore.getState().setAudioMuted(false)
      useStore.getState().setPlaying(false)
    },
    []
  )

  const startRecording = useCallback(async () => {
    setError(null)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128_000 })
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const segments = keepSegments(project.recording.durationMs, project.cuts)
      const resumePlayheadMs = useStore.getState().playheadMs
      const outStart = srcToOut(resumePlayheadMs, segments)

      // Anchor the clip to when the video actually starts advancing, not to when we merely
      // requested play(): there is a short gap between the mic's recorder.start() and the
      // preview loop's first playheadMs tick (buffering/seek). The audio started before the
      // video moved, so the clip must begin a little earlier – a negative `start` is fine,
      // the export plan (audioPlan.ts) trims it.
      let recorderStartWall = 0
      let firstAdvanceWall: number | null = null
      const unsubscribe = useStore.subscribe((state) => {
        if (firstAdvanceWall === null && state.playheadMs !== resumePlayheadMs) firstAdvanceWall = Date.now()
      })

      const activeStream = stream
      recorder.onstop = () => {
        unsubscribe()
        activeStream.getTracks().forEach((tr) => tr.stop())
        const clipStart = firstAdvanceWall !== null ? outStart - (firstAdvanceWall - recorderStartWall) : outStart
        finishSession(chunks, clipStart, resumePlayheadMs, discardRef.current)
      }
      recorder.onerror = (ev) => {
        console.error('[voiceover] recorder error', ev)
        setError(t('audio.voiceoverError'))
        stopRecording(true)
      }
      discardRef.current = false
      stoppingRef.current = false
      sessionRef.current = { recorder, stream: activeStream, unsubscribe }
      setElapsedMs(0)
      // order matters: flip `playing` before `recording` so the auto-stop effect above never
      // sees recording=true with playing still false in an intermediate render
      useStore.getState().setPlaying(true)
      useStore.getState().setAudioMuted(true)
      setRecording(true)
      recorder.start(250)
      recorderStartWall = Date.now()
      startWallRef.current = recorderStartWall
    } catch (err) {
      // undo everything this attempt may have already done, however far it got
      stream?.getTracks().forEach((tr) => tr.stop())
      sessionRef.current = null
      setRecording(false)
      useStore.getState().setAudioMuted(false)
      useStore.getState().setPlaying(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [finishSession, micDeviceId, project.cuts, project.recording.durationMs, stopRecording, t])

  return (
    <div className="voiceover">
      <Field label={t('home.audioMic')}>
        <select value={micDeviceId ?? ''} disabled={recording} onChange={(e) => chooseMic(e.target.value)}>
          <option value="">{t('home.audioMicDefault')}</option>
          {micDevices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t('home.audioMicUnnamed', { n: i + 1 })}
            </option>
          ))}
        </select>
      </Field>
      <button
        className={'btn btn-small btn-voiceover' + (recording ? ' recording' : '')}
        disabled={busy}
        onClick={() => (recording ? stopRecording(false) : void startRecording())}
      >
        {recording ? <Square size={14} fill="currentColor" /> : <Mic size={14} />}
        {recording ? `${t('home.stop')} · ${formatElapsed(elapsedMs)}` : busy ? t('audio.importing') : t('audio.recordVoiceover')}
      </button>
      {error && (
        <div className="error-box">
          <strong>{t('audio.voiceoverError')}</strong> {error}
          <button className="btn btn-ghost" onClick={() => setError(null)}>
            {t('home.dismiss')}
          </button>
        </div>
      )}
    </div>
  )
}

// translated mood tag shown next to each library track - a Record (not a template-literal key)
// so a typo here is a compile error instead of a silently-missing translation
const MOOD_KEYS: Record<MusicTrack['mood'], TKey> = {
  upbeat: 'music.mood.upbeat',
  corporate: 'music.mood.corporate',
  bright: 'music.mood.bright',
  lofi: 'music.mood.lofi',
  calm: 'music.mood.calm',
  minimal: 'music.mood.minimal'
}

// preview clips play at most this long, even for a multi-minute track (see togglePreview)
const PREVIEW_MS = 8000
// a music bed defaults to 35% (see useTrack's addAudioClip below) so it sits under narration
// instead of competing with it - the preview plays at the same level, so "Preview" previews
// what you are actually about to add, not a full-volume version of it
const MUSIC_CLIP_VOLUME = 0.35

/** "Add music" library chooser + "Add audio file…" – the former lists the bundled CC0 tracks
 * (window.zc.audio.listMusic) and copies the picked one into the project on "Use"
 * (window.zc.audio.importMusic); the latter adds an overlay AudioClip from a user-picked file
 * via window.zc.audio.importFile. */
function MusicAndFilePicker({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const addAudioClip = useStore((s) => s.addAudioClip)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [fileImporting, setFileImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<HTMLAudioElement | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  // guards "Add audio file…" against a double-click opening two native dialogs at once
  const fileImportBusyRef = useRef(false)

  // fetch the library once, the first time the picker actually opens (it never changes at
  // runtime - it is bundled with the app - so there is no reason to refetch on every open)
  useEffect(() => {
    if (!pickerOpen || tracks !== null) return
    let cancelled = false
    void window.zc.audio
      .listMusic()
      .then((list) => {
        if (!cancelled) setTracks(list)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [pickerOpen, tracks])

  const stopPreview = useCallback(() => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    const el = previewRef.current
    previewRef.current = null
    if (el) {
      el.pause()
      el.src = ''
    }
    setPreviewingId(null)
  }, [])

  // stop a running preview when the panel goes away (tab switch, project close) or the chooser closes
  useEffect(() => stopPreview, [stopPreview])
  useEffect(() => {
    if (!pickerOpen) stopPreview()
  }, [pickerOpen, stopPreview])

  const togglePreview = useCallback(
    (track: MusicTrack) => {
      if (previewingId === track.id) {
        stopPreview()
        return
      }
      stopPreview()
      setError(null)
      // a plain HTMLAudioElement (not rendered in the tree) is enough - only one plays at a
      // time (stopPreview() above always tears down the previous one first) and nothing here
      // needs to be part of the React tree
      const el = new Audio(window.zc.media.url(track.path))
      el.volume = MUSIC_CLIP_VOLUME
      el.addEventListener('ended', () => stopPreview())
      previewRef.current = el
      setPreviewingId(track.id)
      previewTimerRef.current = window.setTimeout(stopPreview, PREVIEW_MS)
      void el.play().catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        stopPreview()
      })
    },
    [previewingId, stopPreview]
  )

  const useTrack = useCallback(
    async (track: MusicTrack) => {
      stopPreview()
      setError(null)
      setImportingId(track.id)
      try {
        const result = await window.zc.audio.importMusic(project.id, track.id)
        addAudioClip({
          id: uid('audio'),
          kind: 'music',
          file: result.file,
          name: track.title,
          start: 0,
          durationMs: result.durationMs,
          preset: track.id,
          ...newAudioClipDefaults('music'),
          volume: MUSIC_CLIP_VOLUME,
          fadeOutMs: 1500
        })
        setPickerOpen(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setImportingId(null)
      }
    },
    [addAudioClip, project.id, stopPreview]
  )

  const addFile = useCallback(async () => {
    if (fileImportBusyRef.current) return
    fileImportBusyRef.current = true
    setFileImporting(true)
    setError(null)
    try {
      const result = await window.zc.audio.importFile(project.id)
      if (!result) return
      const segments = keepSegments(project.recording.durationMs, project.cuts)
      addAudioClip({
        id: uid('audio'),
        kind: 'file',
        file: result.file,
        name: result.name,
        start: srcToOut(useStore.getState().playheadMs, segments),
        durationMs: result.durationMs,
        ...newAudioClipDefaults('file')
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      fileImportBusyRef.current = false
      setFileImporting(false)
    }
  }, [addAudioClip, project.cuts, project.id, project.recording.durationMs])

  return (
    <div className="audio-add-row">
      <button className="btn btn-small btn-add-music" onClick={() => setPickerOpen((v) => !v)}>
        <Music size={14} /> {t('audio.addMusic')}
      </button>
      <button className="btn btn-small btn-add-audio-file" disabled={fileImporting} onClick={() => void addFile()}>
        <Upload size={14} /> {t('audio.addFile')}
      </button>
      {error && (
        <div className="error-box">
          <strong>{t('audio.importError')}</strong> {error}
          <button className="btn btn-ghost" onClick={() => setError(null)}>
            {t('home.dismiss')}
          </button>
        </div>
      )}
      {pickerOpen && (
        <div className="music-presets">
          {tracks === null && !loadError && <p className="muted small">{t('audio.musicLoading')}</p>}
          {loadError && (
            <div className="error-box">
              <strong>{t('audio.musicLoadError')}</strong> {loadError}
            </div>
          )}
          {tracks?.map((track) => (
            <div key={track.id} className="music-preset">
              <div className="music-preset-info">
                <strong>{track.title}</strong>
                <span className="muted small">
                  {track.artist} · {t(MOOD_KEYS[track.mood])} · {formatElapsed(track.durationMs)}
                </span>
              </div>
              <div className="music-preset-actions">
                <button className="btn btn-ghost btn-small" title={t('audio.preview')} onClick={() => togglePreview(track)}>
                  {previewingId === track.id ? <Square size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="btn btn-small btn-primary btn-use-preset"
                  disabled={importingId !== null}
                  onClick={() => void useTrack(track)}
                >
                  {importingId === track.id ? <Loader2 size={14} className="spin" /> : null}
                  {t('audio.usePreset')}
                </button>
              </div>
            </div>
          ))}
          {tracks && tracks.length > 0 && <p className="muted small music-license-note">{t('audio.musicLicense')}</p>}
          <button className="btn btn-ghost btn-small music-presets-close" onClick={() => setPickerOpen(false)}>
            <X size={14} /> {t('common.close')}
          </button>
        </div>
      )}
    </div>
  )
}

function AudioPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const updateAudioClip = useStore((s) => s.updateAudioClip)
  const removeAudioClip = useStore((s) => s.removeAudioClip)
  const checkpoint = useStore((s) => s.checkpoint)
  const audioErrors = useStore((s) => s.audioErrors)
  const clip: AudioClip | undefined = selection?.kind === 'audio' ? project.audio.find((c) => c.id === selection.id) : undefined
  const outDurationMs = outputDuration(keepSegments(project.recording.durationMs, project.cuts))

  return (
    <>
      <VoiceoverRecorder t={t} />
      <MusicAndFilePicker t={t} />

      {project.audio.length === 0 ? (
        <p className="muted small">{t('audio.empty')}</p>
      ) : (
        <ul className="list audio-list">
          {project.audio.map((c) => (
            <li key={c.id} className={'list-item' + (clip?.id === c.id ? ' active' : '')}>
              <button className="list-main audio-list-item" onClick={() => select({ kind: 'audio', id: c.id })}>
                {clipIcon(c.kind)}
                <span className={c.muted ? 'muted' : ''}>{clipLabel(t, c)}</span>
                {audioErrors[c.id] && (
                  <span className="audio-warn" title={t('audio.fileMissing')}>
                    <AlertTriangle size={13} />
                  </span>
                )}
              </button>
              <button className="btn btn-ghost" onClick={() => updateAudioClip(c.id, { muted: !c.muted })} title={c.muted ? t('audio.unmute') : t('audio.mute')}>
                {c.muted || c.volume <= 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
              <button className="btn btn-ghost danger" onClick={() => removeAudioClip(c.id)} title={t('audio.delete')}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {clip && (
        <>
          <h3>{t('audio.selected')}</h3>
          {/* every kind is renamable, including system/mic - clipLabel shows the custom name
              once it differs from the kind's default English name, in every language */}
          <Field label={t('audio.name')}>
            <input type="text" value={clip.name} onFocus={checkpoint} onChange={(e) => updateAudioClip(clip.id, { name: e.target.value }, false)} />
          </Field>
          <Slider
            label={t('audio.volume')}
            value={clip.volume}
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onBegin={checkpoint}
            onChange={(v) => updateAudioClip(clip.id, { volume: v }, false)}
          />
          <Toggle label={t('audio.muted')} value={clip.muted} onChange={(v) => updateAudioClip(clip.id, { muted: v })} />
          {isRecordedClip(clip) ? (
            <Slider
              label={t('audio.syncOffset')}
              value={clip.start}
              // ±500ms is the normal range, but a clip whose start already sits further out
              // (e.g. loaded from an older project) must not have its slider silently clamp
              // or snap that value when the panel opens
              min={Math.min(-500, clip.start)}
              max={Math.max(500, clip.start)}
              step={5}
              format={(v) => `${v} ms`}
              onBegin={checkpoint}
              onChange={(v) => updateAudioClip(clip.id, { start: v }, false)}
            />
          ) : (
            <>
              <TimeInput label={t('audio.startTime')} value={clip.start} max={outDurationMs} onChange={(v) => updateAudioClip(clip.id, { start: v })} />
              <Toggle label={t('audio.loop')} value={clip.loop} onChange={(v) => updateAudioClip(clip.id, { loop: v })} />
            </>
          )}
          <div className="row2">
            <Slider
              label={t('audio.fadeIn')}
              value={clip.fadeInMs}
              min={0}
              max={3000}
              step={50}
              format={(v) => `${v} ms`}
              onBegin={checkpoint}
              onChange={(v) => updateAudioClip(clip.id, { fadeInMs: v }, false)}
            />
            <Slider
              label={t('audio.fadeOut')}
              value={clip.fadeOutMs}
              min={0}
              max={3000}
              step={50}
              format={(v) => `${v} ms`}
              onBegin={checkpoint}
              onChange={(v) => updateAudioClip(clip.id, { fadeOutMs: v }, false)}
            />
          </div>
          <button className="btn btn-small danger" onClick={() => removeAudioClip(clip.id)}>
            <Trash2 size={14} /> {t('audio.delete')}
          </button>
        </>
      )}
      <p className="muted small">{t('audio.help')}</p>
    </>
  )
}

function CursorPanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const updateCursor = useStore((s) => s.updateCursor)
  const checkpoint = useStore((s) => s.checkpoint)
  const c = project.cursor
  const data = project.cursorData

  return (
    <>
      <h3>{t('cursor.highlight')}</h3>
      <Toggle label={t('cursor.highlightOn')} value={c.highlight} onChange={(v) => updateCursor({ highlight: v })} />
      {c.highlight && (
        <>
          <ColorField label={t('cursor.color')} value={c.highlightColor} onChange={(v) => updateCursor({ highlightColor: v })} />
          <Slider label={t('cursor.radius')} value={c.highlightRadius} min={8} max={90} step={1} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateCursor({ highlightRadius: v }, false)} />
          <Slider label={t('cursor.opacity')} value={c.highlightOpacity} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateCursor({ highlightOpacity: v }, false)} />
          <Toggle label={t('cursor.outline')} value={c.highlightOutline} onChange={(v) => updateCursor({ highlightOutline: v })} />
        </>
      )}

      <h3>{t('cursor.clicks')}</h3>
      <Toggle label={t('cursor.showClicks')} value={c.clicks} onChange={(v) => updateCursor({ clicks: v })} />
      {c.clicks && (
        <>
          <div className="row2">
            <ColorField label={t('cursor.leftClick')} value={c.clickColor} onChange={(v) => updateCursor({ clickColor: v })} />
            <ColorField label={t('cursor.rightClick')} value={c.rightClickColor} onChange={(v) => updateCursor({ rightClickColor: v })} />
          </div>
          <Slider label={t('cursor.rippleSize')} value={c.clickRadius} min={16} max={120} step={2} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateCursor({ clickRadius: v }, false)} />
          <Slider label={t('cursor.rippleDuration')} value={c.clickDurationMs} min={150} max={1200} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateCursor({ clickDurationMs: v }, false)} />
        </>
      )}

      <h3>{t('cursor.camera')}</h3>
      <Slider label={t('cursor.smoothing')} value={c.followSmoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateCursor({ followSmoothing: v }, false)} />
      <Slider label={t('cursor.deadZone')} value={c.followDeadZone} min={0} max={0.3} step={0.01} format={(v) => t('cursor.deadZoneValue', { v: Math.round(v * 100) })} onBegin={checkpoint} onChange={(v) => updateCursor({ followDeadZone: v }, false)} />
      <Slider label={t('cursor.sync')} value={c.offsetMs} min={-500} max={500} step={5} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateCursor({ offsetMs: v }, false)} />
      <p className="muted small">
        {t('cursor.syncHelp')} {t('cursor.recorded', { samples: data.samples.length, clicks: data.clicks.length })}
        {data.source === 'polling' ? ' ' + t('cursor.noHook') : ''}
      </p>
    </>
  )
}

function StylePanel({ t }: PanelProps): JSX.Element {
  const project = useProject()
  const updateFrame = useStore((s) => s.updateFrame)
  const checkpoint = useStore((s) => s.checkpoint)
  const f = project.frame
  const isGradient = f.background.startsWith('gradient:')
  const isTransparent = f.background === TRANSPARENT_BACKGROUND

  return (
    <>
      <h3>{t('style.frame')}</h3>
      <Slider label={t('style.padding')} value={f.padding} min={0} max={0.2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateFrame({ padding: v }, false)} />
      <Slider label={t('style.radius')} value={f.cornerRadius} min={0} max={64} step={1} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateFrame({ cornerRadius: v }, false)} />
      <Toggle label={t('style.shadow')} value={f.shadow} onChange={(v) => updateFrame({ shadow: v })} />
      <h3>{t('style.background')}</h3>
      <div className="swatches">
        <button
          className={'swatch checker' + (isTransparent ? ' active' : '')}
          onClick={() => updateFrame({ background: TRANSPARENT_BACKGROUND })}
          title={t('style.transparent')}
        />
        {['#111214', '#ffffff', '#1e293b', '#f1f5f9'].map((color) => (
          <button key={color} className={'swatch' + (f.background === color ? ' active' : '')} style={{ background: color }} onClick={() => updateFrame({ background: color })} title={color} />
        ))}
        {Object.entries(GRADIENT_PRESETS).map(([id, [a, b]]) => (
          <button key={id} className={'swatch' + (f.background === id ? ' active' : '')} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} onClick={() => updateFrame({ background: id })} title={id.replace('gradient:', '')} />
        ))}
      </div>
      <ColorField label={t('style.customColor')} value={isGradient || isTransparent ? '#111214' : f.background} onChange={(v) => updateFrame({ background: v })} />
      <p className="muted small">{isTransparent ? t('style.transparentHelp') : t('style.help')}</p>
    </>
  )
}
