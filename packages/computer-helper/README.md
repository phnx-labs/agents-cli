# computer-helper

macOS native helper that exposes Accessibility (AX) + ScreenCaptureKit + CoreGraphics
event injection over line-delimited JSON-RPC on stdio.

This is the backend for `agents computer` (mirror of `agents browser`).

## Permissions

The helper is default-deny. Every action method (`screenshot`, `click`, `type`,
`describe`, etc.) checks the target pid's bundle id against an allow list the
user controls via permission groups under `~/.agents/permissions/groups/`.

Allow a target by adding a `Computer(<bundle-id>)` rule to any group file's
`allow:` list. Example `~/.agents/permissions/groups/computer.yaml`:

```yaml
name: computer
description: Native macOS apps the computer-helper daemon may drive
allow:
  - "Computer(com.apple.mail)"
  - "Computer(com.apple.ical)"
  - "Computer(com.apple.notes)"
```

You can also mix `Computer(...)` patterns into any existing group file alongside
`Bash(...)`, `Read(...)`, etc.

After editing groups while the daemon is running, push the change to the helper:

```bash
agents computer reload
```

This rewrites `~/.agents/.cache/helpers/computer-policy.json` and sends `SIGHUP`
to the daemon, which re-reads the file. `agents computer start` does the same
write on every startup.

### Hard floor

Three bundle ids are denied unconditionally and cannot be added to the allow
list (the helper returns `target_excluded`):

- `com.apple.tccd`
- `com.apple.SecurityAgent`
- `com.apple.systempreferences`

These are TCC escalation paths. Driving them would let an agent silently
re-grant Accessibility, Screen Recording, or other privacy permissions. Every
other bundle id is your call — Terminal, iTerm, Keychain, the Rush app, etc.
are all user-controlled.

### Fail-safe

When the policy file is missing or unparseable the helper boots with an empty
allow list, which denies everything. Same behavior after a SIGHUP. There is no
"allow everything" default.

### Peer-auth

The socket lives under the user's home directory at mode 0600, so the kernel
already restricts which UIDs can connect. The helper adds one more layer on
top: it resolves every connecting caller's pid via `LOCAL_PEERPID` and its
exec path via `proc_pidpath`, and refuses anything whose exec path isn't in
`~/.agents/.cache/helpers/computer-peers.json` (`{"allow": [...]}`, mode 0600,
same fail-safe-empty semantics as `computer-policy.json`).

`agents computer start` and `agents computer reload` rewrite that file from
`loadDefaultPeers()`: the realpath of the running CLI's Node binary, plus
`/Applications/Rush.app/Contents/MacOS/{Rush,Electron}` if Rush is installed.
A malicious npm postinstall that runs `nc -U socket` is refused at accept()
— `/usr/bin/nc` is not on the list. The denial returns one structured
`peer_denied` frame so a legitimate-but-misconfigured client sees what's
wrong, then the connection closes.

## Build

```bash
./scripts/build.sh         # debug (single-arch)
./scripts/build.sh release # universal arm64 + x86_64
```

Outputs:

- `dist/computer-helper-mac` — bare binary
- `dist/ComputerHelper.app` — signed .app bundle (Developer ID if available, ad-hoc otherwise)

Bundle id: `com.phnx-labs.computer-helper`.

## Why a .app bundle, not just a binary

macOS TCC keys Accessibility / Screen Recording grants by the launching process's
bundle id + Team ID. A bare binary inherits TCC identity from whatever shell or
process launched it — which means a one-time System Settings grant evaporates the
next time a different parent process invokes the helper. The `.app` form gives
the helper a stable TCC identity that survives across launches.

## Protocol

Each line in: `{"id":N,"method":"...","params":{...}}`
Each line out: `{"id":N,"result":{...}}` or `{"id":N,"error":{"code":"...","message":"..."}}`

The full method list is defined in `Sources/ComputerHelper/RPC.swift`. The
helper terminates cleanly on stdin EOF.
