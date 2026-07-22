- **`agents monitors test` and `agents monitors view` now support `--json`.** The
  dry-run oracle (`test`) and config inspector (`view`) were human-text only, so an
  agent couldn't parse "would this fire?" or a monitor's state. Both emit a
  structured payload on stdout under `--json`; not-found errors emit `{"error":…}`
  and exit non-zero, and human error/diagnostic output was moved off stdout to
  stderr. Source: `apps/cli/src/commands/monitors.ts`. (RUSH-1832)
