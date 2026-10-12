import type { AudioCaptureOptions, ExportSettings, Mp4Quality, Project } from '@shared/types'
import { AgentError, type AgentEditOp, type AgentErrorCode, type AgentExportParams } from '@shared/agent'
import { DEFAULT_AUDIO_CAPTURE } from '@shared/defaults'
import { outputSize } from '../engine/compose'
import { defaultExportFileName, exportFpsOptions, withExportFormat } from '../export/settings'

/**
 * The executor's pure parts: parameters of the commands main forwards (untrusted JSON, so every
 * field is checked and a mistake is a `bad_params` that says what to fix), the export settings an
 * agent export ends up with, and how an exception becomes the reply's error.
 */

type Raw = Record<string, unknown>

function fail(message: string): never {
  throw new AgentError('bad_params', message)
}

function asObject(params: unknown): Raw {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) fail('params must be an object')
  return params as Raw
}

function str(raw: Raw, key: string): string {
  const v = raw[key]
  if (typeof v !== 'string' || v.trim() === '') fail(`${key} is required (a non-empty string)`)
  return v
}

function optStr(raw: Raw, key: string): string | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.trim() === '') fail(`${key} must be a non-empty string`)
  return v
}

function optBool(raw: Raw, key: string): boolean | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') fail(`${key} must be true or false`)
  return v
}

function optNum(raw: Raw, key: string): number | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${key} must be a number`)
  return v
}

function optOneOf<T extends string | number>(raw: Raw, key: string, options: readonly T[]): T | undefined {
  const v = raw[key]
  if (v === undefined || v === null) return undefined
  if (!(options as readonly unknown[]).includes(v)) fail(`${key} must be one of ${options.join(', ')}`)
  return v as T
}

// ---- projects.edit ----

export function parseEditParams(params: unknown): { projectId: string; operations: AgentEditOp[] } {
  const raw = asObject(params)
  const operations = raw.operations
  if (!Array.isArray(operations)) fail('operations must be an array of edit operations')
  return { projectId: str(raw, 'projectId'), operations: operations as AgentEditOp[] }
}

// ---- projects.export ----

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/
const EXPORT_EXTENSION = /\.(?:mp4|gif)$/i

export function parseExportParams(params: unknown): AgentExportParams {
  const raw = asObject(params)
  const out: AgentExportParams = { projectId: str(raw, 'projectId') }
  const format = optOneOf(raw, 'format', ['mp4', 'gif'] as const)
  if (format) out.format = format
  const folder = optStr(raw, 'folder')
  if (folder !== undefined) {
    if (!ABSOLUTE_PATH.test(folder.trim())) fail(`folder must be an absolute path, got "${folder}"`)
    out.folder = folder.trim()
  }
  const fileName = optStr(raw, 'fileName')
  // the export adds the extension itself: "demo.mp4" would end up as "demo.mp4.mp4"
  if (fileName !== undefined) {
    const name = fileName.trim().replace(EXPORT_EXTENSION, '').trim()
    if (!name) fail('fileName must not be empty')
    out.fileName = name
  }
  const fps = optNum(raw, 'fps')
  if (fps !== undefined) out.fps = fps
  const scale = optNum(raw, 'scale')
  if (scale !== undefined) {
    if (scale < 0.1 || scale > 1) fail(`scale must be between 0.1 and 1 (1 = the recording's own size), got ${scale}`)
    out.scale = scale
  }
  const quality = optOneOf<Mp4Quality>(raw, 'mp4Quality', ['low', 'medium', 'high', 'max'])
  if (quality) out.mp4Quality = quality
  const colors = optOneOf(raw, 'gifColors', [256, 128, 64, 32] as const)
  if (colors) out.gifColors = colors
  return out
}

/**
 * The settings of an agent export: the project's saved export settings (what the dialog would
 * start from), switched to the requested format the way the dialog's format buttons do, then the
 * explicit parameters on top. With no folder anywhere the file lands next to the recording.
 */
export function resolveExportSettings(project: Project, p: AgentExportParams, ctx: { lastExportFolder: string | null }): ExportSettings {
  let s: ExportSettings = { ...project.export, gif: { ...project.export.gif } }
  if (p.format && p.format !== s.format) s = withExportFormat(s, p.format, outputSize(project, 1).outW)
  if (p.scale !== undefined) s.scale = p.scale
  const fpsOptions = exportFpsOptions(s.format)
  if (p.fps !== undefined) {
    if (!fpsOptions.includes(p.fps)) fail(`fps ${p.fps} is not available for ${s.format.toUpperCase()}; use one of ${fpsOptions.join(', ')}`)
    s.fps = p.fps
  } else if (!fpsOptions.includes(s.fps)) {
    s.fps = s.format === 'gif' ? 15 : 30
  }
  if (p.mp4Quality) s.mp4Quality = p.mp4Quality
  if (p.gifColors) s.gif.colors = p.gifColors
  s.fileName = p.fileName ?? defaultExportFileName(project)
  s.folder = p.folder ?? (s.folder || ctx.lastExportFolder || project.recording.dir)
  return s
}

// ---- recording.start / scenarios.record / capture.start ----

export interface RecordParams {
  displayId?: number
  mic?: boolean
  systemAudio?: boolean
}

function displayId(raw: Raw): number | undefined {
  const v = optNum(raw, 'displayId')
  if (v !== undefined && !Number.isInteger(v)) fail('displayId must be an integer (see list_displays)')
  return v
}

export function parseRecordParams(params: unknown): RecordParams {
  const raw = asObject(params ?? {})
  return { displayId: displayId(raw), mic: optBool(raw, 'mic'), systemAudio: optBool(raw, 'systemAudio') }
}

export function parseScenarioRecordParams(params: unknown): { scenarioId: string; mic?: boolean; systemAudio?: boolean } {
  const raw = asObject(params)
  return { scenarioId: str(raw, 'scenarioId'), mic: optBool(raw, 'mic'), systemAudio: optBool(raw, 'systemAudio') }
}

export function parseCaptureParams(params: unknown): { displayId?: number } {
  return { displayId: displayId(asObject(params ?? {})) }
}

/** The audio sources of an agent recording: the home screen's remembered choice, overridden by the given flags. */
export function resolveAudio(defaults: AudioCaptureOptions | null, flags: { mic?: boolean; systemAudio?: boolean }): AudioCaptureOptions {
  const base = defaults ?? DEFAULT_AUDIO_CAPTURE
  return { mic: flags.mic ?? base.mic, micDeviceId: base.micDeviceId, system: flags.systemAudio ?? base.system }
}

// ---- replies ----

/** The `error` of a failed command's reply. */
export function errorPayload(err: unknown): { code: AgentErrorCode; message: string } {
  if (err instanceof AgentError) return { code: err.code, message: err.message }
  if (err instanceof DOMException && err.name === 'AbortError') return { code: 'cancelled', message: err.message || 'cancelled' }
  const message = err instanceof Error ? err.message : String(err)
  // an IPC rejection arrives as "Error invoking remote method 'x': Error: the real message"
  return { code: 'failed', message: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
}
