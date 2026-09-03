---
kind: report
title: "Share visibility (me / org) — what shipped, the bug that hid it, and the fix"
summary: "PHNX-3260 added me/org access-gated share links and is deployed and enforcing. A separate handle-ownership bug (PHNX-3291) locked the owner out of publishing; this report shows the root cause, the fix, and the live evidence."
links:
  - https://linear.app/getrush/issue/PHNX-3260
  - https://linear.app/getrush/issue/PHNX-3291
  - https://github.com/phnx-labs/agi-cli/pull/3108
  - https://github.com/phnx-labs/agi-cli/pull/3112
tracking: PHNX-3291
---

## Summary

`agents artifacts share <file>` publishes an HTML page to a link served by a
Cloudflare Worker at `share.agents-cli.sh/<handle>/<slug>`. **PHNX-3260** added
access tiers via `--visibility`; the `me` and `org` tiers are **deployed and
enforcing** on the live Worker. While testing them I hit **PHNX-3291**: a
handle-ownership bug that 409'd the rightful owner out of publishing entirely.
This report shows both — the feature that shipped, and the fix that makes it
usable.

| `--visibility` | Who can open the link | Gallery |
|---|---|---|
| `public` (default) | anyone | listed |
| `unlisted` | anyone with the link (noindex) | hidden |
| `me` | only the signed-in **owner** (`userId` match), else 404 | hidden |
| `org` | signed-in users on the owner's **verified email domain**, else 404 | hidden |

`me`/`org` are enforced on GET: an anonymous request is **302'd to Phoenix
login**; a wrong viewer gets **404** so the page's existence never leaks.

## Findings

**1. The me/org feature is live.** All PHNX-3260 code is merged to `main` and the
deployed Worker enforces it (evidence below): BYO `--visibility me`/`org` writes
are refused, `public` still works, and `share status` reports the deployed
template as `current`.

**2. A separate bug (PHNX-3291) made it unusable for the owner.** Publishing or
changing a page's visibility from the signed-in account failed with a message
that is wrong on its face — it *is* the owner's handle:

```text
$ agents artifacts share plan.html --visibility me --slug share-consolidation-cli-help
Handle 'muqsitnawaz' is already claimed by another account.
```

**3. Root cause — two publish paths stamp `owner` in different namespaces.** The
Worker decides handle ownership by scanning pages under the namespace and
comparing each page's `owner` to the writer's Phoenix `userId`. But a Phoenix
publish stamps `owner = userId` (a UUID) while a **BYO `WRITE_TOKEN` publish
stamps `owner = SHARE_NAMESPACE`** (the namespace string, e.g. `muqsitnawaz` —
`worker-template.ts:756`). Once any BYO page existed, `"muqsitnawaz" !== "7b28…"`
409'd the real owner forever, even though the dedicated ownership record
(`__handles/muqsitnawaz`) correctly named them.

<figure class="artifact-figure">
<svg viewBox="0 0 720 210" width="100%" role="img" aria-label="Before and after the handle ownership check">
  <text x="12" y="20" font-family="ui-sans-serif,system-ui" font-size="13" font-weight="600" fill="currentColor">BEFORE — page-owner scan runs first</text>
  <rect x="12" y="32" width="330" height="70" rx="8" fill="none" stroke="#e5484d" stroke-width="2"/>
  <text x="26" y="58" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">BYO page owner = "muqsitnawaz"  (namespace)</text>
  <text x="26" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">writer userId  = "7b28…"        (a UUID)</text>
  <text x="26" y="132" font-family="ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#e5484d">"muqsitnawaz" ≠ "7b28…"  →  409</text>
  <text x="26" y="160" font-family="ui-sans-serif,system-ui" font-size="13" fill="currentColor">Owner cannot publish or change --visibility</text>

  <text x="388" y="20" font-family="ui-sans-serif,system-ui" font-size="13" font-weight="600" fill="currentColor">AFTER — claim object is authoritative</text>
  <rect x="388" y="32" width="330" height="70" rx="8" fill="none" stroke="#30a46c" stroke-width="2"/>
  <text x="402" y="58" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">__handles/muqsitnawaz = { userId:"7b28…" }</text>
  <text x="402" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">writer userId = "7b28…"  →  match</text>
  <text x="402" y="132" font-family="ui-sans-serif,system-ui" font-size="14" font-weight="600" fill="#30a46c">200 — owner writes freely</text>
  <text x="402" y="160" font-family="ui-sans-serif,system-ui" font-size="13" fill="currentColor">a different Phoenix userId is still 409'd</text>
