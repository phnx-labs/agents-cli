# Browser, computer, and terminal interfaces

These interfaces let agents act on real UI surfaces while keeping ownership in the CLI.

## Browser

The browser daemon owns profiles, tasks, CDP connections, recordings, and cleanup. A task
binds later actions to one profile/device. Identity-bearing profile names route to their
declaring device; they never fall back to a local logged-out browser. Fleet-remote control
is off by default and enforced in the daemon for attach as well as launch.

The reaper closes only tabs owned by abandoned tasks. It never closes user-created tabs
or the shared browser window. Captures stay on disk; session linkage stores metadata.

## Computer

The CLI talks to a signed native helper. The helper enforces platform permissions, an
application allowlist, and executable peer authentication. It is not an always-on broad
desktop daemon. Focus/frontmost checks are part of correctness, not a presentation detail.

## Terminal

Interactive backends are pure command builders over one transport and layout policy.
They open attended surfaces; autonomous/cloud execution belongs to the execution engine.
