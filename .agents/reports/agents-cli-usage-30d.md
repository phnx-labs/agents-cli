# agents-cli usage — last 30 days

Generated: 2026-08-03T21:37:24.698378+00:00
Window: last 30 days

Hostnames and personal paths in this report are pseudonymized (`host-desk`, `worker-s0`, `build-mac`, …).

Hosts mined: worker-s0, worker-s1, build-mac, host-desk, fleet-relay, worker-m0, worker-m1

## Method

1. **events** — `~/.agents/events.jsonl*` `command.start` on each host (agent callers filtered separately).
2. **sessions** — `agents sessions --since 30d --all --teams --json`, then stream each `filePath` JSONL for Bash/Shell tool calls invoking `agents`/`ag`.
Events alone miss some agent shells; sessions alone miss hooks/scripts. Both are reported.

## Volume

- Total invocations recorded: **473484**
- source `events`: 446900
- source `session`: 26584

## Top commands (all sources)

| rank | command | count |
| --- | --- | ---: |
| 1 | `view` | 153765 |
| 2 | `sessions` | 143254 |
| 3 | `routines list` | 27732 |
| 4 | `watchdog` | 23561 |
| 5 | `devices list` | 20174 |
| 6 | `ssh` | 19815 |
| 7 | `watchdog status` | 18775 |
| 8 | `doctor` | 11157 |
| 9 | `browser evaluate` | 4958 |
| 10 | `run` | 4251 |
| 11 | `secrets export` | 3552 |
| 12 | `models` | 2589 |
| 13 | `browser screenshot` | 2127 |
| 14 | `(root)` | 1902 |
| 15 | `browser navigate` | 1753 |
| 16 | `secrets exec` | 1508 |
| 17 | `browser refs` | 1473 |
| 18 | `browser press` | 1348 |
| 19 | `secrets list` | 1305 |
| 20 | `ssh build-mac` | 1155 |
| 21 | `secrets _agent-load` | 1025 |
| 22 | `ssh host-desk` | 1015 |
| 23 | `ssh worker-s0` | 903 |
| 24 | `sync` | 889 |
| 25 | `browser click` | 819 |
| 26 | `browser start` | 760 |
| 27 | `computer screenshot` | 692 |
| 28 | `feed` | 633 |
| 29 | `inspect` | 521 |
| 30 | `teams status` | 462 |
| 31 | `secrets status` | 414 |
| 32 | `browser done` | 391 |
| 33 | `browser type` | 385 |
| 34 | `ssh worker-s1` | 345 |
| 35 | `browser wait` | 331 |
| 36 | `ssh build-win` | 324 |
| 37 | `devices` | 292 |
| 38 | `browser tab add` | 286 |
| 39 | `feed post` | 275 |
| 40 | `routines runs` | 272 |

## Top commands (sessions only — Bash/Shell in transcripts)

Most reliable view of what agents typed. Independent of `events.jsonl` attribution.

| rank | command | count |
| --- | --- | ---: |
| 1 | `(root)` | 1902 |
| 2 | `sessions` | 1478 |
| 3 | `browser evaluate` | 1297 |
| 4 | `ssh build-mac` | 1155 |
| 5 | `browser screenshot` | 1107 |
| 6 | `ssh host-desk` | 1015 |
| 7 | `ssh worker-s0` | 903 |
| 8 | `browser navigate` | 753 |
| 9 | `browser refs` | 748 |
| 10 | `secrets list` | 689 |
| 11 | `ssh` | 527 |
| 12 | `computer screenshot` | 433 |
| 13 | `browser start` | 395 |
| 14 | `ssh worker-s1` | 345 |
| 15 | `ssh build-win` | 324 |
| 16 | `run` | 303 |
| 17 | `routines list` | 258 |
| 18 | `browser` | 256 |
| 19 | `run claude` | 250 |
| 20 | `browser click` | 243 |
| 21 | `browser done` | 228 |
| 22 | `browser tab add` | 199 |
| 23 | `secrets exec cloud-provider.com` | 188 |
| 24 | `devices` | 162 |
| 25 | `browser profiles list` | 160 |
| 26 | `run codex` | 158 |
| 27 | `ssh worker-m0` | 145 |
| 28 | `secrets` | 130 |
| 29 | `browser status` | 125 |
| 30 | `browser wait` | 110 |
| 31 | `computer describe` | 110 |
| 32 | `hosts ps` | 109 |
| 33 | `devices list` | 102 |
| 34 | `browser scroll` | 100 |
| 35 | `feed post` | 98 |
| 36 | `secrets status` | 97 |
| 37 | `view` | 96 |
| 38 | `browser type` | 88 |
| 39 | `ssh worker-m1` | 87 |
| 40 | `routines` | 83 |

