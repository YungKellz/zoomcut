import { AGENT_CONTROL_FLAG } from '@shared/agent'

/** `--agent-control` is on the command line. */
export function hasAgentControlFlag(argv: readonly string[]): boolean {
  return argv.includes(AGENT_CONTROL_FLAG)
}

/**
 * Agent control only runs when asked for: the flag, or ZOOMCUT_AGENT_CONTROL=1 in the environment
 * of a first launch. A second launch cannot hand its environment to the running copy (Electron only
 * passes the command line on), so there the flag is the way to switch a running copy on.
 */
export function agentControlRequested(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  // `set X=1 && ZoomCut.exe` in cmd leaves a trailing space in the value
  return hasAgentControlFlag(argv) || env['ZOOMCUT_AGENT_CONTROL']?.trim() === '1'
}

/**
 * What the running copy does when another copy was started and handed over its command line. A
 * launch that only switches agent control on (what the MCP bridge does when it finds ZoomCut closed or
 * without control) must not bring the window up: it would land in a recording that is running and in
 * the way of a replay. Any other launch shows the window (restores it from the taskbar, brings it to
 * the front), unless it is hidden on purpose: `windowHidden` is true while a recording's bar is up or a
 * scenario is captured or replayed, not while a finished recording is still being saved.
 */
export function secondInstanceAction(argv: readonly string[], windowHidden: boolean): { enableAgentControl: boolean; showWindow: boolean } {
  const enableAgentControl = hasAgentControlFlag(argv)
  return { enableAgentControl, showWindow: !enableAgentControl && !windowHidden }
}
