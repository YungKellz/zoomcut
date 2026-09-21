import { type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { spawnPowerShell, writeScript } from '../psHelper'

/**
 * System-audio capture through our own plain WASAPI loopback, bypassing Chromium entirely.
 *
 * Root cause (see CLAUDE.md): on at least one real machine, the default playback device's
 * shared mix format is 8 channels / 44100 Hz / 32-bit float (WAVE_FORMAT_EXTENSIBLE) and
 * Chromium's loopback implementation (`getDisplayMedia` audio, Electron's `audio: 'loopback'`)
 * rejects it with `NotReadableError`, even though plain `IAudioClient` loopback on the same
 * endpoint works fine. `LOOPBACK_SCRIPT` is a PowerShell/C# helper (same embedding pattern as
 * `scenario/inputHelper.ts`) that:
 *   1. Opens the default render endpoint and its shared-mode mix format
 *      (`IMMDeviceEnumerator` -> `IMMDevice.Activate(IAudioClient)` -> `GetMixFormat`).
 *   2. `Initialize`s it with `AUDCLNT_STREAMFLAGS_LOOPBACK` and starts an `IAudioCaptureClient`
 *      loop that writes every packet's raw bytes, exactly as delivered, to a file.
 *   3. Also opens a second, ordinary render `IAudioClient` on the same endpoint and keeps its
 *      `IAudioRenderClient` fed with silence: the shared audio engine (and therefore the
 *      loopback stream) stops delivering packets once nothing is rendering, so this keeps it
 *      alive even while the system is otherwise silent.
 *   4. As a safety net against any remaining gap (the engine glitching, a missed poll), tracks
 *      the capture stream's own device-position counter and fills any jump with zeros.
 */

export interface LoopbackFormat {
  /** WAVE_FORMAT_PCM (1) or WAVE_FORMAT_IEEE_FLOAT (3); resolved through the SubFormat GUID
   * when the mix format is WAVE_FORMAT_EXTENSIBLE, which it normally is. */
  tag: number
  channels: number
  rate: number
  bits: number
  isFloat: boolean
  /** dwChannelMask from WAVEFORMATEXTENSIBLE (0 when the mix format isn't extensible, or its
   * cbSize is too small to carry one - see the F line's parsing). Only meaningful together with
   * `channels`; a handful of well-known masks map to an explicit ffmpeg -channel_layout in
   * rawAudioInputArgs (src/main/media/ffmpeg.ts), otherwise it is left for ffmpeg to guess from
   * the channel count alone. */
  channelMask: number
}

// ---- loopback.ps1 ----
// Protocol (stdout, UTF-8, one line per event, always flushed):
//   argv: <outPath> <stopFile>
//   F <tag> <channels> <rate> <bits> <isFloat 0|1> <channelMask>   - printed once, right after Initialize
//   S <unixEpochMs>                                  - printed once, when the first frame is written
//   D <framesWritten>                                - printed once, on a clean stop; process then exits 0
//   E <message>                                      - printed on any failure; process exits 1
// The helper stops when `stopFile` appears (polled ~every 50ms) or stdin closes (parent died).
// Single-quoted here-string on purpose (no PowerShell $var/backtick expansion hazard inside the
// C# body below - a stray '$' or '`' in a future edit would otherwise be silently mangled before
// Add-Type ever sees it).
export const LOOPBACK_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
  int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
  int GetBufferSize(out uint numBufferFrames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint numPaddingFrames);
  int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
  int GetMixFormat(out IntPtr deviceFormat);
  int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr eventHandle);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
  int GetBuffer(out IntPtr data, out uint numFramesToRead, out int flags, out long devicePosition, out long qpcPosition);
  int ReleaseBuffer(uint numFramesRead);
  int GetNextPacketSize(out uint numFramesInNextPacket);
}

[ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioRenderClient {
  int GetBuffer(uint numFramesRequested, out IntPtr data);
  int ReleaseBuffer(uint numFramesWritten, int flags);
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
public struct WaveFormatEx {
  public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec; public uint nAvgBytesPerSec;
  public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
}

public static class ZcLoopback {
  const int CLSCTX_ALL = 23;
  const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
  const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
  const long BUFFER_DURATION_100NS = 10000000; // 1s - matches the diagnostic script this is built on
  static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
  static readonly Guid IID_IAudioRenderClient = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
  static readonly Guid SUBTYPE_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");

  // Written only from the stdin-watcher thread, read only from Run()'s main loop: volatile so
  // the loop is guaranteed to observe the write promptly instead of a JIT-cached stale read.
  static volatile bool StdinClosed;

  // HRESULT convention: the sign bit (bit 31) is the failure flag, so a signed int HRESULT is
  // a failure iff it is negative - a positive non-zero value is a "success with information"
  // code (e.g. AUDCLNT_S_BUFFER_EMPTY = 0x08890001) that must not be treated as an error.
  static void Check(int hr, string what) {
    if (hr < 0) throw new Exception(what + " failed 0x" + hr.ToString("X"));
  }

  static void WriteZeros(FileStream fs, long frames, int blockAlign) {
    if (frames <= 0) return;
    const int chunkFrames = 4096;
    byte[] zeros = new byte[chunkFrames * blockAlign];
    long remaining = frames;
    while (remaining > 0) {
      int n = (int)Math.Min(remaining, (long)chunkFrames);
      fs.Write(zeros, 0, n * blockAlign);
      remaining -= n;
    }
  }

  // No catch here on purpose: any COM/IO failure propagates out of Run() after the finally
  // below has still closed the file and stopped whatever was started, so the caller (the
  // PowerShell below) can print a single 'E <message>' regardless of which step failed.
  public static void Run(string outPath, string stopFile) {
    var stdout = Console.Out;
    IAudioClient captureClient = null;
    IAudioClient renderClient = null;
    IAudioRenderClient renderer = null;
    uint renderBufferFrames = 0;
    IntPtr fmtPtr = IntPtr.Zero;
    FileStream fs = null;
    StdinClosed = false;

    // A parent that dies without ever creating stopFile (killed, crashed) still has to be
    // noticed: ReadLine() on stdin returns null once the pipe closes.
    Thread stdinWatch = new Thread(() => {
      try { while (Console.In.ReadLine() != null) { } } catch { }
      StdinClosed = true;
    });
    stdinWatch.IsBackground = true;
    stdinWatch.Start();

    try {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice device;
      Check(enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out device), "GetDefaultAudioEndpoint");

      Guid iidClient1 = IID_IAudioClient;
      object captureObj;
      Check(device.Activate(ref iidClient1, CLSCTX_ALL, IntPtr.Zero, out captureObj), "Activate(capture)");
      captureClient = (IAudioClient)captureObj;

      Check(captureClient.GetMixFormat(out fmtPtr), "GetMixFormat");
      var fmt = (WaveFormatEx)Marshal.PtrToStructure(fmtPtr, typeof(WaveFormatEx));

      int tag = fmt.wFormatTag;
      uint channelMask = 0;
      if (tag == 0xFFFE && fmt.cbSize >= 22) {
        // WAVEFORMATEXTENSIBLE appends { WORD Samples; DWORD dwChannelMask; GUID SubFormat; }
        // right after the 18-byte WAVEFORMATEX - dwChannelMask at offset 18+2=20, the SubFormat
        // GUID at offset 20+4=24. cbSize >= 22 covers Samples+dwChannelMask; the GUID (16 more
        // bytes) is only actually present when cbSize is the full 22, which it always is
        // whenever the tag is WAVE_FORMAT_EXTENSIBLE at all - checked together defensively.
        channelMask = unchecked((uint)Marshal.ReadInt32(fmtPtr, 20));
        var subFormat = (Guid)Marshal.PtrToStructure(IntPtr.Add(fmtPtr, 24), typeof(Guid));
        tag = subFormat == SUBTYPE_FLOAT ? 3 : 1;
      }
      bool isFloat = tag == 3;

      Check(captureClient.Initialize(0 /*shared*/, AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER_DURATION_100NS, 0, fmtPtr, IntPtr.Zero), "Initialize(capture)");

      Guid iidCapture = IID_IAudioCaptureClient;
      object captureServiceObj;
      Check(captureClient.GetService(ref iidCapture, out captureServiceObj), "GetService(capture)");
      var capture = (IAudioCaptureClient)captureServiceObj;

      stdout.WriteLine("F " + tag + " " + fmt.nChannels + " " + fmt.nSamplesPerSec + " " + fmt.wBitsPerSample + " " + (isFloat ? 1 : 0) + " " + channelMask);
      stdout.Flush();

      // A second, ordinary render client on the same endpoint, kept fed with silence: the
      // shared engine (and with it the loopback stream) stops delivering packets once nothing
      // is actually rendering. AUDCLNT_BUFFERFLAGS_SILENT tells the engine to treat the buffer
      // as silence regardless of its contents, so there is no need to zero it by hand. This is
      // a continuity aid, not a requirement: its own setup failing must not abort the capture -
      // caught locally, leaving renderer null, and the loop below then just relies on the
      // position gap-fill to cover whatever silence this would otherwise have prevented.
      try {
        Guid iidClient2 = IID_IAudioClient;
        object renderObj;
        Check(device.Activate(ref iidClient2, CLSCTX_ALL, IntPtr.Zero, out renderObj), "Activate(render)");
        renderClient = (IAudioClient)renderObj;
        Check(renderClient.Initialize(0 /*shared*/, 0, BUFFER_DURATION_100NS, 0, fmtPtr, IntPtr.Zero), "Initialize(render)");
        Guid iidRender = IID_IAudioRenderClient;
        object rendererObj;
        Check(renderClient.GetService(ref iidRender, out rendererObj), "GetService(render)");
        renderer = (IAudioRenderClient)rendererObj;
        Check(renderClient.GetBufferSize(out renderBufferFrames), "GetBufferSize(render)");
        IntPtr primeData;
        Check(renderer.GetBuffer(renderBufferFrames, out primeData), "GetBuffer(render prime)");
        Check(renderer.ReleaseBuffer(renderBufferFrames, AUDCLNT_BUFFERFLAGS_SILENT), "ReleaseBuffer(render prime)");
      } catch {
        renderer = null;
      }

      int blockAlign = fmt.nBlockAlign;
      fs = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20);

      if (renderer != null) Check(renderClient.Start(), "Start(render)");
      Check(captureClient.Start(), "Start(capture)");

      long framesWritten = 0;
      long expectedPosition = -1;
      // A gap this large (suspend/resume, the engine stalling for a long time) is not a normal
      // capture glitch - filling it would write gigabytes of zeros. Re-anchor on the new
      // position without filling instead; anything smaller keeps getting silently patched.
      long maxGapFrames = (long)fmt.nSamplesPerSec * 5;
      bool firstFrame = false;
      bool stopRequested = false;
      DateTime lastStopCheck = DateTime.UtcNow;

      while (!stopRequested) {
        if (StdinClosed) break;
        if ((DateTime.UtcNow - lastStopCheck).TotalMilliseconds >= 50) {
          lastStopCheck = DateTime.UtcNow;
          if (File.Exists(stopFile)) break;
        }

        // Keep the render engine fed every tick, whether or not a capture packet is ready.
        if (renderer != null) {
          uint padding;
          if (renderClient.GetCurrentPadding(out padding) == 0) {
            uint available = renderBufferFrames > padding ? renderBufferFrames - padding : 0;
            if (available > 0) {
              IntPtr renderData;
              if (renderer.GetBuffer(available, out renderData) == 0) {
                renderer.ReleaseBuffer(available, AUDCLNT_BUFFERFLAGS_SILENT);
              }
            }
          }
        }

        uint nextPacket;
        Check(capture.GetNextPacketSize(out nextPacket), "GetNextPacketSize");
        if (nextPacket == 0) { Thread.Sleep(5); continue; }

        IntPtr data; uint numFrames; int flags; long devicePosition; long qpcPosition;
        Check(capture.GetBuffer(out data, out numFrames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
        // AUDCLNT_S_BUFFER_EMPTY (0x08890001, a success code) is a legitimate GetBuffer result:
        // nothing to do with this packet, but it still needs releasing.
        if (numFrames == 0) { capture.ReleaseBuffer(0); continue; }

        // Safety net: a discontinuity flag or a plain position jump both mean frames were
        // dropped between packets (e.g. the engine glitching) - fill the hole with silence so
        // downstream timing (durationMs = frames / rate) stays correct, unless it is implausibly
        // large (see maxGapFrames above).
        if (expectedPosition >= 0) {
          long gap = devicePosition - expectedPosition;
          if (gap > 0 && gap <= maxGapFrames) {
            WriteZeros(fs, gap, blockAlign);
            framesWritten += gap;
          }
        }

        if (!firstFrame) {
          firstFrame = true;
          stdout.WriteLine("S " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
          stdout.Flush();
        }

        bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        if (silent) {
          WriteZeros(fs, numFrames, blockAlign);
        } else {
          int byteCount = (int)numFrames * blockAlign;
          byte[] buffer = new byte[byteCount];
          Marshal.Copy(data, buffer, 0, byteCount);
          fs.Write(buffer, 0, byteCount);
        }
        framesWritten += numFrames;
        expectedPosition = devicePosition + numFrames;

        capture.ReleaseBuffer(numFrames);
      }

      try { captureClient.Stop(); } catch { }
      if (renderer != null) { try { renderClient.Stop(); } catch { } }
      fs.Flush(true);
      stdout.WriteLine("D " + framesWritten);
      stdout.Flush();
    } finally {
      if (fs != null) { try { fs.Dispose(); } catch { } }
      if (captureClient != null) { try { captureClient.Stop(); } catch { } }
      if (renderClient != null) { try { renderClient.Stop(); } catch { } }
      // GetMixFormat's returned WAVEFORMATEX* is CoTaskMemAlloc'd; the caller owns freeing it.
      if (fmtPtr != IntPtr.Zero) { try { Marshal.FreeCoTaskMem(fmtPtr); } catch { } }
    }
  }
}
'@

if ($args.Count -lt 2) {
  [Console]::Error.WriteLine('usage: loopback.ps1 <outPath> <stopFile>')
  exit 2
}
$outPath = $args[0]
$stopFile = $args[1]
$stdout = [Console]::Out

try {
  [ZcLoopback]::Run($outPath, $stopFile)
  exit 0
} catch {
  $stdout.WriteLine("E $($_.Exception.Message)")
  $stdout.Flush()
  exit 1
}
`

const PID = process.pid
function scriptName(): string {
  return `zoomcut-loopback-${PID}.ps1`
}
function stopFileName(): string {
  return `zoomcut-loopback-stop-${PID}.tmp`
}

function parseFormatLine(line: string): LoopbackFormat | null {
  const parts = line.split(' ')
  if (parts.length < 6) return null
  const tag = Number(parts[1])
  const channels = Number(parts[2])
  const rate = Number(parts[3])
  const bits = Number(parts[4])
  if (!Number.isFinite(tag) || !Number.isFinite(channels) || !Number.isFinite(rate) || !Number.isFinite(bits)) return null
  const maskRaw = parts.length >= 7 ? Number(parts[6]) : 0
  const channelMask = Number.isFinite(maskRaw) ? maskRaw : 0
  return { tag, channels, rate, bits, isFloat: parts[5] === '1', channelMask }
}

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (err: Error) => void
}

/**
 * One system-audio capture, driven by `LOOPBACK_SCRIPT`. `start()` spawns the helper and
 * resolves once it reports the endpoint's format; `startWall` becomes non-null once the first
 * frame is written (usually well before `stop()` is ever called - the countdown alone is
 * several seconds); `stop()` asks the helper to finish and reports how many frames it wrote.
 * One instance is good for exactly one start/stop cycle.
 */
export class LoopbackCapture {
  private proc: ChildProcess | null = null
  private scriptPath: string | null = null
  private stopFilePath: string | null = null
  private lineBuffer = ''
  private stderrTail = ''
  private _startWall: number | null = null
  private exited = false
  private pendingFormat: Waiter<LoopbackFormat> | null = null
  private pendingStop: Waiter<{ frames: number }> | null = null

  /** Wall-clock time (`Date.now()` domain) the first captured frame was written, or null until then. */
  get startWall(): number | null {
    return this._startWall
  }

  /** Spawns the helper and resolves once it reports the endpoint's format (`F` line), or
   * rejects if that does not happen within 8s or the process fails/exits first. */
  async start(outPath: string): Promise<LoopbackFormat> {
    if (this.proc) throw new Error('LoopbackCapture.start() called twice')
    this.scriptPath = await writeScript(scriptName(), LOOPBACK_SCRIPT)
    this.stopFilePath = join(app.getPath('temp'), stopFileName())
    // the script name (and so the stop-file name) is reused across separate recordings within
    // the same process run; a stop file left over from an earlier capture must not make a
    // brand new helper see "stop" on its very first poll
    await fsp.rm(this.stopFilePath, { force: true }).catch(() => undefined)

    const proc = spawnPowerShell(this.scriptPath, [outPath, this.stopFilePath])
    this.proc = proc
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-4000)
      console.error('[audio] loopback helper stderr:', text.trim())
    })
    proc.on('error', (err) => this.onExit(err))
    proc.on('close', (code) => this.onExit(null, code))

    return new Promise<LoopbackFormat>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingFormat) return
        this.pendingFormat = null
        reject(new Error('Loopback helper did not report a format within 8s'))
      }, 8000)
      this.pendingFormat = {
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      }
    })
  }

  /** Signals the helper to stop and waits for its `D` line (frame count), up to 2s, else kills it. */
  async stop(): Promise<{ frames: number }> {
    const proc = this.proc
    if (!proc || this.exited) return { frames: 0 }
    if (this.stopFilePath) {
      await fsp.writeFile(this.stopFilePath, '', 'utf8').catch(() => undefined)
    }
    return new Promise<{ frames: number }>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingStop) {
          this.pendingStop = null
          proc.kill('SIGKILL')
        }
        resolve({ frames: 0 })
      }, 2000)
      this.pendingStop = {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: () => {
          clearTimeout(timer)
          resolve({ frames: 0 })
        }
      }
    })
  }

  /** Kills the helper if it is still running and deletes its temp script/stop-file. Safe to call more than once. */
  async dispose(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (proc && !this.exited) proc.kill('SIGKILL')
    if (this.pendingFormat) {
      const p = this.pendingFormat
      this.pendingFormat = null
      p.reject(new Error('Loopback capture disposed'))
    }
    if (this.pendingStop) {
      const p = this.pendingStop
      this.pendingStop = null
      p.resolve({ frames: 0 })
    }
    const scriptPath = this.scriptPath
    const stopFilePath = this.stopFilePath
    this.scriptPath = null
    this.stopFilePath = null
    await Promise.all([
      scriptPath ? fsp.rm(scriptPath, { force: true }).catch(() => undefined) : Promise.resolve(),
      stopFilePath ? fsp.rm(stopFilePath, { force: true }).catch(() => undefined) : Promise.resolve()
    ])
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8')
    let idx: number
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, idx).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(idx + 1)
      if (line.length > 0) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith('F ')) {
      const parsed = parseFormatLine(line)
      if (parsed && this.pendingFormat) {
        const p = this.pendingFormat
        this.pendingFormat = null
        p.resolve(parsed)
      }
    } else if (line.startsWith('S ')) {
      const ms = Number(line.slice(2).trim())
      if (Number.isFinite(ms)) this._startWall = ms
    } else if (line.startsWith('D ')) {
      const frames = Number(line.slice(2).trim())
      if (this.pendingStop) {
        const p = this.pendingStop
        this.pendingStop = null
        p.resolve({ frames: Number.isFinite(frames) ? frames : 0 })
      }
    } else if (line.startsWith('E ')) {
      const message = line.slice(2).trim() || 'Loopback helper failed'
      if (this.pendingFormat) {
        const p = this.pendingFormat
        this.pendingFormat = null
        p.reject(new Error(message))
      } else if (this.pendingStop) {
        const p = this.pendingStop
        this.pendingStop = null
        p.reject(new Error(message))
      } else {
        console.error('[audio] loopback helper reported an error:', message)
      }
    }
  }

  private onExit(err: Error | null, code?: number | null): void {
    this.exited = true
    if (err) console.error('[audio] failed to spawn the loopback helper', err)
    const failure = err ?? new Error(`Loopback helper exited unexpectedly (code ${code ?? 'null'})${this.stderrTail ? `: ${this.stderrTail.slice(-500)}` : ''}`)
    if (this.pendingFormat) {
      const p = this.pendingFormat
      this.pendingFormat = null
      p.reject(failure)
    }
    if (this.pendingStop) {
      const p = this.pendingStop
      this.pendingStop = null
      // the process is gone either way - resolve rather than reject so a caller that only
      // cares "did we get audio" does not also have to catch stop()
      p.resolve({ frames: 0 })
    }
  }
}