## Top commands (events, agent callers only)

`command.start` where `caller` is a harness (`claude-code`, `cursor`, …). Hooks/`script` excluded.

| rank | command | count |
| --- | --- | ---: |
| 1 | `devices list` | 13660 |
| 2 | `ssh` | 9718 |
| 3 | `sessions` | 4783 |
| 4 | `browser evaluate` | 3434 |
| 5 | `secrets export` | 2242 |
| 6 | `models` | 1701 |
| 7 | `run` | 1421 |
| 8 | `browser press` | 1285 |
| 9 | `secrets _agent-load` | 951 |
| 10 | `browser navigate` | 923 |
| 11 | `browser screenshot` | 869 |
| 12 | `secrets exec` | 742 |
| 13 | `watchdog` | 739 |
| 14 | `browser refs` | 609 |
| 15 | `browser click` | 526 |
| 16 | `sync` | 422 |
| 17 | `teams status` | 378 |
| 18 | `inspect` | 371 |
| 19 | `secrets list` | 353 |
| 20 | `secrets status` | 308 |
| 21 | `browser start` | 267 |
| 22 | `browser type` | 267 |
| 23 | `routines list` | 238 |
| 24 | `view` | 232 |
| 25 | `routines logs` | 214 |
| 26 | `doctor` | 200 |
| 27 | `browser wait` | 199 |
| 28 | `computer screenshot` | 175 |
| 29 | `secrets view` | 154 |
| 30 | `feed post` | 134 |
| 31 | `browser done` | 132 |
| 32 | `teams add` | 129 |
| 33 | `share` | 127 |
| 34 | `events` | 120 |
| 35 | `hosts ps` | 107 |
| 36 | `routines runs` | 95 |
| 37 | `pty write` | 93 |
| 38 | `devices` | 82 |
| 39 | `watchdog status` | 67 |
| 40 | `browser profiles list` | 59 |

## Top commands (agent-attributed union)

Agent event callers plus every session Bash hit.

| rank | command | count |
| --- | --- | ---: |
| 1 | `devices list` | 13762 |
| 2 | `ssh` | 10245 |
| 3 | `sessions` | 6261 |
| 4 | `browser evaluate` | 4731 |
| 5 | `secrets export` | 2274 |
| 6 | `browser screenshot` | 1976 |
| 7 | `(root)` | 1902 |
| 8 | `run` | 1724 |
| 9 | `models` | 1704 |
| 10 | `browser navigate` | 1676 |
| 11 | `browser refs` | 1357 |
| 12 | `browser press` | 1290 |
| 13 | `ssh build-mac` | 1155 |
| 14 | `secrets list` | 1042 |
| 15 | `ssh host-desk` | 1015 |
| 16 | `secrets _agent-load` | 955 |
| 17 | `ssh worker-s0` | 903 |
| 18 | `browser click` | 769 |
| 19 | `secrets exec` | 768 |
| 20 | `watchdog` | 749 |
| 21 | `browser start` | 662 |
| 22 | `computer screenshot` | 608 |
| 23 | `routines list` | 496 |
| 24 | `sync` | 480 |
| 25 | `secrets status` | 405 |
| 26 | `teams status` | 396 |
| 27 | `inspect` | 372 |
| 28 | `browser done` | 360 |
| 29 | `browser type` | 355 |
| 30 | `ssh worker-s1` | 345 |
| 31 | `view` | 328 |
| 32 | `ssh build-win` | 324 |
| 33 | `browser wait` | 309 |
| 34 | `browser tab add` | 258 |
| 35 | `browser` | 256 |
| 36 | `doctor` | 251 |
| 37 | `run claude` | 250 |
| 38 | `devices` | 244 |
| 39 | `feed post` | 232 |
| 40 | `browser profiles list` | 219 |

