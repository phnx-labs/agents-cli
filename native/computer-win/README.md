# computer-helper-win

Windows native helper that exposes UI Automation (UIA) + screen capture +
`SendInput` event injection over line-delimited JSON-RPC on a loopback TCP port.

This is the Windows backend for `agents computer` — the C#/.NET counterpart of the
Swift [`native/computer-mac`](../computer-mac) helper. Both speak the **identical**
wire protocol and return the identical result shapes, so one TypeScript client
(`apps/cli/src/lib/computer-rpc.ts`) drives either platform.

## Transport: loopback TCP + SSH tunnel

Unlike the macOS helper (which listens on a local Unix domain socket), the Windows
helper binds **loopback TCP only** (`IPAddress.Loopback`, default port `8765`) and
is never exposed to the network. The agents CLI reaches a remote Windows box over
an `ssh -L` tunnel, so authentication piggybacks on SSH keys. An optional
shared-secret token (`--token-file`, checked as the first RPC frame) is
defense-in-depth on top of that; in practice the CLI currently runs the daemon
token-less and relies on the SSH tunnel as the sole ingress.

```
CLI (mac/linux)  ──ssh -L 8765:127.0.0.1:8765──▶  computer-helper-win.exe (Windows, loopback)
```

## No TCC — no permission dialog

Windows UI Automation needs **no per-process trust grant** (unlike macOS
Accessibility/TCC). `trust_status` always reports `trusted=true`. There is no
allow-list of targets, no `computer-policy.json`, and no peer-auth file — the
macOS deny-by-default permission model has no Windows equivalent. Access control
here is entirely the SSH tunnel (plus the optional token).

## Lifecycle: Task Scheduler, not self-managed

The CLI installs the helper as a **scheduled task** (`AgentsComputerHelper`) with
an `-AtLogOn` trigger running `-LogonType Interactive -RunLevel Highest`. Task
Scheduler owns the process — it survives SSH disconnects and runs inside the live
interactive desktop session, which UI Automation and `Graphics.CopyFromScreen`
both require (they do not work from the non-interactive Session 0). `setupRemoteHelper`
in `apps/cli/src/lib/ssh-tunnel.ts` handles the whole flow: stop any running
instance, `scp` the exe to `%LOCALAPPDATA%\agents\`, verify the byte count, then
`Register-ScheduledTask` + `Start-ScheduledTask`.

## Build

```bash
bash ../../apps/cli/scripts/build-win.sh
```

Under the hood (needs the **.NET 10 SDK**):

```bash
dotnet publish computer-helper-win.csproj -c Release -r win-x64 \
  --self-contained true -p:PublishSingleFile=true -o dist
```

Output: `dist/computer-helper-win.exe` — a self-contained, single-file exe.
`EnableWindowsTargeting` lets it **cross-publish from a macOS/Linux build host**.
The exe is not committed (`dist/` is gitignored) and does not ship in the npm
tarball (~157MB). On `v*` tags the `release-exe` job in
[`computer-helper-win.yml`](../../.github/workflows/computer-helper-win.yml)
uploads it plus a `.sha256` as GitHub release assets, and `agents computer
setup --host` downloads the asset matching the running CLI version
(checksum-verified, cached under `~/.agents/.cache/computer/win-helper/`)
when no local build exists.

### Why single-file needs native-lib self-extraction

WPF/UIAutomation resolves its client through COM/native libraries
(`PresentationNative`, `wpfgfx`, `UIAutomationCore`) that the single-file host does
**not** map from memory — they must exist as real files on disk for
`LoadLibrary`/`CoCreateInstance`. So the csproj sets
`IncludeNativeLibrariesForSelfExtract=true`, extracting them to disk at startup.
Without it, the shipped exe throws on the first UIA tree walk (describe / get-text
/ focus / ax-action) even though a loose-DLL framework-dependent build works. (#519)

## Protocol

Newline-delimited JSON-RPC over the TCP stream — byte-identical to the macOS helper.

```
in : {"id":N,"method":"...","params":{...}}
out: {"id":N,"result":{...}}  |  {"id":N,"error":{"code":"...","message":"..."}}
```

19 methods, dispatched in `Rpc.cs`: `ping`, `trust_status`, `list_apps`,
`launch_app`, `screenshot`, `describe`, `click`, `type`, `type_text`, `key`,
`set_focus`, `get_text`, `scroll`, `drag`, `right_click`, `focus_window`,
`ax_action`, `wait`, `notify`. Element IDs (`@eN`) and the `element_stale` error
match the mac helper exactly.

## Layout

| File | Role |
|---|---|
| `Program.cs` | Entry point (top-level statements); TCP listener, auth handshake, RPC framing loop |
| `Rpc.cs` | Method dispatch table |
| `Automation.cs` | UI Automation tree walk, `SendInput` click/type/key/scroll/drag, window focus |
| `Screenshot.cs` | pid-scoped `Graphics.CopyFromScreen` capture: window list / window / display (`window_id` = HWND) |
| `Apps.cs` | Process/window enumeration; `launch_app` via PATH + App Paths registry |
| `ElementCache.cs` | `@eN` element handle cache |
| `smoke/smoke.mjs` | Smoke test (incl. Unicode-typing regression loops for #554/#581) |
| `computer-helper-win.csproj` | .NET 10 project (`net10.0-windows`, WPF + WinForms) |

## Non-obvious gotchas

- **Unicode typing is per-character.** Consecutive `KEYEVENTF_UNICODE` events
  sharing `VK_PACKET` could coalesce in a busy receiver's message queue (#554/#581).
  The fix issues one atomic `SendInput` per character with a 5ms settle
  (`TypeSettleMs`). The smoke test guards this.
- **`bundle_id` is the process image name** (`notepad`, `msedge`), not an
  Apple-style reverse-DNS id — Windows has no bundle IDs. `launch_app` resolves
  targets via PATH + the App Paths registry.
- **`notify` is pass-through only** — there is no Windows Toast call; the Rush
  computer-manager intercepts the return value (mirrors `Notify.swift`).
- **`background=true` is rejected** (`action_unsupported`) on `click`/`drag`
  physical paths — macOS postToPid delivery has no Win32 analogue; `SendInput`
  is global. UIA-pattern element clicks are already focus-safe.
- **`require_frontmost` is a hard gate** for `type_text`/`key`: `SendInput`
  lands in the *focused* window, so a non-foreground target pid raises
  `not_frontmost`; without the flag the result carries `frontmost` for the
  CLI-side warning (mirrors `Events.swift`).
