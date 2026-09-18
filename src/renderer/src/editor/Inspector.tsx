import type React from 'react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Crosshair, Crop, MousePointer2, Scissors, Sparkles, Trash2, Type, ZoomIn } from 'lucide-react'
import type { TextOverlay, ZoomSegment } from '@shared/types'
import { GRADIENT_PRESETS } from '@shared/defaults'
import { useProject, useStore } from '../store'
import { generateZoomsFromClicks } from '../engine/zoomAuto'
import { formatTimecode } from '../util/format'

type Tab = 'clip' | 'zoom' | 'text' | 'cursor' | 'style'

const TABS: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
  { id: 'clip', label: 'Clip', icon: <Scissors size={14} /> },
  { id: 'zoom', label: 'Zoom', icon: <ZoomIn size={14} /> },
  { id: 'text', label: 'Text', icon: <Type size={14} /> },
  { id: 'cursor', label: 'Cursor', icon: <MousePointer2 size={14} /> },
  { id: 'style', label: 'Style', icon: <Sparkles size={14} /> }
]

export function Inspector(): JSX.Element {
  const selection = useStore((s) => s.selection)
  const [tab, setTab] = useState<Tab>('clip')

  useEffect(() => {
    if (selection?.kind === 'zoom') setTab('zoom')
    else if (selection?.kind === 'text') setTab('text')
    else if (selection?.kind === 'cut') setTab('clip')
  }, [selection])

  return (
    <aside className="inspector">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="panel">
        {tab === 'clip' && <ClipPanel />}
        {tab === 'zoom' && <ZoomPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'cursor' && <CursorPanel />}
        {tab === 'style' && <StylePanel />}
      </div>
    </aside>
  )
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
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onBegin}
        onChange={(e) => onChange(Number(e.target.value))}
      />
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

