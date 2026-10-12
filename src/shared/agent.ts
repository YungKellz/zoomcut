/**
 * Agent control (MCP): the contract between the stdio bridge (src/mcp), the main process control
 * server (src/main/agent) and the renderer executor (src/renderer/src/agent). Times are ms
 * (project edits: source ms), scenario/screenshot coordinates are DIP relative to the display's
 * top-left corner, project positions are normalized like everywhere else in the data model.
 */
import type {
  AudioClipKind,
  BlurRegion,
  BlurStyle,
  ClickEvent,
  CropRect,
  CutRange,
  ExportSettings,
  FrameStyle,
  Mp4Quality,
  Rect,
  RecordingOrigin,
  TextAnimation,
  TextOverlay,
  ZoomSegment
} from './types'

export type AgentErrorCode = 'bad_params' | 'not_found' | 'busy' | 'cancelled' | 'failed' | 'no_window' | 'unknown_method'

/** Thrown by RPC handlers; the server turns it into `{ ok: false, error: { code, message } }`. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

/** `<userData>/agent-control.json`, written while the control server listens */
export interface AgentDiscovery {
  port: number
  token: string
  pid: number
  version: string
}

export type AgentRpcResponse = { ok: true; result: unknown } | { ok: false; error: { code: AgentErrorCode; message: string } }

export type AgentEditOp =
  | { op: 'rename'; name: string }
  | { op: 'addCut'; start: number; end: number }
  | { op: 'removeCut'; id: string }
  | {
      op: 'addZoom'
      start: number
      end: number
      mode: 'follow' | 'fixed'
      scale?: number
      target?: { x: number; y: number }
      easeInMs?: number
      easeOutMs?: number
    }
  | {
      op: 'updateZoom'
      id: string
      start?: number
      end?: number
      mode?: 'follow' | 'fixed'
      scale?: number
      target?: { x: number; y: number }
    }
  | { op: 'removeZoom'; id: string }
  | {
      op: 'addText'
      start: number
      end: number
      text: string
      x?: number
      y?: number
      fontSize?: number
      color?: string
      background?: string
      animation?: TextAnimation
    }
  | {
      op: 'updateText'
      id: string
      start?: number
      end?: number
      text?: string
      x?: number
      y?: number
      fontSize?: number
      color?: string
      background?: string
      animation?: TextAnimation
    }
  | { op: 'removeText'; id: string }
  | { op: 'addBlur'; start: number; end: number; x: number; y: number; w: number; h: number; style?: BlurStyle; strength?: number }
  | { op: 'removeBlur'; id: string }
  | { op: 'setCrop'; x: number; y: number; w: number; h: number }
  | { op: 'setFrame'; padding?: number; cornerRadius?: number; background?: string; shadow?: boolean }
  | { op: 'setCursor'; highlight?: boolean; clicks?: boolean; followSmoothing?: number; followDeadZone?: number }

/** What projects.get / projects.edit return: everything an agent needs to plan edits, nothing heavy. */
export interface AgentProjectView {
  id: string
  name: string
  createdAt: number
  dir: string
  width: number
  height: number
  fps: number
  sourceDurationMs: number
  outputDurationMs: number
  cuts: CutRange[]
  zooms: ZoomSegment[]
  texts: TextOverlay[]
  blurs: BlurRegion[]
  crop: CropRect
  frame: FrameStyle
  export: ExportSettings
  origin: RecordingOrigin | null
  /** recorded clicks (source ms, source-normalized position) – where zooms usually belong; at most 500 */
  clicks: ClickEvent[]
  audio: { id: string; kind: AudioClipKind; name: string }[]
}

export interface AgentExportParams {
  projectId: string
  format?: 'mp4' | 'gif'
  folder?: string
  fileName?: string
  fps?: number
  scale?: number
  mp4Quality?: Mp4Quality
  gifColors?: 256 | 128 | 64 | 32
}

export type AgentModifier = 'ctrl' | 'shift' | 'alt' | 'meta'

interface AgentTiming {
  durationMs?: number
  pauseMs?: number
}
export type AgentScenarioActionInput =
  | ({ kind: 'click' | 'doubleClick' | 'rightClick' | 'middleClick'; x: number; y: number; modifiers?: AgentModifier[] } & AgentTiming)
  | ({ kind: 'drag'; x: number; y: number; toX: number; toY: number } & AgentTiming)
  | ({ kind: 'scroll'; x: number; y: number; deltaY?: number; deltaX?: number } & AgentTiming)
  | ({ kind: 'type'; text: string } & AgentTiming)
  /** "Enter", "Ctrl+S", "Alt+Tab", "Ctrl+Shift+T", "F5" – see parseKeyChord in agentKeys.ts */
  | ({ kind: 'key'; key: string } & AgentTiming)

export interface AgentScenarioInput {
  name: string
  displayId?: number
  actions: AgentScenarioActionInput[]
}

export interface AgentScenarioView {
  id: string
  name: string
  displayId: number
  displayBounds: Rect
  /** replay length of the actions (scenarioEnd) */
  durationMs: number
  actions: (AgentScenarioActionInput & { id: string })[]
}

/** Methods main forwards to the renderer (`agent:command`). recording.start, scenarios.record and
 * capture.start only hand the start to the right screen; main waits for the real phase itself. */
export type AgentRendererMethod = 'projects.edit' | 'projects.export' | 'recording.start' | 'scenarios.record' | 'capture.start'

export interface AgentCommand {
  requestId: string
  method: AgentRendererMethod
  params: unknown
}

export type AgentReply =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: { code: AgentErrorCode; message: string } }

/** pushed by the renderer whenever the screen or the open project changes */
export interface AgentUiStatus {
  screen: string
  openProjectId: string | null
}

/** what the "AI agents (MCP)" dialog shows */
export interface AgentMcpConfig {
  /** command the MCP client runs: ZoomCut.exe (installed) or node (portable / dev) */
  command: string
  /** absolute path of zoomcut-mcp.cjs */
  bridge: string
  portable: boolean
  /** ready-to-paste `mcpServers` JSON for Claude Desktop / Cursor */
  json: string
  /** ready-to-run `claude mcp add ...` command for Claude Code */
  claudeCode: string
}
