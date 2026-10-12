/**
 * ZoomCut's MCP server over stdio: a thin bridge between an MCP client (Claude Code, Claude
 * Desktop, Cursor, ...) and the running ZoomCut app, which listens on a loopback port published in
 * its userData folder (see src/main/agent). Built into a single file (mcp.vite.config.ts) that runs
 * with plain `node` or under ZoomCut.exe itself with ELECTRON_RUN_AS_NODE=1.
 *
 * stdout carries the protocol and nothing else: every log line goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { discoveryPath, launcherFor, resolveExe, ZoomCutClient } from './rpc'
import { registerTools, SERVER_INSTRUCTIONS } from './tools'

// injected by mcp.vite.config.ts; absent when this file runs unbundled (tests)
declare const __ZOOMCUT_VERSION__: string | undefined
const VERSION = typeof __ZOOMCUT_VERSION__ === 'string' ? __ZOOMCUT_VERSION__ : '0.0.0'

function log(message: string): void {
  process.stderr.write(`[zoomcut-mcp] ${message}\n`)
}

async function main(): Promise<void> {
  // a stray console.log from a dependency must not corrupt the protocol stream
  console.log = (...args: unknown[]) => log(args.map(String).join(' '))

  const exe = { env: process.env, execPath: process.execPath, electronVersion: process.versions['electron'] }
  const client = new ZoomCutClient({
    discoveryPath: discoveryPath(),
    launch: launcherFor({ ...exe, log }),
    exeProblem: resolveExe(exe).problem,
    log
  })
  const server = new McpServer({ name: 'zoomcut', version: VERSION }, { instructions: SERVER_INSTRUCTIONS })
  registerTools(server, client)
  await server.connect(new StdioServerTransport())
  log(`ready (v${VERSION}), looking for ZoomCut in ${discoveryPath()}`)
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
