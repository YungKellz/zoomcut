import type {
  AppInfo,
  AppSettings,
  DisplayInfo,
  ExportBeginRequest,
  ExportBeginResult,
  ExportFinishResult,
  ExportProgress,
  ExportSettings,
  Project,
  ProjectSummary,
  RecorderBarState,
  RecordingProgress,
  RecordingStartMeta
} from './types'

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
    prepare(displayId: number): Promise<{ id: string; countdownEndsAt: number }>
    started(id: string, meta: RecordingStartMeta): Promise<void>
    chunk(id: string, data: ArrayBuffer): Promise<void>
    finish(id: string): Promise<Project>
    cancel(id: string): Promise<void>
    /** Stop / cancel requests coming from the floating bar or the global shortcut. */
    onStopRequested(cb: () => void): Unsubscribe
    onCancelRequested(cb: () => void): Unsubscribe
    onProgress(cb: (p: RecordingProgress) => void): Unsubscribe
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
}
