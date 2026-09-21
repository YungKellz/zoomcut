import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Shared plumbing for the PowerShell/C# helpers spawned by the main process (scenario capture's
 * key-text resolver and replay in `scenario/inputHelper.ts`, the system-audio loopback capture
 * in `audio/loopback.ts`): write a self-contained script to a temp file once, then spawn it with
 * `-File` (Windows PowerShell 5.1 does not run a script piped into `-Command -`).
 */

/** Writes a helper script to `app.getPath('temp')` and returns its full path. */
export async function writeScript(fileName: string, contents: string): Promise<string> {
  const path = join(app.getPath('temp'), fileName)
  await fsp.writeFile(path, contents, 'utf8')
  return path
}

/** Spawns `powershell.exe -File <scriptPath> ...args` with piped stdio and a hidden window. */
export function spawnPowerShell(scriptPath: string, args: string[] = []): ChildProcess {
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  proc.stdin?.on('error', () => undefined)
  // Without a listener, an 'error' event (e.g. ENOENT if powershell.exe were ever missing) is
  // an uncaught exception in Node and takes down the whole main process.
  proc.on('error', (err) => console.error(`[psHelper] failed to spawn powershell.exe for ${scriptPath}`, err))
  return proc
}
