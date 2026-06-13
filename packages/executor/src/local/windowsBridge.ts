/**
 * WindowsBridge — NativeBridge implementation for Windows with ZERO native npm
 * modules. Spawns one persistent PowerShell daemon (System.Drawing capture +
 * user32 SendInput-family P/Invoke for input) and speaks JSON-lines over
 * stdio. The script is passed via -EncodedCommand to avoid quoting pitfalls.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type {
  CaptureResult,
  MouseButton,
  NativeBridge,
  ScreenRegion,
  ScrollDirection,
} from './bridge';

/** The PowerShell daemon. Reads {id,op,args} JSON lines; writes {id,ok,data,error}. */
const DAEMON_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OCNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[void][OCNative]::SetProcessDPIAware()

$VK = @{
  'enter'=0x0D;'return'=0x0D;'tab'=0x09;'esc'=0x1B;'escape'=0x1B;'space'=0x20;
  'backspace'=0x08;'delete'=0x2E;'del'=0x2E;'insert'=0x2D;
  'up'=0x26;'down'=0x28;'left'=0x25;'right'=0x27;
  'home'=0x24;'end'=0x23;'pageup'=0x21;'pagedown'=0x22;
  'ctrl'=0x11;'control'=0x11;'alt'=0x12;'shift'=0x10;'win'=0x5B;'cmd'=0x5B;'meta'=0x5B;
  'capslock'=0x14;'printscreen'=0x2C
}
function Get-VK([string]$name) {
  $n = $name.ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return $VK[$n] }
  if ($n -match '^f([0-9]{1,2})$') { return 0x6F + [int]$Matches[1] }
  if ($n.Length -eq 1) {
    $c = [char]$n.ToUpperInvariant()
    if ($c -ge '0' -and $c -le '9') { return [int]$c }
    if ($c -ge 'A' -and $c -le 'Z') { return [int]$c }
  }
  throw "unknown key: $name"
}
function Press-VK([int]$vk) {
  [OCNative]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 15
  [OCNative]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 15
}
function Mouse-Button-Flags([string]$button) {
  switch ($button) {
    'right'  { return @(0x0008, 0x0010) }
    'middle' { return @(0x0020, 0x0040) }
    default  { return @(0x0002, 0x0004) }
  }
}
function Escape-SendKeys([string]$text) {
  # NOTE: no PowerShell backtick escapes in this file — backticks would
  # terminate the surrounding JS template literal. Use [int] char codes.
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 10) { [void]$sb.Append('{ENTER}') }
    elseif ($code -eq 13) { }
    elseif ($code -eq 9) { [void]$sb.Append('{TAB}') }
    elseif ('+^%~(){}[]'.Contains([string]$ch)) { [void]$sb.Append('{' + $ch + '}') }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $resp = @{ id = $req.id; ok = $true; data = $null; error = $null }
  try {
    switch ($req.op) {
      'capture' {
        # Capture the requested region (a specific monitor) when given, else the
        # primary screen. Region coordinates are virtual-desktop physical pixels.
        if ($null -ne $req.args.width -and $null -ne $req.args.height) {
          $rx = [int]$req.args.x; $ry = [int]$req.args.y
          $rw = [int]$req.args.width; $rh = [int]$req.args.height
        } else {
          $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $rx = $b.X; $ry = $b.Y; $rw = $b.Width; $rh = $b.Height
        }
        $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        $resp.data = @{ base64 = [Convert]::ToBase64String($ms.ToArray()); width = $rw; height = $rh }
        $ms.Dispose()
      }
      'screenSize' {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $resp.data = @{ width = $bounds.Width; height = $bounds.Height }
      }
      'click' {
        [void][OCNative]::SetCursorPos([int]$req.args.x, [int]$req.args.y)
        Start-Sleep -Milliseconds 30
        $flags = Mouse-Button-Flags $req.args.button
        for ($i = 0; $i -lt [int]$req.args.clicks; $i++) {
          [OCNative]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 20
          [OCNative]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 60
        }
      }
      'move' {
        [void][OCNative]::SetCursorPos([int]$req.args.x, [int]$req.args.y)
      }
      'drag' {
        $flags = Mouse-Button-Flags $req.args.button
        [void][OCNative]::SetCursorPos([int]$req.args.fromX, [int]$req.args.fromY)
        Start-Sleep -Milliseconds 50
        [OCNative]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
        $steps = 12
        for ($i = 1; $i -le $steps; $i++) {
          $nx = [int]($req.args.fromX + ($req.args.toX - $req.args.fromX) * $i / $steps)
          $ny = [int]($req.args.fromY + ($req.args.toY - $req.args.fromY) * $i / $steps)
          [void][OCNative]::SetCursorPos($nx, $ny)
          Start-Sleep -Milliseconds 20
        }
        [OCNative]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
      }
      'type' {
        [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $req.args.text))
      }
      'keyPress' {
        foreach ($k in $req.args.keys) { Press-VK (Get-VK $k) }
      }
      'keyCombo' {
        $mods = @(); $mains = @()
        foreach ($k in $req.args.keys) {
          $n = $k.ToLowerInvariant()
          if (@('ctrl','control','alt','shift','win','cmd','meta') -contains $n) { $mods += (Get-VK $n) }
          else { $mains += (Get-VK $n) }
        }
        foreach ($m in $mods) { [OCNative]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) }
        Start-Sleep -Milliseconds 25
        foreach ($k in $mains) { Press-VK $k }
        [array]::Reverse($mods)
        foreach ($m in $mods) { [OCNative]::keybd_event([byte]$m, 0, 2, [UIntPtr]::Zero) }
      }
      'scroll' {
        if ($null -ne $req.args.x -and $null -ne $req.args.y) {
          [void][OCNative]::SetCursorPos([int]$req.args.x, [int]$req.args.y)
        }
        $amount = [int]$req.args.amount
        switch ($req.args.direction) {
          'up'    { [OCNative]::mouse_event(0x0800, 0, 0, (120 * $amount), [UIntPtr]::Zero) }
          'down'  { [OCNative]::mouse_event(0x0800, 0, 0, (-120 * $amount), [UIntPtr]::Zero) }
          'left'  { [OCNative]::mouse_event(0x01000, 0, 0, (-120 * $amount), [UIntPtr]::Zero) }
          'right' { [OCNative]::mouse_event(0x01000, 0, 0, (120 * $amount), [UIntPtr]::Zero) }
        }
      }
      'ping' { $resp.data = 'pong' }
      default { throw "unknown op: $($req.op)" }
    }
  } catch {
    $resp.ok = $false
    $resp.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 5))
}
`;

interface DaemonResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string | null;
}

export interface WindowsBridgeOptions {
  /** Per-call timeout. Capture can be slow on first call. Default 30s. */
  callTimeoutMs?: number;
  /** Injectable for tests: alternate spawn (e.g. a fake daemon). */
  spawnImpl?: typeof spawn;
  powershellPath?: string;
  /** Target monitor (physical px). When set, capture + input target it; else primary. */
  region?: ScreenRegion;
}

export class WindowsBridge implements NativeBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private stdoutBuffer = '';
  private readonly callTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly powershellPath: string;
  private readonly region?: ScreenRegion;

  constructor(opts: WindowsBridgeOptions = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.powershellPath = opts.powershellPath ?? 'powershell.exe';
    this.region = opts.region;
  }

  /** Virtual-desktop origin of the target region (0,0 for the primary screen). */
  private get ox(): number {
    return this.region?.x ?? 0;
  }
  private get oy(): number {
    return this.region?.y ?? 0;
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const encoded = Buffer.from(DAEMON_SCRIPT, 'utf16le').toString('base64');
    const proc = this.spawnImpl(
      this.powershellPath,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.on('exit', () => {
      // A disposed daemon may exit after a replacement was already spawned —
      // only clean up if WE are still the active process.
      if (this.proc !== proc) return;
      const err = new Error('PowerShell bridge process exited');
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.proc = null;
    });
    this.proc = proc;
    if (proc.pid === undefined) {
      await once(proc, 'spawn');
    }
    return proc;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf('\n');
      if (nl === -1) return;
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line.startsWith('{')) continue; // skip PS noise
      let msg: DaemonResponse;
      try {
        msg = JSON.parse(line) as DaemonResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(`Native bridge op failed: ${msg.error ?? 'unknown'}`));
    }
  }

  private async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const proc = await this.ensureStarted();
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, op, args })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native bridge op '${op}' timed out after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async capture(): Promise<CaptureResult> {
    return this.call<CaptureResult>('capture', this.region ? { ...this.region } : {});
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    // The model's coordinates live in the captured region's space.
    if (this.region) return { width: this.region.width, height: this.region.height };
    return this.call<{ width: number; height: number }>('screenSize');
  }

  async click(x: number, y: number, button: MouseButton, clicks: number): Promise<void> {
    await this.call('click', { x: x + this.ox, y: y + this.oy, button, clicks });
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.call('move', { x: x + this.ox, y: y + this.oy });
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: MouseButton,
  ): Promise<void> {
    await this.call('drag', {
      fromX: fromX + this.ox,
      fromY: fromY + this.oy,
      toX: toX + this.ox,
      toY: toY + this.oy,
      button,
    });
  }

  async typeText(text: string): Promise<void> {
    await this.call('type', { text });
  }

  async keyPress(keys: string[]): Promise<void> {
    await this.call('keyPress', { keys });
  }

  async keyCombo(keys: string[]): Promise<void> {
    await this.call('keyCombo', { keys });
  }

  async scroll(direction: ScrollDirection, amount: number, x?: number, y?: number): Promise<void> {
    await this.call('scroll', {
      direction,
      amount,
      x: x === undefined ? undefined : x + this.ox,
      y: y === undefined ? undefined : y + this.oy,
    });
  }

  /** Round-trip health check. */
  async ping(): Promise<boolean> {
    return (await this.call<string>('ping')) === 'pong';
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      proc.stdin.end();
      proc.kill();
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Bridge disposed'));
    }
    this.pending.clear();
  }
}
