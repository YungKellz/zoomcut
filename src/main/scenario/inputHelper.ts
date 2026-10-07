import { type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { spawnPowerShell, writeScript } from '../psHelper'

/**
 * The two PowerShell helpers used by the scenario recorder, written to disk once per launch
 * and spawned with `-File` (Windows PowerShell 5.1 does not run a script piped into
 * `-Command -`). Both are self-contained: UTF-8 console encoding, autoflushed output,
 * explicit exit codes, and a `try/finally` that always releases whatever they pressed.
 */

// ---- keytext.ps1 ----
// Long-running text resolver used while capturing: for every non-modifier keydown, capture.ts
// sends `K <n> <scan> <shift> <ctrl> <alt> <altgr>` on stdin and gets back `T <n> <vk> <text>`
// (base64 UTF-8, or "-" when the key is not text) so grouping can tell a keystroke's real
// character apart from a shortcut, independent of physical keyboard layout.
export const KEYTEXT_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ZcKeyText {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint uCode, uint uMapType, IntPtr dwhkl);
  // CharSet.Unicode is required: the default (Ansi) marshals the StringBuilder as a single-byte
  // buffer, so every resolved character silently loses its high byte (e.g. Cyrillic U+0444 'ф'
  // comes back as 0x44 'D') - and the 8-WCHAR capacity told to a 1-byte-per-char buffer is also
  // a real overrun. Verified live: Ansi gave "D"/"$" for scan 30 on a ru-RU layout, Unicode
  // gives the real "ф"/"Ф".
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ToUnicodeEx(uint wVirtKey, uint wScanCode, byte[] lpKeyState, StringBuilder pwszBuff, int cchBuff, uint wFlags, IntPtr dwhkl);
  [DllImport("user32.dll")] static extern short GetKeyState(int nVirtKey);

  const uint MAPVK_VSC_TO_VK_EX = 3;
  const int VK_SHIFT = 0x10;
  const int VK_CONTROL = 0x11;
  const int VK_MENU = 0x12;
  const int VK_CAPITAL = 0x14;
  const int VK_NUMLOCK = 0x90;

  public static uint LastVk;
  public static string LastText;

  // Resolves one keystroke to the character it would produce with the current keyboard
  // layout, without disturbing the real kernel key state (wFlags = 4 in ToUnicodeEx).
  public static void Resolve(uint scan, bool shift, bool ctrl, bool alt, bool altgr) {
    IntPtr fg = GetForegroundWindow();
    uint pid;
    uint threadId = fg == IntPtr.Zero ? (uint)0 : GetWindowThreadProcessId(fg, out pid);
    IntPtr hkl = GetKeyboardLayout(threadId);
    uint vk = MapVirtualKeyEx(scan, MAPVK_VSC_TO_VK_EX, hkl);
    LastVk = vk;

    if ((ctrl || alt) && !altgr) { LastText = null; return; }

    byte[] state = new byte[256];
    if (shift) state[VK_SHIFT] = 0x80;
    if (altgr) { state[VK_CONTROL] = 0x80; state[VK_MENU] = 0x80; }
    // GetKeyState reads the last message-loop-observed toggle state; this process never pumps
    // a message loop, so on some systems this can be stale (set once at process start and never
    // updated). Good enough for a per-keystroke best effort - it is not relied on for anything
    // safety-critical.
    if ((GetKeyState(VK_CAPITAL) & 1) != 0) state[VK_CAPITAL] = 1;
    if ((GetKeyState(VK_NUMLOCK) & 1) != 0) state[VK_NUMLOCK] = 1;

    StringBuilder sb = new StringBuilder(8);
    int rc = ToUnicodeEx(vk, scan, state, sb, sb.Capacity, 4, hkl);
    if (rc <= 0) { LastText = null; return; }
    string s = sb.ToString(0, rc);
    if (s.Length == 0 || s[0] < 0x20) { LastText = null; return; }
    LastText = s;
  }
}
"@