</svg>
<figcaption>The fix consults the <code>__handles/&lt;handle&gt;</code> claim first; the page scan becomes a pre-claim fallback that ignores BYO namespace stamps (<code>owner === handle</code>).</figcaption>
</figure>

## Evidence

**Live probes against `share.agents-cli.sh` (zion, 2026-08-27):**

| Probe | Result | Meaning |
|---|---|---|
| BYO publish `--visibility me` | **400** `me/org requires Phoenix identity` | Worker enforces the new rule |
| BYO publish `--visibility org` | **400** | same |
| BYO publish `--visibility public` | **200**, served | public path intact |
| `curl` public page, no auth | **200** | anonymous public GET unchanged |
| `share status` deployed template | **`current`** | me/org Worker is live |
| Change existing page → `me` (managed) | **409** handle taken | the PHNX-3291 bug |
| `__handles/muqsitnawaz` claim owner | `7b28…` = signed-in userId | owner *does* own the handle |

**The fix (`cli/src/lib/share/worker-template.ts`):**

```diff
 async function assertHandleOwner(bucket, handle, userId) {
-  // page-owner scan FIRST — a BYO page (owner = namespace) 409s the real owner
-  const list = await bucket.list({ prefix: handle + '/', include: ['customMetadata'] });
-  for (const o of list.objects || []) {
-    const owner = o.customMetadata && o.customMetadata.owner;
-    if (owner && owner !== userId) return { error: json({ error: 'handle taken' }, 409) };
-  }
-  const existing = await bucket.get('__handles/' + handle);
-  if (!existing) return {};
-  const claimed = existing.customMetadata && existing.customMetadata.userId;
-  if (claimed && claimed !== userId) return { error: json({ error: 'handle taken' }, 409) };
-  return {};
+  // The claim object is the authoritative first-writer record. Consult it FIRST.
+  const existing = await bucket.get('__handles/' + handle);
+  if (existing) {
+    const claimed = existing.customMetadata && existing.customMetadata.userId;
+    if (claimed && claimed !== userId) return { error: json({ error: 'handle taken' }, 409) };
+    return {};
+  }
+  // No claim yet — fall back to the page scan, but ignore BYO namespace stamps
+  // (owner === handle) so a first Phoenix publish can claim its own handle.
+  const list = await bucket.list({ prefix: handle + '/', include: ['customMetadata'] });
+  for (const o of list.objects || []) {
+    const owner = o.customMetadata && o.customMetadata.owner;
+    if (owner && owner !== userId && owner !== handle) return { error: json({ error: 'handle taken' }, 409) };
+  }
+  return {};
 }
```

**Test + typecheck:**

```text
npx vitest run src/lib/share/worker-template.test.ts   →  54 passed (54)
npx tsc --noEmit                                        →  0 errors
```

Two new tests exercise the real Worker (no mocks): a BYO page under a
Phoenix-claimed handle (was **409**, now **200**), and a first Phoenix claim over
BYO-only pages (**200**). Existing colliding-local-part tests still pass.

<div class="artifact-callout">
<strong>Status.</strong> PHNX-3260 (me/org) is <strong>Done</strong> — code merged
(#3092, #3093), CHANGELOG merged (#3108), Worker deployed and enforcing. The
PHNX-3291 fix is PR <strong>#3112</strong> (review + CI in flight); once it merges
I deploy the fixed Worker and run the full live me/org demo (publish a
<code>me</code> page → anon 302 to login → owner sees 200).
</div>
