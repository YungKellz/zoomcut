import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Download, Pencil, Plus, X } from 'lucide-react'
import type { CompositionItem, ExportSettings, Project, ProjectSummary } from '@shared/types'
import { COMPOSITION_SIZES } from '@shared/defaults'
import { useStore } from '../store'
import { uid } from '../engine/ids'
import { ExportDialogView } from '../editor/ExportDialog'
import { runCompositionExport } from '../export/exporter'
import { estimateExportSize, type SizeEstimate } from '../export/estimate'
import { compositionFrame, compositionLayout, evenPx, fitScale, makeEntry, type CompositionEntry } from '../composition/layout'
import { CompositionPlayer } from '../composition/CompositionPlayer'
import { waitForMetadata } from '../util/video'
import { formatDuration } from '../util/format'
import { useT } from '../i18n'

type Loaded = Record<string, Project | 'missing'>

/** Size estimate of a composition: the recordings' own estimates at the scale they are rendered at. */
async function estimateComposition(
  entries: CompositionEntry[],
  frame: { width: number; height: number },
  settings: ExportSettings,
  signal: AbortSignal
): Promise<SizeEstimate> {
  let bytes = 0
  let motion = 0
  let detail = 0
  const width = evenPx(frame.width * settings.scale)
  const height = evenPx(frame.height * settings.scale)
  for (const entry of entries) {
    if (signal.aborted) break
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.src = window.zc.media.url(entry.project.recording.videoPath)
    try {
      await waitForMetadata(video)
      // the recording is rendered at the scale that fits it into the export frame
      const scale = fitScale(entry.project, width, height)
      const est = await estimateExportSize(entry.project, { ...settings, scale }, entry.followPath, video, signal)
      bytes += est.bytes
      motion += est.motion / entries.length
      detail += est.detail / entries.length
    } finally {
      video.removeAttribute('src')
      video.load()
    }
  }
  return { bytes, motion, detail }
}

