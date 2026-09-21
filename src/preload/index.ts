import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ZcApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ZcApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    getSettings: () => ipcRenderer.invoke('app:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
    openPath: (p) => ipcRenderer.invoke('app:open-path', p),
    showInFolder: (p) => ipcRenderer.invoke('app:show-in-folder', p),
    chooseFolder: (defaultPath) => ipcRenderer.invoke('app:choose-folder', defaultPath),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
  },
  displays: {
    list: () => ipcRenderer.invoke('displays:list')
  },
  recording: {
    prepare: (displayId, options) => ipcRenderer.invoke('recording:prepare', displayId, options),
    started: (id, meta) => ipcRenderer.invoke('recording:started', id, meta),
    chunk: (id, data) => ipcRenderer.invoke('recording:chunk', id, data),
    audioChunk: (id, kind, data) => ipcRenderer.invoke('recording:audio-chunk', id, kind, data),
    finish: (id) => ipcRenderer.invoke('recording:finish', id),
    cancel: (id) => ipcRenderer.invoke('recording:cancel', id),
    onStopRequested: (cb) => subscribe('recorder:stop', cb),
    onCancelRequested: (cb) => subscribe('recorder:cancel', cb),
    onProgress: (cb) => subscribe('recording:progress', cb),
    onReplayState: (cb) => subscribe('recording:replay-state', cb)
  },
  bar: {
    onState: (cb) => subscribe('bar:state', cb),
    requestState: () => ipcRenderer.invoke('bar:request-state'),
    stop: () => ipcRenderer.invoke('bar:stop'),
    cancel: () => ipcRenderer.invoke('bar:cancel')
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    load: (id) => ipcRenderer.invoke('projects:load', id),
    save: (project) => ipcRenderer.invoke('projects:save', project),
    remove: (id) => ipcRenderer.invoke('projects:delete', id),
    reveal: (id) => ipcRenderer.invoke('projects:reveal', id)
  },
  media: {
    url: (p) => `zc-media://local/${Buffer.from(p, 'utf8').toString('base64url')}`
  },
  export: {
    begin: (req) => ipcRenderer.invoke('export:begin', req),
    write: (exportId, position, data) => ipcRenderer.invoke('export:write', exportId, position, data),
    writeRaw: (exportId, data) => ipcRenderer.invoke('export:write-raw', exportId, data),
    finish: (exportId, settings, meta) => ipcRenderer.invoke('export:finish', exportId, settings, meta),
    cancel: (exportId) => ipcRenderer.invoke('export:cancel', exportId),
    onProgress: (cb) => subscribe('export:progress', cb)
  },
  update: {
    getState: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => subscribe('update:changed', cb)
  },
  audio: {
    importClip: (projectId, clip) => ipcRenderer.invoke('audio:import-clip', projectId, clip),
    importFile: (projectId) => ipcRenderer.invoke('audio:import-file', projectId),
    listMusic: () => ipcRenderer.invoke('audio:music-list'),
    importMusic: (projectId, id) => ipcRenderer.invoke('audio:import-music', projectId, id),
    sweep: (projectId, keepFiles) => ipcRenderer.invoke('audio:sweep', projectId, keepFiles)
  },
  scenario: {
    start: (displayId) => ipcRenderer.invoke('scenario:start', displayId),
    stop: () => ipcRenderer.invoke('scenario:stop'),
    cancel: () => ipcRenderer.invoke('scenario:cancel'),
    getState: () => ipcRenderer.invoke('scenario:state'),
    onState: (cb) => subscribe('scenario:state', cb),
    onDone: (cb) => subscribe('scenario:done', cb),
    list: () => ipcRenderer.invoke('scenario:list'),
    load: (id) => ipcRenderer.invoke('scenario:load', id),
    save: (scenario) => ipcRenderer.invoke('scenario:save', scenario),
    remove: (id) => ipcRenderer.invoke('scenario:delete', id)
  },
  overlay: {
    onEffect: (cb) => subscribe('overlay:effect', cb),
    onReplayState: (cb) => subscribe('recording:replay-state', cb)
  },
  e2e: {
    openTarget: (bounds) => ipcRenderer.invoke('e2e:open-target', bounds),
    injectSteps: (steps) => ipcRenderer.invoke('e2e:inject-steps', steps)
  }
}

contextBridge.exposeInMainWorld('zc', api)
