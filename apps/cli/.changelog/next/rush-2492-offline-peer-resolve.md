- **`agents sessions focus`/`attach`/`resume` (and `run --resume`) no longer hard-fail
  when a fleet device is offline.** Resolving a session id used to abort the moment any
  registered device was unreachable — even when the session lived on a box that WAS
  reachable — printing `Could not resolve session while these devices were unavailable`.
  Now an unreachable peer is a one-line warning: the session resolves against the
  reachable fleet and attaches, and the command fails only when the id is found on no
  reachable device (worded so the offline, unchecked peers are named, not blamed).
  (RUSH-2492)