export function CompositionScreen(): JSX.Element {
  const t = useT()
  const composition = useStore((s) => s.composition)!
  const setComposition = useStore((s) => s.setComposition)
  const closeComposition = useStore((s) => s.closeComposition)
  const openProject = useStore((s) => s.openProject)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loaded, setLoaded] = useState<Loaded>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.zc.projects.list().then(setProjects)
  }, [])

  // (re)load every referenced project: on mount the latest edits count, e.g. after returning
  // from the editor; afterwards only newly added ones are loaded
  const itemIds = composition.items.map((i) => i.projectId).join('|')
  useEffect(() => {
    let cancelled = false
    const ids = [...new Set(composition.items.map((i) => i.projectId))].filter((id) => !(id in loaded))
    if (ids.length === 0) return
    void Promise.all(
      ids.map(async (id): Promise<[string, Project | 'missing']> => {
        try {
          return [id, await window.zc.projects.load(id)]
        } catch {
          return [id, 'missing']
        }
      })
    ).then((pairs) => {
      if (!cancelled) setLoaded((cur) => ({ ...cur, ...Object.fromEntries(pairs) }))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds])

  const entries = useMemo(() => {
    const out: CompositionEntry[] = []
    for (const item of composition.items) {
      const p = loaded[item.projectId]
      if (p && p !== 'missing') out.push(makeEntry(item, p))
    }
    return out
  }, [composition.items, loaded])
  const layout = useMemo(() => compositionLayout(entries), [entries])
  const frame = compositionFrame(composition, entries)
  const missing = composition.items.filter((i) => loaded[i.projectId] === 'missing').length
  const firstSize = entries[0] ? compositionFrame({ size: null }, entries) : null

  const update = (patch: Partial<typeof composition>): void => setComposition((c) => ({ ...c, ...patch }))
  const setItems = (items: CompositionItem[]): void => update({ items })

  const add = (projectId: string): void => {
    if (!projectId) return
    setItems([...composition.items, { id: uid('item'), projectId }])
  }
  const move = (index: number, dir: -1 | 1): void => {
    const items = [...composition.items]
    const j = index + dir
    if (j < 0 || j >= items.length) return
    ;[items[index], items[j]] = [items[j], items[index]]
    setItems(items)
  }
  const remove = (id: string): void => setItems(composition.items.filter((i) => i.id !== id))

  const edit = async (projectId: string): Promise<void> => {
    setBusy(true)
    try {
      openProject(await window.zc.projects.load(projectId))
    } catch (err) {
      alert(t('home.openFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const sizeValue = composition.size ? `${composition.size.width}x${composition.size.height}` : 'auto'

  return (
    <div className="editor composition">
      <header className="editor-top">
        <button className="btn btn-ghost" onClick={closeComposition} title={t('editor.back')}>
          <ArrowLeft size={16} /> {t('editor.back')}
        </button>
        <input
          className="name-input"
          value={composition.name}
          onChange={(e) => update({ name: e.target.value })}
          spellCheck={false}
          aria-label={t('composition.name')}
        />
        <div className="editor-top-info muted">
          {t('composition.info', { w: frame.width, h: frame.height, n: entries.length, duration: formatDuration(layout.totalMs) })}
        </div>
        <div className="editor-top-actions">
          <button className="btn btn-primary" onClick={() => setExportOpen(true)} disabled={layout.totalMs <= 0}>
            <Download size={16} /> {t('editor.export')}
          </button>
        </div>
      </header>

      <div className="editor-main comp-main">
        <CompositionPlayer layout={layout} frame={frame} background={composition.background} />

        <aside className="inspector comp-side">
          <div className="panel">
            <h3>{t('composition.recordings')}</h3>
            {composition.items.length === 0 && <p className="muted small">{t('composition.emptyList')}</p>}
            <ol className="list comp-items">
              {composition.items.map((item, i) => {
                const p = loaded[item.projectId]
                const entry = entries.find((e) => e.item.id === item.id)
                return (
                  <li key={item.id} className={'list-item comp-item' + (p === 'missing' ? ' missing' : '')}>
                    <span className="comp-index">{i + 1}</span>
                    <div className="comp-item-main">
                      {p === 'missing' ? (
                        <span className="warn">
                          <AlertTriangle size={13} /> {t('composition.missing')}
                        </span>
                      ) : p ? (
                        <>
                          <span className="project-name">{p.name}</span>
                          <span className="muted small">
                            {formatDuration(entry?.outMs ?? 0)} · {p.recording.width}×{p.recording.height}
                          </span>
                        </>
                      ) : (
                        <span className="muted small">{t('preview.loading')}</span>
                      )}
                    </div>
                    <button className="btn btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} title={t('composition.moveUp')}>
                      <ArrowUp size={14} />
                    </button>
                    <button className="btn btn-ghost" disabled={i === composition.items.length - 1} onClick={() => move(i, 1)} title={t('composition.moveDown')}>
                      <ArrowDown size={14} />
                    </button>
                    <button className="btn btn-ghost" disabled={busy || !p || p === 'missing'} onClick={() => void edit(item.projectId)} title={t('composition.edit')}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-ghost danger" onClick={() => remove(item.id)} title={t('composition.remove')}>
                      <X size={14} />
                    </button>
                  </li>
                )
              })}
            </ol>
            {missing > 0 && <p className="warn small">{t('composition.missingHint', { n: missing })}</p>}

            <label className="field">
              <span className="field-label">
                {t('composition.add')}
              </span>
              <select value="" onChange={(e) => add(e.target.value)} disabled={projects.length === 0}>
                <option value="">{projects.length ? t('composition.addPlaceholder') : t('home.nothingYet')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {formatDuration(p.durationMs)}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">{t('composition.help')}</p>

            <h3>{t('composition.output')}</h3>
            <label className="field">
              <span className="field-label">{t('composition.size')}</span>
              <select
                value={sizeValue}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'auto') update({ size: null })
                  else {
                    const [w, h] = v.split('x').map(Number)
                    update({ size: { width: w, height: h } })
                  }
                }}
              >
                {COMPOSITION_SIZES.map((s) =>
                  s ? (
                    <option key={`${s.width}x${s.height}`} value={`${s.width}x${s.height}`}>
                      {s.width}×{s.height}
                    </option>
                  ) : (
                    <option key="auto" value="auto">
                      {firstSize ? t('composition.sizeAutoValue', { w: firstSize.width, h: firstSize.height }) : t('composition.sizeAuto')}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="field field-row">
              <input type="color" value={composition.background} onChange={(e) => update({ background: e.target.value })} />
              <span className="field-label">{t('composition.background')}</span>
            </label>
            <p className="muted small">{t('composition.fitHelp')}</p>
          </div>
        </aside>
      </div>

      {exportOpen && (
        <ExportDialogView
          initial={{
            ...composition.export,
            fileName: composition.export.fileName || composition.name.replace(/[^\w\- ]+/g, '').trim() || 'composition'
          }}
          frameSize={(scale) => ({ outW: evenPx(frame.width * scale), outH: evenPx(frame.height * scale) })}
          outMs={layout.totalMs}
          transparent={false}
          estimateKey={JSON.stringify([frame, layout.totalMs, composition.items.map((i) => i.projectId)])}
          estimate={(settings, signal) => estimateComposition(layout.spans.map((s) => s.entry), frame, settings, signal)}
          run={(settings, onProgress, signal) =>
            runCompositionExport({
              entries: layout.spans.map((s) => s.entry),
              frame,
              background: composition.background,
              settings,
              onProgress,
              signal
            })
          }
          onStart={(settings) => update({ export: settings })}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  )
}