## Purpose buckets

- **diagnostics / inventory**: 165585
- **live session polling**: 101692
- **other**: 50667
- **machine-readable session query**: 31895
- **cron / scheduled agents**: 29242
- **remote fleet shell**: 23950
- **fleet device inventory**: 20781
- **browser automation**: 17184
- **credential inject / list**: 10304
- **read / recall transcript**: 7755
- **dispatch agent run**: 4891
- **browse / search sessions**: 2899
- **multi-agent teams**: 1862
- **native desktop automation**: 1506
- **config / history sync**: 1482
- **notifications / feed**: 971
- **help / discovery**: 473
- **observability**: 345

## By host

- `host-desk`: 228582
- `worker-s1`: 128960
- `worker-s0`: 50765
- `worker-m1`: 41414
- `worker-m0`: 23423
- `build-mac`: 340

## By caller

- `script`: 394957
- `claude-code`: 50150
- `claude`: 26985
- `terminal`: 954
- `shell`: 260
- `cursor`: 80
- `agent`: 60
- `grok`: 18
- `codex`: 18
- `opencode`: 2

## Flag flavors (top session commands)

### `(root)`

- `(no flags)` — 1109× — other
- `--version` — 145× — other
- `--version -1` — 110× — other
- `--help -iE` — 72× — help / discovery
- `-1` — 21× — other
- `--version -3` — 20× — other
- `-20` — 19× — other
- `-3` — 18× — other

### `sessions`

- `--active --json` — 35823× — live session polling
- `--active --json --host` — 30870× — live session polling
- `--active --local --json` — 18964× — live session polling
- `--all --limit --json` — 18779× — machine-readable session query
- `--active --json --local` — 14857× — live session polling
- `--json --limit --host` — 4002× — machine-readable session query
- `--json --include --local` — 2676× — read / recall transcript
- `--include --all --limit --json --no-interactive --device` — 1762× — read / recall transcript

### `browser evaluate`

- `--expression` — 3295× — browser automation
- `-e` — 454× — browser automation
- `--task -e` — 239× — browser automation
- `-f` — 153× — browser automation
- `--file` — 141× — browser automation
- `--task --expression` — 109× — browser automation
- `--expression -1` — 70× — browser automation
- `--expression -2` — 29× — browser automation

### `ssh build-mac`

- `(no flags)` — 490× — remote fleet shell
- `-v` — 27× — remote fleet shell
- `-e` — 26× — remote fleet shell
- `-f` — 26× — remote fleet shell
- `-d` — 23× — remote fleet shell
- `-1` — 18× — remote fleet shell
- `-la` — 17× — remote fleet shell
- `-c` — 16× — remote fleet shell

### `browser screenshot`

- `(no flags)` — 404× — browser automation
- `-o -1` — 258× — browser automation
- `--output` — 199× — browser automation
- `-o` — 171× — browser automation
- `--task` — 150× — browser automation
- `--output -1` — 102× — browser automation
- `-q` — 78× — browser automation
- `--task --output` — 55× — browser automation

### `ssh host-desk`

- `(no flags)` — 427× — remote fleet shell
- `-3` — 35× — remote fleet shell
- `-1` — 21× — remote fleet shell
- `-2` — 19× — remote fleet shell
- `-v` — 17× — remote fleet shell
- `-la` — 15× — remote fleet shell
- `-5` — 14× — remote fleet shell
- `-d` — 13× — remote fleet shell

### `ssh worker-s0`

- `(no flags)` — 388× — remote fleet shell
- `-v` — 50× — remote fleet shell
- `-f` — 15× — remote fleet shell
- `-vE` — 14× — remote fleet shell
- `-n` — 13× — remote fleet shell
- `-lc` — 13× — remote fleet shell
- `-d` — 12× — remote fleet shell
- `-e` — 11× — remote fleet shell

### `browser navigate`

