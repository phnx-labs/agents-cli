---
kind: plan
title: Name provider accounts and discover versions automatically
status: implemented
---

# Name provider accounts and discover versions automatically

When an installed Claude or Codex version is signed into an identity, the user
can name that provider account once, discover every matching version, and select it
for a run without copying credentials. Issue: [#2300](https://github.com/phnx-labs/agents-cli/issues/2300).

## Purpose

Make account identity stable and human-readable across devices without moving
or centrally storing any harness credential.

<div class="artifact-callout">A label names one provider account. Installed versions are discovered, never attached.</div>

## Public Interface

| Action | Result |
| --- | --- |
| `accounts` | Discovers distinct signed-in accounts and their matching versions |
| `accounts name work` | Opens a picker and names one provider account |
| `accounts name work --from claude@2.1.220` | Names the live identity non-interactively |
| `run claude --account work` | Picks a healthy version currently signed into `work` |

```bash
agents accounts
agents accounts name work
agents run claude --account work
```

## Proposed Changes

<svg viewBox="0 0 900 280" role="img" aria-label="Account label data flow" xmlns="http://www.w3.org/2000/svg">
  <rect x="24" y="78" width="220" height="110" rx="14" fill="#161b22" stroke="#a3e635" stroke-width="3"/>
  <text x="134" y="115" fill="#a3e635" text-anchor="middle" font-size="20">Version home</text>
  <text x="134" y="148" fill="#ffffff" text-anchor="middle" font-size="16">local credential</text>
  <rect x="340" y="28" width="240" height="92" rx="14" fill="#161b22" stroke="#58a6ff" stroke-width="3"/>
  <text x="460" y="66" fill="#58a6ff" text-anchor="middle" font-size="19">accounts.yaml</text>
  <text x="460" y="94" fill="#ffffff" text-anchor="middle" font-size="15">label → provider fingerprint</text>
  <rect x="340" y="164" width="240" height="92" rx="14" fill="#161b22" stroke="#d2a8ff" stroke-width="3"/>
  <text x="460" y="202" fill="#d2a8ff" text-anchor="middle" font-size="19">live discovery</text>
  <text x="460" y="230" fill="#ffffff" text-anchor="middle" font-size="15">matching version homes</text>
  <rect x="680" y="78" width="196" height="110" rx="14" fill="#161b22" stroke="#a3e635" stroke-width="3"/>
  <text x="778" y="116" fill="#a3e635" text-anchor="middle" font-size="20">agents run</text>
  <text x="778" y="148" fill="#ffffff" text-anchor="middle" font-size="16">fail-closed pick</text>
  <path d="M244 110 L340 75" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <path d="M244 156 L340 207" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <path d="M580 75 L680 110" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <path d="M580 207 L680 156" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#8b949e"/></marker></defs>
</svg>

Credentials remain local. Only a deterministic SHA-256 fingerprint crosses the
device boundary. Version membership is derived from live identity matches.

## Validation

- One label names exactly one provider account.
- Every matching installed version is discovered automatically.
- One provider account cannot have two labels.
- Missing, generic, or mismatched identities fail without storing a label.
- Local account labels are rejected for vendor-cloud and lease placement.
- CLI help, concepts, execution specification, README, tests, and changelog agree.

## Risks

| Risk | Control |
| --- | --- |
| A version is signed into another identity | Live discovery excludes it from the named account |
| Rotation silently chooses another account | `--account` bypasses rotation and fails closed |
| Synced configuration exposes identity data | The central registry contains only SHA-256 fingerprints |

## Tracking

- [GitHub issue #2300](https://github.com/phnx-labs/agents-cli/issues/2300)
