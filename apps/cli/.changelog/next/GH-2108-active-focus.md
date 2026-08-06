---
issue: 2108
type: fixed
---

`agents sessions focus ... --active` now excludes closed and crashed registry rows; explicit lifecycle filters such as `--closed` and `--crashed` still select them. Per-device `latest` / `oldest` selectors also wait for the peer's filtered index result instead of widening to live rows whose version is unknown.