- `--url` — 961× — browser automation
- `--task --url` — 226× — browser automation
- `--url -1` — 222× — browser automation
- `--url -2` — 67× — browser automation
- `--task --url -1` — 50× — browser automation
- `--url --task` — 41× — browser automation
- `--url -3` — 33× — browser automation
- `--url -5` — 17× — browser automation

### `browser refs`

- `(no flags)` — 556× — browser automation
- `-iE` — 185× — browser automation
- `--task` — 172× — browser automation
- `-iE -20` — 39× — browser automation
- `-iE -6` — 32× — browser automation
- `--task -iE` — 30× — browser automation
- `-iE -8` — 25× — browser automation
- `-inE` — 25× — browser automation

### `secrets list`

- `(no flags)` — 633× — credential inject / list
- `-iE` — 220× — credential inject / list
- `-i` — 75× — credential inject / list
- `-30` — 62× — credential inject / list
- `-40` — 52× — credential inject / list
- `-20` — 39× — credential inject / list
- `-E` — 19× — credential inject / list
- `--json` — 12× — credential inject / list

### `ssh`

- `(no flags)` — 19181× — remote fleet shell
- `-I -E -n -m` — 224× — remote fleet shell
- `-lc` — 64× — remote fleet shell
- `-v` — 27× — remote fleet shell
- `-c` — 24× — remote fleet shell
- `-d` — 18× — remote fleet shell
- `-1` — 16× — remote fleet shell
- `--version` — 15× — remote fleet shell

### `computer screenshot`

- `--bundle --out -1` — 79× — native desktop automation
- `--bundle --window-id --out` — 63× — native desktop automation
- `--bundle --window-id --out -1` — 57× — native desktop automation
- `--bundle --out` — 47× — native desktop automation
- `--bundle --list --json` — 45× — native desktop automation
- `--bundle --list` — 29× — native desktop automation
- `--out` — 19× — native desktop automation
- `--bundle --window-id --out --json` — 18× — native desktop automation

### `browser start`

- `--profile` — 165× — browser automation
- `--task` — 101× — browser automation
- `--profile --task --url` — 99× — browser automation
- `(no flags)` — 58× — browser automation
- `--profile --task --url -20` — 24× — browser automation
- `--profile --task --url -3` — 23× — browser automation
- `--profile --task --url -2` — 22× — browser automation
- `--profile --task` — 20× — browser automation

### `ssh worker-s1`

- `(no flags)` — 167× — remote fleet shell
- `-v` — 15× — remote fleet shell
- `-lc` — 9× — remote fleet shell
- `-e` — 7× — remote fleet shell
- `-d` — 7× — remote fleet shell
- `-20` — 6× — remote fleet shell
- `-c` — 5× — remote fleet shell
- `-f` — 5× — remote fleet shell

### `ssh build-win`

- `(no flags)` — 61× — remote fleet shell
- `-NoProfile -Command` — 14× — remote fleet shell
- `-d -iE` — 11× — remote fleet shell
- `--version` — 10× — remote fleet shell
- `-2` — 10× — remote fleet shell
- `-g` — 8× — remote fleet shell
- `-d -E` — 8× — remote fleet shell
- `-v` — 7× — remote fleet shell

## Surface coverage gaps (from catalog, zero hits)

28 catalog paths with no observed invocation in-window (sample):

- `funnel down`
- `lock`
- `mine list`
- `mine remove`
- `packages`
- `perf`
- `perf commands`
- `perf run`
- `profile clear`
- `profile set`
- `profile status`
- `profile use`
- `refresh-rules`
- `subagents`
- `subagents add`
- `subagents remove`
- `subagents view`
- `wallet`
- `wallet list`
- `wallet remove`
- `wallet rename`
- `wallet show`
- `workflows`
- `workflows add`
- `workflows remove`
- `workflows view`
- `worktree prune`
- `worktree release`

## Notes

- Prefer the **sessions only** table when judging agent behavior — events mix hooks, daemons, and human scripts.
- `secrets exec` often comes from hooks (`caller: script`).
- Nested `agents ssh <host> 'agents …'` may appear as `ssh` / `ssh <host>` in session parses.
- Identical session hit counts on two hosts usually means a shared home / NFS mount (dedupe by session id).
