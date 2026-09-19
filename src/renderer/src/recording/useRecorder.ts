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

/**
 * One recording attempt. It exists from the moment the user presses Start, so that
 * Stop / Discard from the floating bar work during the countdown as well.
 */
interface ActiveSession {
  id: string | null
  recorder: MediaRecorder | null
  stream: MediaStream | null
  probe: HTMLVideoElement | null
  chain: Promise<void>
  /** discard everything (bar X, or Stop before anything was captured) */
  cancelled: boolean
}

interface FrameMeta {
  captureTime?: DOMHighResTimeStamp
  receiveTime?: DOMHighResTimeStamp
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  /** Releases the capture and tells the main process to drop the attempt. */
  const discard = useCallback(async (s: ActiveSession) => {
    s.stream?.getTracks().forEach((t) => t.stop())
    if (s.probe) s.probe.srcObject = null
    if (s.id) await window.zc.recording.cancel(s.id).catch(() => undefined)
    if (session.current === s) session.current = null
    setPhase('idle')
  }, [])

  const stop = useCallback(() => {
    const s = session.current
    if (!s) return
    if (s.recorder && s.recorder.state !== 'inactive') {
      s.recorder.stop()
    } else {
      // nothing captured yet (countdown): stopping means dropping the attempt
      s.cancelled = true
    }
  }, [])

  const cancel = useCallback(() => {
    const s = session.current
    if (!s) return
    s.cancelled = true
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop()
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
      const s: ActiveSession = { id: null, recorder: null, stream: null, probe: null, chain: Promise.resolve(), cancelled: false }
      session.current = s

      let countdownEndsAt = Date.now() + 3000
      try {
        const prepared = await window.zc.recording.prepare(displayId)
        s.id = prepared.id
        countdownEndsAt = prepared.countdownEndsAt
        if (s.cancelled) {
          await discard(s)
          return
        }
        s.stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 60, max: 60 } },
          audio: false
        })
      } catch (err) {
        await discard(s)
        if (!s.cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
        }
        return
      }
      if (s.cancelled) {
        await discard(s)
        return
      }

      const recordingId = s.id!
      const stream = s.stream
      const track = stream.getVideoTracks()[0]
      const settings = track.getSettings()
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 25_000_000
      })
      s.recorder = recorder

      // probe video: lets us observe when frames actually arrive
      const probe = document.createElement('video')
      probe.muted = true
      probe.playsInline = true
      probe.srcObject = stream
      s.probe = probe
      await probe.play().catch(() => undefined)

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
          if (session.current === s) session.current = null
        }
      }
      track.addEventListener('ended', stop)

      // The floating bar counts down on the main process' clock; start when it hits zero.
      // Stop / Discard pressed meanwhile abort the attempt.
      setPhase('countdown')
      const deadline = Math.max(Date.now() + 300, countdownEndsAt)
      while (Date.now() < deadline) {
        if (s.cancelled) break
        await sleep(50)
      }
      if (s.cancelled) {
        await discard(s)
        return
      }
      recorder.start(1000)
    },
    [stop, discard]
  )

  return { phase, progress, error, start, stop, cancel, reset: () => setPhase('idle') }
}
