---
description: "Security audit of a codebase via parallel agents — one per vulnerability class. Reads code fast with Explore agents, cross-checks against current advisories via web search, filters false positives hard. Triggers on 'security scan', 'security audit', 'vulnerability scan', 'check for leaked secrets', 'scan for injection', or scheduled security checks."
argument-hint: "[scope — days, paths, or freeform e.g. 'last 7 days', 'prix/api routes', 'pre-launch sweep']"
allowed-tools: Read, Grep, Glob, Bash, WebSearch, WebFetch
user-invocable: true
---

# Security

A security audit pattern: analyze what changed, classify by vulnerability type, dispatch one parallel agent per class, verify every finding yourself, **filter false positives hard**, report only confirmed issues.

You are the orchestrator. Each vulnerability class becomes one Explore subagent that reads code fast and cross-checks against current advisories via web search. Never trust an agent's "CRITICAL" finding without reading the cited file yourself.

## How it works

```
You (orchestrator)
 |-- 1. Discover scope: what changed, what to audit
 |-- 2. Classify the change surface by risk
 |-- 3. Dispatch one Explore agent per vulnerability class (in parallel)
 |-- 4. Each agent: read code, grep patterns, web-search current advisories
 |-- 5. Collect findings
 |-- 6. VERIFY every CRITICAL/HIGH yourself — read the cited file:line
 |-- 7. FILTER false positives aggressively
 |-- 8. Report only verified findings
```

## Step 1 — Scope the scan

If args give a time window, use git:

```bash
git log --oneline --since="<N> days ago" --no-merges --name-only | head -200
```

If args give a path or "pre-launch", spend 60s reading top-level `README.md`, `AGENTS.md` / `CLAUDE.md`, and the entry-point file to learn: network listener? web UI? CLI? filesystem/keychain/external API access? Multi-tenant or single-user? OSS or hosted? The attack surface determines which classes matter.

State your scope back to the user in 3-4 lines before dispatching anything. They'll redirect if it's wrong.

## Step 2 — Classify the change surface

Look at the touched files and project conventions (the repo's `AGENTS.md` / `CLAUDE.md` are authoritative for what's high-risk). Group files into vulnerability-relevant zones — common buckets:

- HTTP/API routes, controllers, middleware
- Auth, sessions, billing, IAM
- DB queries, ORM raw SQL, analytics query builders
- HTML rendering, share/preview pages, embeddable surfaces
- Shell execution, child_process, subprocess, exec.Command
- Native/IPC boundaries (Electron main↔renderer, browser extension content scripts)
- Infra (Terraform, CF/CDN config, Dockerfile, K8s manifests)
- Dependencies (`package.json`, `go.mod`, lockfiles, `requirements.txt`)
- Config & docs that may have leaked secrets (`*.env*`, `CLAUDE.md`, `docs/`, deploy scripts)

If no commit list is provided, treat the whole repo's most-trafficked code paths as the surface.

## Step 3 — Dispatch parallel Explore agents

One agent per vulnerability class. **Spawn them all in a single message** (parallel Agent tool calls). Use `subagent_type: "Explore"` for fast, read-only code scanning. Set `model: "sonnet"` (cost-effective for pattern matching) unless the class needs deeper reasoning (then `opus`).

### Vulnerability classes — pick the ones the surface warrants

| Class | When to run | Typical patterns to grep |
|---|---|---|
| **SECRETS** | Always | `sk_live`, `phc_`, `AKID`, `xoxb-`, `ghp_`, `BEGIN PRIVATE KEY`, `.env*` tracked in git, secrets in `CLAUDE.md`/docs, deleted-but-in-history credentials |
| **INJECTION** | DB/query code changed | String interpolation in queries, template literals near `.query()`/`.rpc()`/`SELECT`, user input reaching ORM raw escape hatches, NoSQL operator injection (`$where`, `$ne`) |
| **AUTH** | Routes, middleware, auth changed | Endpoints without auth middleware, role checks (`isAdmin`, `isDev`) that can be skipped, broken IDOR (object access by user-controlled ID without ownership check), OAuth flow logic, JWT verification |
| **XSS** | HTML rendering / user output changed | User input in HTML templates, `innerHTML`/`dangerouslySetInnerHTML`, missing CSP, script injection via display names or artifact content, missing `X-Frame-Options` |
| **SHELL** | Shell-exec or child_process touched | `exec.Command("sh","-c", ...)`, `child_process.exec` with concat, `osascript -e` with input, path traversal via user-controlled paths |
| **IPC / ELECTRON** | Electron main process or preload changed | `nodeIntegration: true`, custom protocol handlers, `webContents.executeJavaScript` with user input, `contextIsolation: false` |
| **INFRA** | CF/Terraform/Dockerfile/K8s changed | Open redirects, SSRF in worker fetches, exposed origins (host without WAF), missing security headers, K8s `privileged: true`, overly broad RBAC |
| **DEPS** | Lockfiles changed | Run `npm audit --json` / `go list -json -deps -m all`, web-search "CVE \<package\> \<version\> 2026" for any package not in the boring set |

### Subagent prompt template

