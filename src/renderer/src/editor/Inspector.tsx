import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Crosshair, Crop, MousePointer2, Scissors, Sparkles, Trash2, Type, ZoomIn } from 'lucide-react'
import type { TextOverlay, ZoomSegment } from '@shared/types'
import { GRADIENT_PRESETS } from '@shared/defaults'
import { useProject, useStore } from '../store'
import { generateZoomsFromClicks } from '../engine/zoomAuto'
import { TRANSPARENT_BACKGROUND } from '../engine/compose'
import { formatTimecode } from '../util/format'
import { useT, type Translate } from '../i18n'

type Tab = 'clip' | 'zoom' | 'text' | 'cursor' | 'style'

export function Inspector(): JSX.Element {
  const t = useT()
  const selection = useStore((s) => s.selection)
  const [tab, setTab] = useState<Tab>('clip')

  useEffect(() => {
    if (selection?.kind === 'zoom') setTab('zoom')
    else if (selection?.kind === 'text') setTab('text')
    else if (selection?.kind === 'cut') setTab('clip')
  }, [selection])

  const tabs: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'clip', label: t('tab.clip'), icon: <Scissors size={14} /> },
    { id: 'zoom', label: t('tab.zoom'), icon: <ZoomIn size={14} /> },
    { id: 'text', label: t('tab.text'), icon: <Type size={14} /> },
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
          <ul className="list">
            {project.cuts.map((c) => (
              <li key={c.id} className="list-item">
                <button className="list-main" onClick={() => select({ kind: 'cut', id: c.id })}>
                  {formatTimecode(c.start)} – {formatTimecode(c.end)}
                </button>
                <button className="btn btn-ghost danger" onClick={() => removeCut(c.id)} title={t('clip.restore')}>
                  <Trash2 size={14} />
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
  const setMode = useStore((s) => s.setMode)
  const checkpoint = useStore((s) => s.checkpoint)
  const duration = project.recording.durationMs
  const zoom: ZoomSegment | undefined = selection?.kind === 'zoom' ? project.zooms.find((z) => z.id === selection.id) : undefined

  const autoZooms = (): void => {
    const generated = generateZoomsFromClicks(project.cursorData.clicks, duration, project.cuts)
    if (generated.length === 0) {
      alert(t('zoom.noClicks'))
      return
    }
    if (project.zooms.length > 0 && !confirm(t('zoom.replaceConfirm', { n: project.zooms.length, m: generated.length }))) return
    setZooms(generated)
  }

  const pickOnFrame = (): void => {
    if (!zoom) return
    setPlayhead(Math.min(zoom.end - 1, zoom.start + Math.min(zoom.easeInMs, (zoom.end - zoom.start) / 2) + 50), true)
    setMode('pickTarget')
  }

  return (
    <>
      <div className="btn-row">
        <button className="btn btn-small" onClick={() => addZoom()}>
          <ZoomIn size={14} /> {t('zoom.add')}
        </button>
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
          <button className="btn btn-small" onClick={pickOnFrame}>
            <Crosshair size={14} /> {t('zoom.pick')}
          </button>
          <p className="muted small">{t('zoom.pickHelp')}</p>
          <div className="row2">
            <TimeInput label={t('zoom.start')} value={zoom.start} max={duration} onChange={(v) => updateZoom(zoom.id, { start: Math.min(v, zoom.end - 200) })} />
            <TimeInput label={t('zoom.end')} value={zoom.end} max={duration} onChange={(v) => updateZoom(zoom.id, { end: Math.max(v, zoom.start + 200) })} />
          </div>
          <details className="adv">
            <summary>{t('common.advanced')}</summary>
            <Slider label={t('zoom.easeIn')} value={zoom.easeInMs} min={100} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeInMs: v }, false)} />
            <Slider label={t('zoom.easeOut')} value={zoom.easeOutMs} min={100} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeOutMs: v }, false)} />
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
            <Slider label={t('text.animTime')} value={text.animationMs} min={80} max={800} step={20} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { animationMs: v }, false)} />
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
              </li>
            ))}
          </ul>
        </>
      )}
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
