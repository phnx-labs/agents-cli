- **Interactive session browser: preview-by-default with clickable ticket + PR
  links.** In `agents sessions` / `agents sessions --active`, the highlighted
  row's preview is now open by default (`tab` toggles it off), and the preview's
  links line renders the ticket and PR as OSC 8 terminal hyperlinks — the ticket
  resolves to its Linear URL (workspace slug resolved config-first) and `PR#`
  resolves to its GitHub URL — so they are click-through in terminals that support
  them. Source: `apps/cli/src/lib/picker.ts`,
  `apps/cli/src/commands/sessions-browser.ts`,
  `apps/cli/src/lib/session/render.ts`.
