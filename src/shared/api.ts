import type {
  AppInfo,
  AppSettings,
  DisplayInfo,
  ExportBeginRequest,
  ExportBeginResult,
  ExportFinishResult,
  ExportProgress,
  ExportSettings,
  OverlayEffect,
  Project,
  ProjectSummary,
  Rect,
  RecorderBarState,
  RecordingProgress,
  RecordingStartMeta,
  ReplayState,
  Scenario,
  ScenarioCaptureState,
  ScenarioSummary,
  UpdateState
} from './types'
import type { ReplayStep } from './scenario'

export type Unsubscribe = () => void

/** The API exposed on `window.zc` by the preload script. */
export interface ZcApi {
  app: {
    info(): Promise<AppInfo>
    getSettings(): Promise<AppSettings>
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    openPath(path: string): Promise<void>
    showInFolder(path: string): Promise<void>
    chooseFolder(defaultPath?: string): Promise<string | null>
    openExternal(url: string): Promise<void>
  }
  displays: {
    list(): Promise<DisplayInfo[]>
  }
  recording: {
    prepare(displayId: number, options?: { scenario?: Scenario }): Promise<{ id: string; countdownEndsAt: number }>
    started(id: string, meta: RecordingStartMeta): Promise<void>
    chunk(id: string, data: ArrayBuffer): Promise<void>
    finish(id: string): Promise<Project>
    cancel(id: string): Promise<void>
    /** Stop / cancel requests coming from the floating bar or the global shortcut. */
    onStopRequested(cb: () => void): Unsubscribe
    onCancelRequested(cb: () => void): Unsubscribe
    onProgress(cb: (p: RecordingProgress) => void): Unsubscribe
    /** progress of a scenario replay driving this recording; unused for a plain recording */
    onReplayState(cb: (s: ReplayState) => void): Unsubscribe
  }
  bar: {
    onState(cb: (s: RecorderBarState) => void): Unsubscribe
    requestState(): Promise<RecorderBarState>
    stop(): Promise<void>
    cancel(): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    load(id: string): Promise<Project>
    save(project: Project): Promise<void>
    remove(id: string): Promise<void>
    reveal(id: string): Promise<void>
  }
  media: {
    /** Builds a URL for the custom media protocol serving a local file with range support. */
    url(path: string): string
  }
  export: {
    begin(req: ExportBeginRequest): Promise<ExportBeginResult>
    write(exportId: string, position: number, data: ArrayBuffer): Promise<void>
    /** raw mode only: one RGBA frame */
    writeRaw(exportId: string, data: ArrayBuffer): Promise<void>
    finish(exportId: string, settings: ExportSettings, meta: { durationMs: number; alpha?: boolean }): Promise<ExportFinishResult>
    cancel(exportId: string): Promise<void>
    onProgress(cb: (p: ExportProgress) => void): Unsubscribe
  }
  update: {
    /** current auto-update state; `reason` tells why it is disabled */
    getState(): Promise<UpdateState>
    /** manual check; resolves once the feed has answered */
    check(): Promise<UpdateState>
    /** quit, install the downloaded update silently and relaunch */
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): Unsubscribe
  }

  // ---- scenario ----
  scenario: {
    start(displayId: number): Promise<void>
    stop(): Promise<void>
    cancel(): Promise<void>
    getState(): Promise<ScenarioCaptureState>
    onState(cb: (s: ScenarioCaptureState) => void): Unsubscribe
    onDone(cb: (s: Scenario | null) => void): Unsubscribe
    list(): Promise<ScenarioSummary[]>
    load(id: string): Promise<Scenario>
    save(scenario: Scenario): Promise<void>
    remove(id: string): Promise<void>
  }
  overlay: {
    onEffect(cb: (e: OverlayEffect) => void): Unsubscribe
    onReplayState(cb: (s: ReplayState) => void): Unsubscribe
  }
  /** Only functional under ZOOMCUT_E2E=1; rejects otherwise (no handler registered). */
  e2e: {
    openTarget(bounds: Rect): Promise<void>
    injectSteps(steps: ReplayStep[]): Promise<void>
  }
}