function ClipPanel(): JSX.Element {
  const project = useProject()
  const playheadMs = useStore((s) => s.playheadMs)
  const range = useStore((s) => s.range)
  const addCut = useStore((s) => s.addCut)
  const removeCut = useStore((s) => s.removeCut)
  const select = useStore((s) => s.select)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const setCrop = useStore((s) => s.setCrop)
  const duration = project.recording.durationMs
  const crop = project.crop
  const isCropped = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1

  return (
    <>
      <h3>Trim & cut</h3>
      <div className="btn-row">
        <button className="btn btn-small" onClick={() => addCut(0, playheadMs)} disabled={playheadMs < 50}>
          Trim start → playhead
        </button>
        <button className="btn btn-small" onClick={() => addCut(playheadMs, duration)} disabled={playheadMs > duration - 50}>
          Trim playhead → end
        </button>
      </div>
      <button className="btn btn-small" disabled={!range} onClick={() => range && addCut(range.start, range.end)}>
        <Scissors size={14} /> Cut selected range
      </button>
      <p className="muted small">
        Select a range by dragging on the video track, or press <kbd>I</kbd> / <kbd>O</kbd> at the playhead. Cut pieces are
        skipped in playback and export; drag a cut's edges to adjust it.
      </p>
      {project.cuts.length > 0 && (
        <ul className="list">
          {project.cuts.map((c) => (
            <li key={c.id} className="list-item">
              <button className="list-main" onClick={() => { select({ kind: 'cut', id: c.id }); setPlayhead(c.start, true) }}>
                {formatTimecode(c.start)} – {formatTimecode(c.end)}
              </button>
              <button className="btn btn-ghost danger" onClick={() => removeCut(c.id)} title="Restore this piece">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Crop</h3>
      <div className="btn-row">
        <button className={'btn btn-small' + (mode === 'crop' ? ' active' : '')} onClick={() => setMode(mode === 'crop' ? 'normal' : 'crop')}>
          <Crop size={14} /> {mode === 'crop' ? 'Done' : 'Edit crop'}
        </button>
        <button className="btn btn-small" disabled={!isCropped} onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
          Reset
        </button>
      </div>
      <p className="muted small">
        {isCropped
          ? `${Math.round(crop.w * project.recording.width)}×${Math.round(crop.h * project.recording.height)} px from (${Math.round(
              crop.x * project.recording.width
            )}, ${Math.round(crop.y * project.recording.height)})`
          : 'Full frame. Crop to focus on a window or a part of the screen.'}
      </p>
    </>
  )
}

function ZoomPanel(): JSX.Element {
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
      alert('No clicks were recorded, so there is nothing to build zooms from.')
      return
    }
    if (project.zooms.length > 0 && !confirm(`Replace the existing ${project.zooms.length} zoom(s) with ${generated.length} generated from clicks?`)) return
    setZooms(generated)
  }

  return (
    <>
      <div className="btn-row">
        <button className="btn btn-small" onClick={() => addZoom()}>
          <ZoomIn size={14} /> Add zoom at playhead
        </button>
        <button className="btn btn-small" onClick={autoZooms} title="Create follow-cursor zooms around recorded clicks">
          <Sparkles size={14} /> Auto from clicks
        </button>
      </div>

      {zoom ? (
        <>
          <h3>Selected zoom</h3>
          <Slider label="Zoom" value={zoom.scale} min={1.2} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { scale: v }, false)} />
          <Field label="Focus">
            <div className="seg">
              <button className={'seg-btn' + (zoom.mode === 'follow' ? ' active' : '')} onClick={() => updateZoom(zoom.id, { mode: 'follow' })}>
                Follow cursor
              </button>
              <button className={'seg-btn' + (zoom.mode === 'fixed' ? ' active' : '')} onClick={() => updateZoom(zoom.id, { mode: 'fixed' })}>
                Fixed point
              </button>
            </div>
          </Field>
          {zoom.mode === 'fixed' && (
            <button className="btn btn-small" onClick={() => { setPlayhead(Math.min(zoom.end - 1, zoom.start + zoom.easeInMs + 100), true); setMode('pickTarget') }}>
              <Crosshair size={14} /> Pick focus point on the frame
            </button>
          )}
          <Slider label="Ease in" value={zoom.easeInMs} min={100} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeInMs: v }, false)} />
          <Slider label="Ease out" value={zoom.easeOutMs} min={100} max={1500} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateZoom(zoom.id, { easeOutMs: v }, false)} />
          <div className="row2">
            <TimeInput label="Start (s)" value={zoom.start} max={duration} onChange={(v) => updateZoom(zoom.id, { start: Math.min(v, zoom.end - 200) })} />
            <TimeInput label="End (s)" value={zoom.end} max={duration} onChange={(v) => updateZoom(zoom.id, { end: Math.max(v, zoom.start + 200) })} />
          </div>
          <button className="btn btn-small danger" onClick={() => removeZoom(zoom.id)}>
            <Trash2 size={14} /> Delete zoom
          </button>
        </>
      ) : (
        <p className="muted small">Select a zoom on the timeline to edit it, or double-click the zoom track to add one.</p>
      )}

      {project.zooms.length > 0 && (
        <>
          <h3>All zooms</h3>
          <ul className="list">
            {project.zooms.map((z) => (
              <li key={z.id} className={'list-item' + (zoom?.id === z.id ? ' active' : '')}>
                <button className="list-main" onClick={() => { select({ kind: 'zoom', id: z.id }); setPlayhead(z.start + Math.min(z.easeInMs, (z.end - z.start) / 2), true) }}>
                  {formatTimecode(z.start)} – {formatTimecode(z.end)} · {z.scale.toFixed(1)}× {z.mode}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">
        Follow mode pans with the recorded mouse position; smoothing and dead zone are in the Cursor tab. Follow-cursor zooms need
        cursor data captured during the recording.
      </p>
    </>
  )
}

function TextPanel(): JSX.Element {
  const project = useProject()
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const addText = useStore((s) => s.addText)
  const updateText = useStore((s) => s.updateText)
  const removeText = useStore((s) => s.removeText)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const checkpoint = useStore((s) => s.checkpoint)
  const duration = project.recording.durationMs
  const text: TextOverlay | undefined = selection?.kind === 'text' ? project.texts.find((t) => t.id === selection.id) : undefined

  return (
    <>
      <button className="btn btn-small" onClick={() => addText()}>
        <Type size={14} /> Add text at playhead
      </button>
      {text ? (
        <>
          <h3>Selected text</h3>
          <Field label="Text">
            <textarea rows={3} value={text.text} onFocus={checkpoint} onChange={(e) => updateText(text.id, { text: e.target.value }, false)} />
          </Field>
          <div className="row2">
            <TimeInput label="Start (s)" value={text.start} max={duration} onChange={(v) => updateText(text.id, { start: Math.min(v, text.end - 100) })} />
            <TimeInput label="End (s)" value={text.end} max={duration} onChange={(v) => updateText(text.id, { end: Math.max(v, text.start + 100) })} />
          </div>
          <Slider label="Size" value={text.fontSize} min={0.02} max={0.14} step={0.005} format={(v) => `${Math.round(v * 1080)} px @1080p`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { fontSize: v }, false)} />
          <div className="row2">
            <ColorField label="Text color" value={text.color} onChange={(v) => updateText(text.id, { color: v })} />
            <ColorField label="Background" value={text.background} onChange={(v) => updateText(text.id, { background: v })} />
          </div>
          <Slider label="Background opacity" value={text.backgroundOpacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { backgroundOpacity: v }, false)} />
          <Slider label="Corner radius" value={text.cornerRadius} min={0} max={40} step={1} format={(v) => `${v} px`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { cornerRadius: v }, false)} />
          <div className="row2">
            <Toggle label="Bold" value={text.bold} onChange={(v) => updateText(text.id, { bold: v })} />
            <Field label="Align">
              <select value={text.align} onChange={(e) => updateText(text.id, { align: e.target.value as TextOverlay['align'] })}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
          </div>
          <div className="row2">
            <Field label="Animation">
              <select value={text.animation} onChange={(e) => updateText(text.id, { animation: e.target.value as TextOverlay['animation'] })}>
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="pop">Pop</option>
              </select>
            </Field>
            <Slider label="Anim. time" value={text.animationMs} min={80} max={800} step={20} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateText(text.id, { animationMs: v }, false)} />
          </div>
          <p className="muted small">Drag the text on the preview to position it.</p>
          <button className="btn btn-small danger" onClick={() => removeText(text.id)}>
            <Trash2 size={14} /> Delete text
          </button>
        </>
      ) : (
        <p className="muted small">Select a text on the timeline to edit it, or double-click the text track to add one.</p>
      )}
      {project.texts.length > 0 && (
        <>
          <h3>All texts</h3>
          <ul className="list">
            {project.texts.map((t) => (
              <li key={t.id} className={'list-item' + (text?.id === t.id ? ' active' : '')}>
                <button className="list-main" onClick={() => { select({ kind: 'text', id: t.id }); setPlayhead(t.start + 50, true) }}>
                  {formatTimecode(t.start)} · {t.text.split('\n')[0] || '(empty)'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function CursorPanel(): JSX.Element {
  const project = useProject()
  const updateCursor = useStore((s) => s.updateCursor)
  const checkpoint = useStore((s) => s.checkpoint)
  const c = project.cursor
  const data = project.cursorData

  return (
    <>
      <h3>Cursor highlight</h3>
      <Toggle label="Highlight cursor" value={c.highlight} onChange={(v) => updateCursor({ highlight: v })} />
      {c.highlight && (
        <>
          <ColorField label="Color" value={c.highlightColor} onChange={(v) => updateCursor({ highlightColor: v })} />
          <Slider label="Radius" value={c.highlightRadius} min={8} max={90} step={1} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateCursor({ highlightRadius: v }, false)} />
          <Slider label="Opacity" value={c.highlightOpacity} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateCursor({ highlightOpacity: v }, false)} />
          <Toggle label="Outline" value={c.highlightOutline} onChange={(v) => updateCursor({ highlightOutline: v })} />
        </>
      )}

      <h3>Click ripples</h3>
      <Toggle label="Show clicks" value={c.clicks} onChange={(v) => updateCursor({ clicks: v })} />
      {c.clicks && (
        <>
          <div className="row2">
            <ColorField label="Left click" value={c.clickColor} onChange={(v) => updateCursor({ clickColor: v })} />
            <ColorField label="Right click" value={c.rightClickColor} onChange={(v) => updateCursor({ rightClickColor: v })} />
          </div>
          <Slider label="Ripple size" value={c.clickRadius} min={16} max={120} step={2} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateCursor({ clickRadius: v }, false)} />
          <Slider label="Ripple duration" value={c.clickDurationMs} min={150} max={1200} step={50} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateCursor({ clickDurationMs: v }, false)} />
        </>
      )}

      <h3>Follow-cursor camera</h3>
      <Slider label="Smoothing" value={c.followSmoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateCursor({ followSmoothing: v }, false)} />
      <Slider label="Dead zone" value={c.followDeadZone} min={0} max={0.3} step={0.01} format={(v) => `${Math.round(v * 100)}% of screen`} onBegin={checkpoint} onChange={(v) => updateCursor({ followDeadZone: v }, false)} />
      <Slider label="Sync offset" value={c.offsetMs} min={-500} max={500} step={10} format={(v) => `${v} ms`} onBegin={checkpoint} onChange={(v) => updateCursor({ offsetMs: v }, false)} />
      <p className="muted small">
        If the highlight runs ahead of or behind the real cursor in the video, adjust the sync offset. Recorded: {data.samples.length}{' '}
        positions, {data.clicks.length} clicks
        {data.source === 'polling' ? ' (global mouse hook unavailable: clicks were not captured)' : ''}.
      </p>
    </>
  )
}

function StylePanel(): JSX.Element {
  const project = useProject()
  const updateFrame = useStore((s) => s.updateFrame)
  const checkpoint = useStore((s) => s.checkpoint)
  const f = project.frame
  const isGradient = f.background.startsWith('gradient:')

  return (
    <>
      <h3>Frame</h3>
      <Slider label="Padding" value={f.padding} min={0} max={0.2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onBegin={checkpoint} onChange={(v) => updateFrame({ padding: v }, false)} />
      <Slider label="Corner radius" value={f.cornerRadius} min={0} max={64} step={1} format={(v) => `${v} px @1080p`} onBegin={checkpoint} onChange={(v) => updateFrame({ cornerRadius: v }, false)} />
      <Toggle label="Shadow" value={f.shadow} onChange={(v) => updateFrame({ shadow: v })} />
      <h3>Background</h3>
      <div className="swatches">
        {['#111214', '#ffffff', '#1e293b', '#f1f5f9'].map((color) => (
          <button key={color} className={'swatch' + (f.background === color ? ' active' : '')} style={{ background: color }} onClick={() => updateFrame({ background: color })} title={color} />
        ))}
        {Object.entries(GRADIENT_PRESETS).map(([id, [a, b]]) => (
          <button key={id} className={'swatch' + (f.background === id ? ' active' : '')} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} onClick={() => updateFrame({ background: id })} title={id.replace('gradient:', '')} />
        ))}
      </div>
      <ColorField label="Custom color" value={isGradient ? '#111214' : f.background} onChange={(v) => updateFrame({ background: v })} />
      <p className="muted small">Padding and background only matter when padding is above zero – the frame is drawn around the recording.</p>
    </>
  )
}