```
## Security Scan: <CLASS>

Scope: <files / dirs to scan, from the changed-files list>
Class: <CLASS>

What to check:
<2–4 lines of specifics for this class>

Patterns to grep:
<concrete patterns>

Cross-check current advisories:
- WebSearch: "<library or pattern> CVE 2026" or "<framework> security advisory 2026"
- WebFetch: GitHub Security Advisory pages for the libraries in scope.

Report format (one bullet per finding):
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- Location: file:line
- Code: the actual snippet (quote it)
- Attack vector: how an attacker reaches this
- Confidence: high / medium / low (medium or low MUST list disconfirming evidence)
- Fix: one line

If you find nothing, say so. A clean scan is a valid result.
Return file:line quotes for every claim. Do NOT paraphrase. If you can't quote it, don't claim it.
```

## Step 4 — Verify every CRITICAL/HIGH yourself

Trust no agent verdict above MEDIUM. For each CRITICAL or HIGH:

1. Read the cited file at the cited line.
2. Confirm the code matches what the agent quoted.
3. Trace whether user input actually reaches the vulnerable point — is there validation, escaping, middleware, parameterization in between?
4. Check for mitigations the agent missed (framework defaults, ORM parameterization, middleware that runs before the route).
5. Classify: `VERIFIED` / `FALSE POSITIVE` / `NEEDS RUNTIME TEST`.

## Step 5 — Filter false positives HARD

**False positives in security scans are the rule, not the exception.** Agents will flag patterns that look bad in isolation but aren't real vulnerabilities. The most common categories — discard these on sight unless you have evidence otherwise:

### "Leaked API key" that's actually a public key

| Pattern flagged | Why it's not a leak |
|---|---|
| `phc_xxxx` in client code | PostHog **public ingest** keys are designed to ship to browsers. Real risk is the `phx_` personal API key. |
| `pk_live_*` / `pk_test_*` Stripe key | Stripe publishable keys are public by design. Only `sk_live_*` / `sk_test_*` are sensitive. |
| `eyJhbGciOi...` in client | Supabase / Firebase **anon** JWTs are public by design. RLS enforces auth. The service-role key is the secret one. |
| `AIza...` Google API key | Often a public Maps/YouTube key restricted by HTTP referrer. Check the restriction, not the format. |
| GitHub App `client_id` | Public by design. The `client_secret` is the secret. |

Confirm by reading the code: is the value embedded in shipped client bundles? Then it's by design. The check is on **intent**, not regex match.

### Other common false-positive patterns

- **"Missing auth on endpoint"** → check for middleware applied at the router/app level, not the handler. `app.use(authMiddleware)` covers everything below.
- **"SQL injection in `db.query(\`...\${x}...\`)`"** → check if `x` came from validated input upstream, or if the driver is parameterizing automatically.
- **"XSS via innerHTML"** → check if the source is hardcoded/server-controlled, not user-controlled.
- **"Hardcoded password"** → check if it's a test fixture, a documented default, or production. Test/dev defaults aren't a vulnerability; they're an architectural choice that may or may not be appropriate.
- **`exec.Command("sh", "-c", ...)`** → check if all interpolated values are server-controlled constants or strictly validated. Shell exec with no user-reachable input is fine.
- **"Dependency CVE"** → check if the vulnerable code path is actually called by your code (not just present in the dependency tree). `npm audit` reports a lot of noise on transitive dev-only deps.

When in doubt, **read the upstream advisory** (Web-search the CVE) and check if your usage matches the vulnerable path. Most reported CVEs only fire under narrow configurations.

## Step 6 — Report

Present only verified findings. Group by severity. For each, include:

- Class
- Location (`file:line`)
- The actual code (quoted)
- Attack vector
- Recommended fix

End the report with a **False Positives Filtered** section listing what agents flagged but you disproved — this builds trust and prevents the same flags resurfacing next scan. Also a **Clean Areas** section listing what passed (so the user knows what's been audited).

## Output

```markdown
## Security Scan — <YYYY-MM-DD>

### Scope
- <window or paths>
- <commit count if time-windowed>

### Agents dispatched
- <CLASS> (model)
- ...

### CRITICAL
- ...

### HIGH
- ...

### MEDIUM
- ...

### False positives filtered
- <flag> — <why it's not real>

### Clean
- <area scanned, no findings>
```

Save reports under `<repo>/security/<YYYY-MM-DD>-<slug>.md` if the repo wants archived scans, otherwise return the report to the user.

## Hard rules

- **No "CRITICAL" without a file:line quote.** If the agent didn't quote code, demote to "needs verification" and verify yourself.
- **No fix proposals you can't justify from the code.** "Add input validation" is a non-fix if you can't say which input on which line.
- **Public keys are not leaked keys.** Read the surrounding code to determine intent before flagging.
- **CVEs are not vulnerabilities until you confirm your usage matches the vulnerable path.** Look at the advisory's "Affected versions / Affected functions" section.
- **Cost is irrelevant; correctness is everything.** If unsure about a finding, spawn another Explore agent to dig deeper. A missed bug is far more expensive than a re-scan.
