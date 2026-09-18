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
    prepare: (displayId) => ipcRenderer.invoke('recording:prepare', displayId),
    started: (id, meta) => ipcRenderer.invoke('recording:started', id, meta),
    chunk: (id, data) => ipcRenderer.invoke('recording:chunk', id, data),
    finish: (id) => ipcRenderer.invoke('recording:finish', id),
    cancel: (id) => ipcRenderer.invoke('recording:cancel', id),
    onStopRequested: (cb) => subscribe('recorder:stop', cb),
    onCancelRequested: (cb) => subscribe('recorder:cancel', cb),
    onProgress: (cb) => subscribe('recording:progress', cb)
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
    finish: (exportId, settings, meta) => ipcRenderer.invoke('export:finish', exportId, settings, meta),
    cancel: (exportId) => ipcRenderer.invoke('export:cancel', exportId),
    onProgress: (cb) => subscribe('export:progress', cb)
  }
}

contextBridge.exposeInMainWorld('zc', api)
