# computer-helper-win

Windows backend for `agents computer` — C#/.NET 10 daemon, sibling of the Swift
[`native/computer-mac`](../computer-mac). Same JSON-RPC wire protocol, same result
shapes; one TS client (`apps/cli/src/lib/computer-rpc.ts`) drives both.

This file is a **map**. Read the code (and [README.md](README.md)) for current detail.

## Layout

```
Program.cs      Entry point (top-level statements) — TCP listener, auth, RPC loop
Rpc.cs          Method dispatch table (19 methods)
Automation.cs   UI Automation tree walk + SendInput (click/type/key/scroll/drag) + window focus
Screenshot.cs   Graphics.CopyFromScreen over the virtual screen
Apps.cs         Process/window enumeration; launch_app via PATH + App Paths registry
ElementCache.cs @eN element handle cache
smoke/smoke.mjs Smoke test (Unicode-typing regression loops for #554/#581)
computer-helper-win.csproj   net10.0-windows, WPF + WinForms enabled
```

## Build

```bash
bash ../../apps/cli/scripts/build-win.sh   # dotnet publish -r win-x64 --self-contained -p:PublishSingleFile
```

Output: `dist/computer-helper-win.exe` (gitignored; staged into the npm tarball at
release). Needs the **.NET 10 SDK**; cross-publishes from macOS/Linux
(`EnableWindowsTargeting`).

## How the CLI reaches it

`apps/cli/src/lib/ssh-tunnel.ts` — `resolveWinHelperExe()` looks for
`native/computer-win/dist/computer-helper-win.exe` (dev checkout, 4 hops up from
`apps/cli/dist/lib`) or the bundled npm copy. `setupRemoteHelper()` scp's the exe
to `%LOCALAPPDATA%\agents\`, registers a Task Scheduler task
(`AgentsComputerHelper`, `-AtLogOn`, interactive), and starts it. The CLI connects
over an `ssh -L` tunnel to the daemon's loopback TCP port (`8765`).

## Key differences from computer-mac (don't assume mac semantics)

- **Transport is loopback TCP + SSH tunnel**, not a Unix socket. The tunnel is the
  sole ingress; an optional `--token-file` shared secret is defense-in-depth.
- **No TCC / no permission model.** Windows UIA needs no per-process grant —
  `trust_status` always returns `trusted=true`. There is no allow-list,
  `computer-policy.json`, or peer-auth file. Access control = the SSH tunnel.
- **Lifecycle is Task Scheduler, not launchd** — it must run in the interactive
  desktop session (not Session 0) for UIA + screen capture to work.
- **Single-file needs native-lib self-extraction** (`IncludeNativeLibrariesForSelfExtract`)
  or UIA throws on the first tree walk (#519).
- **`bundle_id` = process image name** (`notepad`), not reverse-DNS.
- **`notify` is pass-through only** — no Windows Toast; Rush intercepts the return.
