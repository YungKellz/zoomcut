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
  probe: HTMLVideoElement
  chain: Promise<void>
  cancelled: boolean
}

interface FrameMeta {
  captureTime?: DOMHighResTimeStamp
  receiveTime?: DOMHighResTimeStamp
}

/**
 * Drives one recording from the main window: asks the main process to prepare
 * (cursor tracker, floating bar, display source), captures the display with
 * getDisplayMedia, streams MediaRecorder chunks to disk over IPC and finally
 * hands the finished project back.
 *
 * Cursor sync: MediaRecorder puts its first frame at t=0, so the cursor timeline is
 * anchored on the wall-clock capture time of the first frame delivered after
 * `recorder.start()`, observed through requestVideoFrameCallback on a probe <video>
 * attached to the same stream.
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
      s.probe.srcObject = null
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

      // probe video: lets us observe when frames actually arrive
      const probe = document.createElement('video')
      probe.muted = true
      probe.playsInline = true
      probe.srcObject = stream
      await probe.play().catch(() => undefined)

      const s: ActiveSession = { id: recordingId, recorder, stream, probe, chain: Promise.resolve(), cancelled: false }
      session.current = s

      let startedResolve: (startedAt: number) => void = () => undefined
      const startedAt = new Promise<number>((resolve) => {
        startedResolve = resolve
      })
      s.chain = startedAt.then((at) =>
        window.zc.recording.started(recordingId, {
          startedAt: at,
          mimeType: recorder.mimeType || mimeType,
          width: settings.width ?? 0,
          height: settings.height ?? 0,
          fps: settings.frameRate ?? 30
        })
      )

      recorder.onstart = () => {
        const startWall = Date.now()
        let resolved = false
        const resolveAt = (wall: number): void => {
          if (resolved) return
          resolved = true
          startedResolve(wall)
        }
        if (typeof probe.requestVideoFrameCallback === 'function') {
          probe.requestVideoFrameCallback((now, metadata) => {
            const m = metadata as FrameMeta
            const captured = m.captureTime ?? m.receiveTime ?? now
            resolveAt(Date.now() - (performance.now() - captured))
          })
          // safety net if no frame callback arrives (e.g. static screen)
          window.setTimeout(() => resolveAt(startWall + 60), 700)
        } else {
          resolveAt(startWall)
        }
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
        probe.srcObject = null
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
