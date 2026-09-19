import type { JSX } from 'react'
import { useEffect } from 'react'
import { ArrowLeft, Download, Redo2, Undo2 } from 'lucide-react'
import { useProject, useStore } from '../store'
import { useFollowPath } from '../hooks/useFollowPath'
import { Preview } from '../editor/Preview'
import { Timeline } from '../editor/Timeline'
import { Inspector } from '../editor/Inspector'
import { ExportDialog } from '../editor/ExportDialog'
import { keepSegments, outputDuration } from '../engine/timeline'
import { formatDuration } from '../util/format'
import { useT } from '../i18n'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function Editor(): JSX.Element {
  const t = useT()
  const project = useProject()
  const followPath = useFollowPath(project)
  const closeProject = useStore((s) => s.closeProject)
  const setName = useStore((s) => s.setName)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.history.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const exportOpen = useStore((s) => s.exportOpen)
  const setExportOpen = useStore((s) => s.setExportOpen)

  const segments = keepSegments(project.recording.durationMs, project.cuts)
  const outDuration = outputDuration(segments)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const s = useStore.getState()
      if (s.exportOpen) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        s.undo()
      } else if ((ctrl && key === 'y') || (ctrl && e.shiftKey && key === 'z')) {
        e.preventDefault()
        s.redo()
      } else if (e.key === ' ') {
        e.preventDefault()
        if (s.mode === 'normal') s.togglePlay()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        s.deleteSelected()
      } else if (e.key === 'Escape') {
        if (s.mode !== 'normal') s.setMode('normal')
        else if (s.range) s.setRange(null)
        else s.select(null)
      } else if (key === 'z' && !ctrl) {
        s.addZoom()
      } else if (key === 't' && !ctrl) {
        s.addText()
      } else if (key === 'c' && !ctrl) {
        if (s.range) s.addCut(s.range.start, s.range.end)
      } else if (key === 'i' && !ctrl) {
        const end = s.range?.end ?? s.project!.recording.durationMs
        s.setRange({ start: Math.min(s.playheadMs, end - 1), end: Math.max(end, s.playheadMs + 1) })
      } else if (key === 'o' && !ctrl) {
        const start = s.range?.start ?? 0
        s.setRange({ start: Math.min(start, s.playheadMs - 1), end: Math.max(s.playheadMs, start + 1) })
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : 1000 / (s.project?.recording.fps || 30)
        s.setPlaying(false)
        s.setPlayhead(s.playheadMs + (e.key === 'ArrowLeft' ? -step : step), true)
      } else if (e.key === 'Home') {
        s.setPlaying(false)
        s.setPlayhead(0, true)
      } else if (e.key === 'End') {
        s.setPlaying(false)
        s.setPlayhead(s.project!.recording.durationMs, true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="editor">
      <header className="editor-top">
        <button className="btn btn-ghost" onClick={closeProject} title={t('editor.back')}>
          <ArrowLeft size={16} /> {t('editor.back')}
        </button>
        <input className="name-input" value={project.name} onChange={(e) => setName(e.target.value)} spellCheck={false} aria-label={t('editor.projectName')} />
        <div className="editor-top-info muted">
          {t('editor.info', {
            w: project.recording.width,
            h: project.recording.height,
            fps: project.recording.fps,
            src: formatDuration(project.recording.durationMs),
            out: formatDuration(outDuration)
          })}
        </div>
        <div className="editor-top-actions">
          <button className="btn btn-ghost" onClick={undo} disabled={!canUndo} title={t('editor.undo')}>
            <Undo2 size={16} />
          </button>
          <button className="btn btn-ghost" onClick={redo} disabled={!canRedo} title={t('editor.redo')}>
            <Redo2 size={16} />
          </button>
          <button className="btn btn-primary" onClick={() => setExportOpen(true)}>
            <Download size={16} /> {t('editor.export')}
          </button>
        </div>
      </header>

      <div className="editor-main">
        <Preview followPath={followPath} />
        <Inspector />
      </div>

      <Timeline />

      {exportOpen && <ExportDialog followPath={followPath} />}
    </div>
  )
}