$stdout = [Console]::Out
$stdin = [Console]::In

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  if ($parts.Length -lt 7 -or $parts[0] -ne 'K') { continue }
  $n = $parts[1]
  try {
    $scan = [uint32]$parts[2]
    $shift = $parts[3] -eq '1'
    $ctrl = $parts[4] -eq '1'
    $alt = $parts[5] -eq '1'
    $altgr = $parts[6] -eq '1'
    [ZcKeyText]::Resolve($scan, $shift, $ctrl, $alt, $altgr)
    $vk = [ZcKeyText]::LastVk
    $text = [ZcKeyText]::LastText
    if ($null -eq $text) {
      $stdout.WriteLine("T $n $vk -")
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
      $b64 = [Convert]::ToBase64String($bytes)
      $stdout.WriteLine("T $n $vk $b64")
    }
  } catch {
    $stdout.WriteLine("T $n 0 -")
  }
  $stdout.Flush()
}
exit 0
`

// ---- replay.ps1 ----
// Replays a compiled step schedule (physical pixels) against the real desktop. Blocks on
// stdin for `PRE <x> <y>` (pre-position the cursor during the countdown) then `GO <epochMs>`,
// runs the schedule on a Stopwatch anchored to that epoch, and checks the abort file before
// every step so an abort lands within a couple of milliseconds. The schedule's last step is
// `end` (after the final pause); once it is reached the script prints `D`, or `A` after an abort.
//
// Releasing is NOT unconditional: an up event for something that is not down is not harmless
// (a button-up with no button-down reaches the window under the cursor as a real click - a
// right-button-up opens a context menu, which used to show up at the end of every replay - and a
// lone Alt-up activates a menu bar). So the C# side remembers every key and mouse button THIS
// process pressed, and the normal `finally` below releases exactly those (ReleasePressed).
// `-Release` alone (a fresh, separate invocation, used after a hard kill of a previous instance)
// cannot know what the dead process pressed; it asks Windows which modifier keys and mouse
// buttons are down right now and releases only those (ReleaseHeld).
export const REPLAY_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

[StructLayout(LayoutKind.Sequential)]
struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)]
struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
[StructLayout(LayoutKind.Explicit)]
struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
[StructLayout(LayoutKind.Sequential)]
struct INPUT { public uint type; public InputUnion u; }

public static class ZcReplay {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint uPeriod);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint uPeriod);

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static Stopwatch sw;

  public static void Init() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    try { timeBeginPeriod(1); } catch { }
    sw = Stopwatch.StartNew();
  }
  public static void Shutdown() {
    try { timeEndPeriod(1); } catch { }
  }
  public static double ElapsedMs() { return sw.Elapsed.TotalMilliseconds; }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  static void SendOne(INPUT input) {
    INPUT[] inputs = new INPUT[1];
    inputs[0] = input;
    SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  static void SendMouseFlag(uint flag, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dx = 0;
    input.u.mi.dy = 0;
    input.u.mi.mouseData = unchecked((uint)data);
    input.u.mi.dwFlags = flag;
    input.u.mi.time = 0;
    input.u.mi.dwExtraInfo = IntPtr.Zero;
    SendOne(input);
  }

  // What THIS process has pressed and not released yet, so ReleasePressed() can let go of
  // exactly that and nothing else (see the note at the top of this script for why an up event
  // for something that is not down must never be sent).
  struct HeldKey { public int Vk; public int Scan; public bool Extended; }
  static List<HeldKey> heldKeys = new List<HeldKey>();
  static bool leftDown;
  static bool rightDown;
  static bool middleDown;

  static void MarkButton(string button, bool down) {
    if (button == "right") rightDown = down;
    else if (button == "middle") middleDown = down;
    else leftDown = down;
  }
  public static void ButtonDown(string button) {
    SendMouseFlag(button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN, 0);
    MarkButton(button, true);
  }
  public static void ButtonUp(string button) {
    SendMouseFlag(button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP, 0);
    MarkButton(button, false);
  }
  public static void Wheel(int dy, int dx) {
    if (dy != 0) SendMouseFlag(MOUSEEVENTF_WHEEL, dy);
    if (dx != 0) SendMouseFlag(MOUSEEVENTF_HWHEEL, dx);
  }

  static void SendKey(int vk, int scan, bool extended, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = (ushort)vk;
    input.u.ki.wScan = (ushort)scan;
    uint flags = 0;
    if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
    if (up) flags |= KEYEVENTF_KEYUP;
    input.u.ki.dwFlags = flags;
    input.u.ki.time = 0;
    input.u.ki.dwExtraInfo = IntPtr.Zero;
    SendOne(input);
  }
  static int FindHeld(int vk, int scan, bool extended) {
    for (int i = heldKeys.Count - 1; i >= 0; i--) {
      HeldKey k = heldKeys[i];
      if (k.Vk == vk && k.Scan == scan && k.Extended == extended) return i;
    }
    return -1;
  }
  public static void KeyDown(int vk, int scan, bool extended) {
    SendKey(vk, scan, extended, false);
    if (FindHeld(vk, scan, extended) < 0) heldKeys.Add(new HeldKey { Vk = vk, Scan = scan, Extended = extended });
  }
  public static void KeyUp(int vk, int scan, bool extended) {
    SendKey(vk, scan, extended, true);
    int i = FindHeld(vk, scan, extended);
    if (i >= 0) heldKeys.RemoveAt(i);
  }

  static INPUT MakeUnicodeInput(char c, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = 0;
    input.u.ki.wScan = c;
    input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    input.u.ki.time = 0;
    input.u.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }
  static void SendUnicodeChar(char c, bool up) {
    SendOne(MakeUnicodeInput(c, up));
  }
  // A surrogate pair is one grapheme's worth of two UTF-16 units; sending both KEYDOWNs in one
  // SendInput call (then both KEYUPs in a second) keeps them atomic from the receiving app's
  // point of view, instead of interleaving down/up/down/up which some apps can misread as two
  // separate characters.
  static void SendUnicodePair(char c1, char c2, bool up) {
    INPUT[] inputs = new INPUT[2];
    inputs[0] = MakeUnicodeInput(c1, up);
    inputs[1] = MakeUnicodeInput(c2, up);
    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void TypeUnicode(string text) {
    int i = 0;
    while (i < text.Length) {
      char c1 = text[i];
      if (char.IsHighSurrogate(c1) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) {
        char c2 = text[i + 1];
        SendUnicodePair(c1, c2, false);
        SendUnicodePair(c1, c2, true);
        i += 2;
      } else {
        SendUnicodeChar(c1, false);
        SendUnicodeChar(c1, true);
        i += 1;
      }
    }
  }

  // Lets go of exactly what THIS process still holds: keys newest first, then buttons. It
  // sends nothing for a key or button that is already up, so it is safe to call any number of
  // times - a second call (or a run that finished cleanly) is a no-op.
  public static void ReleasePressed() {
    for (int i = heldKeys.Count - 1; i >= 0; i--) {
      HeldKey k = heldKeys[i];
      SendKey(k.Vk, k.Scan, k.Extended, true);
    }
    heldKeys.Clear();
    if (leftDown) ButtonUp("left");
    if (rightDown) ButtonUp("right");
    if (middleDown) ButtonUp("middle");
  }

  static bool IsDown(int vk) {
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
  }

  // For a fresh process after a hard kill: it cannot know what the dead one pressed, so it asks
  // Windows which modifier keys (either side) and mouse buttons are down right now and releases
  // only those. Never an up event for something that is up.
  public static void ReleaseHeld() {
    if (IsDown(0xA0)) KeyUp(0xA0, 42, false);  // VK_LSHIFT
    if (IsDown(0xA1)) KeyUp(0xA1, 54, false);  // VK_RSHIFT
    if (IsDown(0xA2)) KeyUp(0xA2, 29, false);  // VK_LCONTROL
    if (IsDown(0xA3)) KeyUp(0xA3, 29, true);   // VK_RCONTROL
    if (IsDown(0xA4)) KeyUp(0xA4, 56, false);  // VK_LMENU
    if (IsDown(0xA5)) KeyUp(0xA5, 56, true);   // VK_RMENU
    if (IsDown(0x5B)) KeyUp(0x5B, 91, true);   // VK_LWIN
    if (IsDown(0x5C)) KeyUp(0x5C, 92, true);   // VK_RWIN
    if (IsDown(0x01)) ButtonUp("left");        // VK_LBUTTON
    if (IsDown(0x02)) ButtonUp("right");       // VK_RBUTTON
    if (IsDown(0x04)) ButtonUp("middle");      // VK_MBUTTON
  }
}
"@

# The normal exit path (done, aborted, failed): lets go of exactly what this process pressed.
function Release-Pressed {
  try { [ZcReplay]::ReleasePressed() } catch { }
}
# -Release, after a hard kill: lets go of whatever modifier or button Windows reports as down.
function Release-Held {
  try { [ZcReplay]::ReleaseHeld() } catch { }
}

if ($args.Count -ge 1 -and $args[0] -eq '-Release') {
  Release-Held
  exit 0
}

if ($args.Count -lt 2) {
  [Console]::Error.WriteLine('usage: replay.ps1 <stepsJson> <abortFile>')
  exit 2
}
$stepsPath = $args[0]
$abortPath = $args[1]

$stdout = [Console]::Out
$stdin = [Console]::In

try {
  $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $stepsPath
  $parsed = ConvertFrom-Json -InputObject $raw
  if ($null -eq $parsed) { $steps = @() } else { $steps = @($parsed) }
} catch {
  $stdout.WriteLine("E failed to read steps: $($_.Exception.Message)")
  $stdout.Flush()
  exit 1
}

[ZcReplay]::Init()
try {
  $stdout.WriteLine('R')
  $stdout.Flush()

  $epoch = 0.0
  $gotGo = $false
  while (-not $gotGo) {
    $cmd = $stdin.ReadLine()
    if ($null -eq $cmd) { exit 1 }
    $cmd = $cmd.Trim()
    if ($cmd.StartsWith('PRE ')) {
      $p = $cmd.Split(' ')
      [ZcReplay]::Move([int][double]$p[1], [int][double]$p[2])
      continue
    }
    if ($cmd.StartsWith('GO ')) {
      $epoch = [double]($cmd.Split(' ')[1])
      $gotGo = $true
    }
  }

  # ElapsedMs() measures from Init(), which runs long before this point (spawn + the recording
  # countdown can easily be several seconds) - not from GO. Capturing how much had already
  # elapsed when GO arrived and folding it into every target lets ElapsedMs() comparisons work
  # correctly without restarting (and so re-zeroing) the Stopwatch mid-run.
  $goWallMs = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $goElapsed = [ZcReplay]::ElapsedMs()
  $offset = $epoch - $goWallMs
  $aborted = $false
  $lastAbortCheck = $goElapsed

  foreach ($step in $steps) {
    $targetElapsed = [double]$step.t + $offset + $goElapsed
    while ($true) {
      $now = [ZcReplay]::ElapsedMs()
      $remain = $targetElapsed - $now
      if ($remain -le 0) { break }
      if ($remain -gt 2) {
        # Test-Path is a real filesystem stat call - only worth paying for a few times a
        # second, and never inside the final sub-2ms spin, which needs to stay a pure clock
        # check for accurate timing.
        if (($now - $lastAbortCheck) -ge 20) {
          $lastAbortCheck = $now
          if (Test-Path -LiteralPath $abortPath) { $aborted = $true; break }
        }
        Start-Sleep -Milliseconds 1
      }
    }
    if ($aborted) { break }

    switch ($step.op) {
      'move' { [ZcReplay]::Move([int][double]$step.x, [int][double]$step.y) }
      'down' { [ZcReplay]::ButtonDown([string]$step.button) }
      'up' { [ZcReplay]::ButtonUp([string]$step.button) }
      'wheel' { [ZcReplay]::Wheel([int]$step.dy, [int]$step.dx) }
      'key' {
        if ($step.down) { [ZcReplay]::KeyDown([int]$step.vk, [int]$step.scan, [bool]$step.extended) }
        else { [ZcReplay]::KeyUp([int]$step.vk, [int]$step.scan, [bool]$step.extended) }
      }
      'text' { [ZcReplay]::TypeUnicode([string]$step.text) }
      'action' {
        $stdout.WriteLine("P $($step.index)")
        $stdout.Flush()
      }
      # the closing step: reaching it (after the final pause) is all it is for
      'end' { }
      default { }
    }
  }

  if (-not $aborted -and (Test-Path -LiteralPath $abortPath)) { $aborted = $true }

  if ($aborted) { $stdout.WriteLine('A') } else { $stdout.WriteLine('D') }
  $stdout.Flush()
} catch {
  $stdout.WriteLine("E $($_.Exception.Message)")
  $stdout.Flush()
} finally {
  Release-Pressed
  [ZcReplay]::Shutdown()
}
exit 0
`

