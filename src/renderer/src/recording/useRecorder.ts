import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, RecordingProgress } from '@shared/types'

export type RecorderPhase = 'idle' | 'starting' | 'countdown' | 'recording' | 'processing' | 'error'

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
]

export function pickMimeType(): string {
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

interface ActiveSession {
  id: string
  recorder: MediaRecorder
  stream: MediaStream
  chain: Promise<void>
  cancelled: boolean
}

/**
 * Drives one recording from the main window: asks the main process to prepare
 * (cursor tracker, floating bar, display source), captures the display with
 * getDisplayMedia, streams MediaRecorder chunks to disk over IPC and finally
 * hands the finished project back.
 */
export function useRecorder(onDone: (project: Project) => void): {
  phase: RecorderPhase
  progress: RecordingProgress | null
  error: string | null
  start: (displayId: number) => Promise<void>
  stop: () => void
  cancel: () => void
  reset: () => void
} {
  const [phase, setPhase] = useState<RecorderPhase>('idle')
  const [progress, setProgress] = useState<RecordingProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<ActiveSession | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const stop = useCallback(() => {
    const s = session.current
    if (s && s.recorder.state !== 'inactive') s.recorder.stop()
  }, [])

  const cancel = useCallback(() => {
    const s = session.current
    if (!s) return
    s.cancelled = true
    if (s.recorder.state !== 'inactive') {
      s.recorder.stop()
    } else {
      s.stream.getTracks().forEach((t) => t.stop())
      void window.zc.recording.cancel(s.id)
      session.current = null
      setPhase('idle')
    }
  }, [])

  useEffect(() => {
    const offStop = window.zc.recording.onStopRequested(stop)
    const offCancel = window.zc.recording.onCancelRequested(cancel)
    const offProgress = window.zc.recording.onProgress(setProgress)
    return () => {
      offStop()
      offCancel()
      offProgress()
    }
  }, [stop, cancel])

  const start = useCallback(
    async (displayId: number) => {
      if (session.current) return
      setError(null)
      setProgress(null)
      setPhase('starting')

      let prepared: { id: string; countdownEndsAt: number } | null = null
      let stream: MediaStream | null = null
      try {
        prepared = await window.zc.recording.prepare(displayId)
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 60, max: 60 } },
          audio: false
        })
      } catch (err) {
        if (prepared) void window.zc.recording.cancel(prepared.id)
        stream?.getTracks().forEach((t) => t.stop())
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
        return
      }

      const recordingId = prepared.id
      const track = stream.getVideoTracks()[0]
      const settings = track.getSettings()
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 25_000_000
      })
      const s: ActiveSession = { id: recordingId, recorder, stream, chain: Promise.resolve(), cancelled: false }
      session.current = s

      recorder.onstart = () => {
        const meta = {
          startedAt: Date.now(),
          mimeType: recorder.mimeType || mimeType,
          width: settings.width ?? 0,
          height: settings.height ?? 0,
          fps: settings.frameRate ?? 30
        }
        s.chain = s.chain.then(() => window.zc.recording.started(recordingId, meta))
        setPhase('recording')
      }
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || s.cancelled) return
        const blob = e.data
        s.chain = s.chain.then(async () => {
          const buf = await blob.arrayBuffer()
          await window.zc.recording.chunk(recordingId, buf)
        })
      }
      recorder.onerror = (e) => {
        console.error('MediaRecorder error', e)
        const detail = (e as unknown as { error?: { message?: string } }).error?.message
        setError('Recording failed: ' + (detail ?? 'unknown error'))
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        try {
          await s.chain
          if (s.cancelled) {
            await window.zc.recording.cancel(recordingId)
            setPhase('idle')
            return
          }
          setPhase('processing')
          const project = await window.zc.recording.finish(recordingId)
          setPhase('idle')
          onDoneRef.current(project)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
        } finally {
          session.current = null
        }
      }
      track.addEventListener('ended', stop)

      // The floating bar counts down on the main process' clock; start when it hits zero.
      setPhase('countdown')
      const wait = Math.max(300, prepared.countdownEndsAt - Date.now())
      await new Promise((resolve) => setTimeout(resolve, wait))
      if (s.cancelled) return
      recorder.start(1000)
    },
    [stop]
  )

  return { phase, progress, error, start, stop, cancel, reset: () => setPhase('idle') }
}
