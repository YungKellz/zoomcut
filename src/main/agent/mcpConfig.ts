import { join } from 'node:path'
import type { AgentMcpConfig } from '@shared/agent'

export const BRIDGE_FILE = 'zoomcut-mcp.cjs'

export interface McpConfigInput {
  /** app.isPackaged */
  packaged: boolean
  /** the portable exe unpacks itself to a temp folder per run, so nothing under process.resourcesPath outlives it */
  portable: boolean
  /** process.execPath: ZoomCut.exe when packaged */
  execPath: string
  /** process.resourcesPath, where extraResources land */
  resourcesPath: string
  /** app.getAppPath(): the repo root in development */
  appPath: string
  userData: string
  /** the portable exe as the user launched it (electron-builder's PORTABLE_EXECUTABLE_FILE) */
  portableExe?: string
}

/** Where the built bridge is shipped: next to the exe once packaged, in out/ when running from source. */
export function bridgeSourcePath(i: Pick<McpConfigInput, 'packaged' | 'resourcesPath' | 'appPath'>): string {
  return i.packaged ? join(i.resourcesPath, 'mcp', BRIDGE_FILE) : join(i.appPath, 'out', 'mcp', BRIDGE_FILE)
}

/** The stable copy a portable run makes for MCP clients to point at. */
export function portableBridgePath(userData: string): string {
  return join(userData, 'mcp', BRIDGE_FILE)
}

/**
 * What the "AI agents (MCP)" dialog shows. Installed copies run the bridge under ZoomCut.exe
 * itself in Node mode (ELECTRON_RUN_AS_NODE), so no Node install is needed; a portable copy and a
 * source checkout use `node`. The portable config also passes the exe's real path so the bridge
 * can start ZoomCut when it is closed.
 */
export function buildMcpConfig(i: McpConfigInput): AgentMcpConfig {
  const runsInApp = i.packaged && !i.portable
  const bridge = i.portable ? portableBridgePath(i.userData) : bridgeSourcePath(i)
  const command = runsInApp ? i.execPath : 'node'
  const env: Record<string, string> = runsInApp ? { ELECTRON_RUN_AS_NODE: '1' } : i.portable && i.portableExe ? { ZOOMCUT_EXE: i.portableExe } : {}
  const server: { command: string; args: string[]; env?: Record<string, string> } = { command, args: [bridge] }
  if (Object.keys(env).length > 0) server.env = env
  const envFlags = Object.entries(env)
    .map(([k, v]) => `--env "${k}=${v}" `)
    .join('')
  return {
    command,
    bridge,
    portable: i.portable,
    json: JSON.stringify({ mcpServers: { zoomcut: server } }, null, 2),
    claudeCode: `claude mcp add --transport stdio ${envFlags}zoomcut -- ${quote(command)} ${quote(bridge)}`
  }
}

function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg}"` : arg
}