// Stamped with this process's pid so releaseAllInputs() (which rewrites the file before every
// call, including from a hard-kill path) can never race with a *different* app instance that
// is concurrently starting a helper from the same file name.
const PID = process.pid
function keytextScriptName(): string {
  return `zoomcut-keytext-${PID}.ps1`
}
function replayScriptName(): string {
  return `zoomcut-replay-${PID}.ps1`
}

/** Starts the long-running text resolver used while capturing. */
export async function startKeytextHelper(): Promise<ChildProcess> {
  const path = await writeScript(keytextScriptName(), KEYTEXT_SCRIPT)
  return spawnPowerShell(path)
}

/** Starts a replay of `stepsPath` that watches `abortPath` for an early stop. */
export async function startReplayHelper(stepsPath: string, abortPath: string): Promise<ChildProcess> {
  const path = await writeScript(replayScriptName(), REPLAY_SCRIPT)
  return spawnPowerShell(path, [stepsPath, abortPath])
}

/**
 * Release pass for after a hard kill (or a crash / timeout) of a replay helper: a fresh
 * `replay.ps1 -Release` that lets go of the modifier keys and mouse buttons Windows reports as
 * held right now. It cannot know what the dead helper pressed, so it looks - and sends nothing
 * for keys and buttons that are up, because a stray up event is not harmless (a lone
 * right-button-up opens a context menu). Resolves once that process has exited.
 */
export async function releaseAllInputs(): Promise<void> {
  const path = await writeScript(replayScriptName(), REPLAY_SCRIPT)
  const proc = spawnPowerShell(path, ['-Release'])
  await new Promise<void>((resolve) => {
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

/** Deletes this process's helper scripts from temp; called on app quit. */
export async function cleanupHelperScripts(): Promise<void> {
  const temp = app.getPath('temp')
  await fsp.rm(join(temp, keytextScriptName()), { force: true }).catch(() => undefined)
  await fsp.rm(join(temp, replayScriptName()), { force: true }).catch(() => undefined)
}
