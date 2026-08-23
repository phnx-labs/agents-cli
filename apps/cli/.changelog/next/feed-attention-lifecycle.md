---
type: feat
---

Feed attention is now modeled as an explicit lifecycle the CLI reconciles, the foundation for a feed-driven Needs-You surface. `OpenBlock` carries `generation`/`source`/`state`/`sourceCursor` (back-compatible — derived for existing blocks), the answer/continue/clear paths write a resolution tombstone before the block clears so a resolved ask can no longer silently resurrect, and a new pure `reconcileAttention` merges the open-block ledger, session lifecycle, and a CLI-supplied PR signal into one canonical `AttentionItem`.
