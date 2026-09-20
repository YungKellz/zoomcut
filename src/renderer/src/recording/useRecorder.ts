import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioCaptureOptions, Project, RecordingProgress, RecordingStartMeta } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'

export type RecorderPhase = 'idle' | 'starting' | 'countdown' | 'recording' | 'processing' | 'error'

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
]

const AUDIO_MIME = 'audio/webm;codecs=opus'

export function pickMimeType(): string {
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

export interface RecordOptions {
  /** track A: what to capture besides the screen */
  audio?: AudioCaptureOptions
  // track B adds an optional `scenario?: Scenario` field here (replay this scenario while recording)
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
  micStream: MediaStream | null
  micRecorder: MediaRecorder | null
  systemRecorder: MediaRecorder | null
  /** resolve once each recorder's own `stop` event has fired, whoever triggered it */
  micStopped: Promise<void>
  systemStopped: Promise<void>
}

interface FrameMeta {
  captureTime?: DOMHighResTimeStamp
  receiveTime?: DOMHighResTimeStamp
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves once the recorder's `stop` event fires; an already-inactive recorder resolves immediately. */
function waitStopped(rec: MediaRecorder | null): Promise<void> {
  if (!rec || rec.state === 'inactive') return Promise.resolve()
  return new Promise((resolve) => rec.addEventListener('stop', () => resolve(), { once: true }))
}

/**
 * Awaits the whole chunk-send chain, including any link appended *while* we were awaiting
 * an earlier one (ondataavailable can still fire between reading `s.chain` and settling it).
 * A plain `await s.chain` would miss those late extensions; re-read and loop until the
 * reference stops changing.
 */
async function drainChain(s: ActiveSession): Promise<void> {
  let pending: Promise<void>
  do {
    pending = s.chain
    await pending
  } while (pending !== s.chain)
}

/** Appends one chunk-send to the shared chain. Failures are logged, not fatal: losing one
 * chunk should not abort an otherwise fine recording, and this keeps `s.chain` from ever
 * sitting rejected-and-unobserved between two ondataavailable events. */
function appendChunk(s: ActiveSession, send: () => Promise<void>): void {
  s.chain = s.chain.then(send).catch((err) => console.error('[useRecorder] failed to send a chunk', err))
}

/** A mic failure must not kill the recording, so this reports the error instead of throwing. */
async function tryOpenMic(options: AudioCaptureOptions): Promise<{ stream: MediaStream } | { error: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.micDeviceId ? { exact: options.micDeviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    return { stream }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function makeAudioRecorder(track: MediaStreamTrack): MediaRecorder | null {
  try {
    return new MediaRecorder(new MediaStream([track]), { mimeType: AUDIO_MIME, audioBitsPerSecond: 128_000 })
  } catch (err) {
    console.error('Could not create an audio recorder', err)
    return null
  }
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
 *
 * Audio: system loopback (when requested) rides along on the same getDisplayMedia stream
 * as an extra track, but the video MediaRecorder only ever sees the video track – the raw
 * recording stays audio-free, so transcodeRecording can keep using -an. Microphone audio is
 * a second, independent getUserMedia stream. Each source gets its own opus MediaRecorder,
 * started in the same tick as the video one so their `startWall` timestamps line up; the
 * main process turns that into an AudioClip offset in recording:finish. Either source can
 * fail (no hardware, OS/driver refuses loopback, permission denied) without losing the
 * recording: failures are reported through the store's dismissible notice (App.tsx), which
 * survives the Home -> Editor screen switch that a successful recording causes.
 */
export function useRecorder(onDone: (project: Project) => void): {
  phase: RecorderPhase
  progress: RecordingProgress | null
  error: string | null
  start: (displayId: number, options?: RecordOptions) => Promise<void>
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
    s.stream?.getTracks().forEach((tr) => tr.stop())
    s.micStream?.getTracks().forEach((tr) => tr.stop())
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
      if (s.micRecorder && s.micRecorder.state !== 'inactive') s.micRecorder.stop()
      if (s.systemRecorder && s.systemRecorder.state !== 'inactive') s.systemRecorder.stop()
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
    if (s.micRecorder && s.micRecorder.state !== 'inactive') s.micRecorder.stop()
    if (s.systemRecorder && s.systemRecorder.state !== 'inactive') s.systemRecorder.stop()
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
    async (displayId: number, options?: RecordOptions) => {
      if (session.current) return
      setError(null)
      setProgress(null)
      setPhase('starting')
      const s: ActiveSession = {
        id: null,
        recorder: null,
        stream: null,
        probe: null,
        chain: Promise.resolve(),
        cancelled: false,
        micStream: null,
        micRecorder: null,
        systemRecorder: null,
        micStopped: Promise.resolve(),
        systemStopped: Promise.resolve()
      }
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

        const wantsSystemAudio = options?.audio?.system === true
        let systemAudioFailed = false
        try {
          s.stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60, max: 60 } },
            audio: wantsSystemAudio
          })
        } catch (err) {
          // system-loopback audio can fail at the OS/driver level even though plain video
          // capture works fine (seen on real hardware, not just missing devices); retry
          // video-only rather than losing the whole recording over it
          if (!wantsSystemAudio) throw err
          console.warn('System audio capture failed, retrying without it:', err)
          systemAudioFailed = true
          s.stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60, max: 60 } },
            audio: false
          })
        }

        const notices: string[] = []
        if (wantsSystemAudio && (systemAudioFailed || s.stream.getAudioTracks().length === 0)) {
          notices.push(t('audio.systemAudioFailed'))
        }
        if (options?.audio?.mic) {
          const mic = await tryOpenMic(options.audio)
          if ('stream' in mic) {
            s.micStream = mic.stream
          } else {
            console.warn('Microphone unavailable, recording without it:', mic.error)
            notices.push(`${t('home.micWarningTitle')} ${t('home.micWarning', { error: mic.error })}`)
          }
        }
        if (notices.length > 0) useStore.getState().setNotice(notices.join(' '))
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
      // the raw recording stays video-only even when system audio was captured alongside it
      const videoOnlyStream = new MediaStream([track])
      const recorder = new MediaRecorder(videoOnlyStream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 25_000_000
      })
      s.recorder = recorder

      const systemTrack = stream.getAudioTracks()[0]
      if (systemTrack) {
        s.systemRecorder = makeAudioRecorder(systemTrack)
        if (s.systemRecorder) {
          s.systemRecorder.ondataavailable = (e) => {
            if (e.data.size === 0 || s.cancelled) return
            const blob = e.data
            appendChunk(s, async () => {
              const buf = await blob.arrayBuffer()
              await window.zc.recording.audioChunk(recordingId, 'system', buf)
            })
          }
        }
      }
      const micTrack = s.micStream?.getAudioTracks()[0]
      if (micTrack) {
        s.micRecorder = makeAudioRecorder(micTrack)
        if (s.micRecorder) {
          s.micRecorder.ondataavailable = (e) => {
            if (e.data.size === 0 || s.cancelled) return
            const blob = e.data
            appendChunk(s, async () => {
              const buf = await blob.arrayBuffer()
              await window.zc.recording.audioChunk(recordingId, 'mic', buf)
            })
          }
        }
      }

      // probe video: lets us observe when frames actually arrive
      const probe = document.createElement('video')
      probe.muted = true
      probe.playsInline = true
      probe.srcObject = videoOnlyStream
      s.probe = probe
      await probe.play().catch(() => undefined)

      let startedResolve: (startedAt: number) => void = () => undefined
      const startedAt = new Promise<number>((resolve) => {
        startedResolve = resolve
      })
      // filled in right before the audio recorders start, a few lines below; `.then` only
      // reads it once `startedAt` resolves (after the video recorder's onstart), so this
      // plain variable capture is safe despite being assigned after the chain is built
      let audioStartMeta: RecordingStartMeta['audio']
      s.chain = startedAt.then((at) =>
        window.zc.recording.started(recordingId, {
          startedAt: at,
          mimeType: recorder.mimeType || mimeType,
          width: settings.width ?? 0,
          height: settings.height ?? 0,
          fps: settings.frameRate ?? 30,
          audio: audioStartMeta
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
        appendChunk(s, async () => {
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
        stream.getTracks().forEach((tr) => tr.stop())
        s.micStream?.getTracks().forEach((tr) => tr.stop())
        probe.srcObject = null
        try {
          // the video track ending above can itself finalize the audio recorders; either
          // way, wait for their own `stop` event so the last chunk is queued before finish
          await Promise.all([s.micStopped, s.systemStopped])
          await drainChain(s)
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
      const audioWall = Date.now()
      const meta: NonNullable<RecordingStartMeta['audio']> = {}
      if (s.micRecorder) {
        s.micRecorder.start(1000)
        // only meaningful once the recorder is actually running: an 'inactive' recorder
        // resolves waitStopped() immediately, which would race recording:finish
        s.micStopped = waitStopped(s.micRecorder)
        meta.mic = { startWall: audioWall }
      }
      if (s.systemRecorder) {
        s.systemRecorder.start(1000)
        s.systemStopped = waitStopped(s.systemRecorder)
        meta.system = { startWall: audioWall }
      }
      if (meta.mic || meta.system) audioStartMeta = meta
    },
    [stop, discard]
  )

  return {
    phase,
    progress,
    error,
    start,
    stop,
    cancel,
    reset: () => setPhase('idle')
  }
}
