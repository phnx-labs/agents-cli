# Tasks — restore live Claude usage bars on a personal device

Ordered, each names the file(s) it edits. Drainable by `/code:loop` or `agents teams`.

- [ ] **1. Add the capability flag to the option types.**
      `cli/src/lib/accounting/usage.ts` — add `allowInteractiveLogin?: boolean` to
      `UsageOptions` (:387) and `UsageLookupOptions` (:409). Default undefined
      (setup-token-only), documented inline as personal-device-foreground-only.

- [ ] **2. Forward the flag through `getClaudeUsageInfo` into `loadClaudeOauth`.**
      `cli/src/lib/accounting/usage.ts` — at :1202/:1209 pass
      `allowInteractiveLogin: options?.allowInteractiveLogin` alongside the existing
      `accessTokenCache: true, fileOnly` opts.

- [ ] **3. Restore the gated interactive fall-through in `loadClaudeOauth`.**
      `cli/src/lib/accounting/usage.ts:1984` — in the `accessTokenCache === true` branch,
      when the setup-token lookup returns null AND `allowInteractiveLogin === true`,
      fall through to the existing keychain / `.credentials.json` read (:2023-2044)
      instead of `return null` (:2013). Falsy flag → unchanged `return null`
      (RUSH-1822 guarantee). Keep `claudeUsageAccessTokenNoRefresh` — no token refresh
      on a read.

- [ ] **4. Gate the flag at the `agents view` call sites only, on foreground TTY.**
      `cli/src/commands/view.ts` — compute once:
      `const allowInteractiveLogin = selfConfiguredDeviceRole() === 'personal' && !options.json && process.stdout.isTTY;`
      Pass it into `getUsageInfoByIdentity`/`getUsageInfoForIdentity` at :545, :1116,
      :1453. The `!json && isTTY` clause stops a scripted `view --json --refresh` on a
      personal box from silently acquiring the interactive credential. Leave
      `usage-refresh.ts`, `auth-health.ts`, watchdog, `collectRunCandidates`
      untouched → default-closed everywhere else.

- [ ] **5. Confirm `--refresh` reaches the live read.**
      `cli/src/commands/view.ts:1816/1944` — verify `--refresh`/`--live` → `forceRefresh`
      already threads to `getUsageInfoForIdentity` (`usage.ts:647-686`). The
      personal + forceRefresh path is what exercises the interactive read. No change
      expected; assert with a trace if the wiring is indirect.

- [ ] **6. Read-path tests (real path, no mocked fetch).**
      `cli/src/lib/accounting/usage.test.ts`:
      - Keep `:157` (RUSH-1822: no setup-token → `null`, never reads login) — now
        scoped to **background** mode.
      - **Split `:681`** ("the probe never reads it"): background mode still expects
        `unavailable`; ADD an **interactive-personal** case where a present interactive
        login IS read and returns live windows (injected keychain backend via
        `isKeychainBackendOverridden`).
      - ADD worker/undefined-role rejection: a foreground read off a non-personal
        device still refuses the login.
      - ADD expired-OAuth: usage read returns `expired-credential`, no refresh.
      - Keep `:433` (cache freshness) and `:806` (renderer) unchanged — neither is the
        blessing test.
      Also add `cli/src/commands/view.account.test.ts`: plain TTY `view claude` on
      personal requests the interactive-personal fetch (S+W restored); `--json` /
      non-TTY / worker do not.

- [ ] **7. Stop the test cache pollution.**
      `cli/src/lib/accounting/usage.test.ts:1724` — point the `claude:org=sess-vs-cred`
      write at a temp cache dir (the hazard `usage-backoff.ts:60-70` documents), so it
      no longer lands in the developer's real `~/.agents/.cache/claude-usage.json`.

- [ ] **8. Docs in lockstep.**
      `cli/docs/secrets.md:35-46` — correct the "no credential populates a live Claude
      usage bar / a state nothing changes" claim for a personal device.
      `cli/docs/specifications.md` — add the role-gated usage-read rule near EXEC-2a.
      `cli/CHANGELOG` (or the CLI's changelog surface) — user-visible entry under next version.

- [ ] **9. Verify end to end on zion.**
      `cd cli && scripts/install.sh --skip-tests` → `agents-dev view claude --refresh`
      → every signed-in account shows live S + W. Capture before/after for the PR.
      Confirm a worker (`agents-dev view claude --device mark-1`) still resolves
      setup-token/cache only. Run `bun run test src/lib/accounting/usage.test.ts` green.
      Confirm `claude:org=sess-vs-cred` gone from a fresh cache after the suite.

- [ ] **10. Land.** Linked worktree + PR with before/after screenshot; link RUSH-2392;
      note #2987 was symptom-wording. Non-author review (prix-cloud, or a
      `code-reviewer` subagent while #1767 paused) + green CI → rebase-merge.
