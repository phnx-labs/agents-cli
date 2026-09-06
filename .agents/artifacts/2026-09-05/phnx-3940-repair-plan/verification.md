# Independent plan verification

This is a synthesis, not a fabricated transcript or an implementation review.

One independent Claude verifier, teammate **blind-plan**, ran read-only on a light Linux fleet worker against commit `83dc2a8133e41241938a81155bb368a8dcd04f5a`. It received the problem, baseline, source map and official vendor references, but not the author's proposed architecture or artifacts. It finished in 5.3 minutes with 58 tool calls and reported no file or credential changes. Its output ended `BLIND_PLAN_COMPLETE`. A second provider could not pass its authentication smoke check and contributed no verdict; this is not a two-verifier consensus.

## Agreed / adopted

- Preserve already-landed installation IDs, update policy, transactions, cooperative cancellation and account-first view. Reuse the existing launch path.
- Preserve every native home path. Binding/default metadata is authoritative; ambiguous duplicate homes must not be merged by email or newest version name.
- Fix the concrete health gap first: `daemon/harness-update-service.ts:220–224` converts failure into a returned result, while `daemon/service.ts:175` treats a non-throwing tick as successful. This is a source finding, not proof of the historical worker daemon's root cause.
- Replace substring activity matching (`installations/active-check.ts:84`) with process/path-aware attribution while retaining fail-closed behavior.
- Guard current removal paths: `installations/versions.ts:1702` says the whole directory, including home and transcripts, moves. Release-cache cleanup must never call this whole-installation removal blindly.
- Audit ambiguous update selectors (`commands/update.ts:241`) and keep label-first compatibility. Do not silently reinterpret a legacy alias as an exact release pin.
- Document that existing update switches are fleet-synced; do not silently introduce a second per-device toggle.

All abbreviated source paths above are under `cli/src/lib/`, except `commands/*`, which are under `cli/src/`.

## Significant differences and decisions

| Blind proposal | Final decision | Reason |
|---|---|---|
| Keep per-installation packages; report spare homes | Useful first diagnostic step, not the end state | It still downloads/updates multiple packages for three accounts. The user's explicit goal is shared executable management. `ExecOptions.version/configVersion` already separates execution from home selection (`exec.ts:282–284`); extend that seam rather than invent another executor. |
| Last successful pass = newest non-error installation timestamp | Do not use that derivation | A partial pass may update one record and then fail; an all-deferred pass proves no update completed. Persist the pass outcome through existing daemon health, with per-release results, and retain the previous success on failure/cancellation. This is one health owner, not a competing scheduler. |
| Enforce native/worker credential role only inside adapters | Move the existing policy to final environment finalization | `exec.ts:633–635` overlays `options.env` after adapter work. An adapter-only check is bypassable. Keep provider capability logic in adapters, but apply the canonical decision after all overlays and remove duplicated runner patches. |
| Codex workers always use independent native login | Default for Pro and interactive surfaces; allow verified eligible workspace automation | Official workspace access-token docs support trusted non-interactive use with qualifying workspace permission. Do not overclaim a universal token or reject a documented eligible mode. |
| Add a force escape hatch to remove a bound home | Not part of release retention | The user asked about redundant binaries, not deleting sessions, credentials or account bindings. Preview exact package-only targets; unknown ownership and live references block removal. |
| Cap installation history now | Defer | It is not necessary to fix account/version coupling and would remove provenance without a demonstrated requirement. |

## Additional author gates

- A per-harness lock owns immutable release publication, launch leases and retention. Native config projection and account discovery enumerate homes, not release directories.
- Older installed CLIs cannot magically honor a new fence. Prove all executable entrypoints are upgraded or reliably blocked before activation; otherwise leave the migration prepared, not active. No approval-free legacy-install removal.
- Publishing a binary does not prove cross-version native-home write compatibility. Validate provider behavior; if incompatible or unknown, defer only that busy home's next launch. Never mutate/migrate its native data to make it work.
- Role checks include inherited API keys and provider-routing overrides, not just the portable token. An explicit conflict fails; no silent billing fallback.
- A separate non-author review identified vendor-loaded settings as another bypass: Claude settings may inject a token or credential helper after process-env finalization. Adopt effective user/project/managed settings and CLI-input checks, preserve the files, and reject conflicts or unknown precedence. Add real config-origin credential regressions and prove a vendor-supported enforcement boundary, including config read-after-check races. An environment-only guard is insufficient.
- Per-account credential revisions need authority, acknowledgments and revocation semantics. An existing bundle is not evidence that it contains the current revision.

The original teammate logs were retained locally when the completed team was disbanded with `--keep-logs`. Only this redacted synthesis is committed.
