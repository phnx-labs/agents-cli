- **`agents routines` is now an interactive browser.** On a terminal, the bare
  command opens a filterable, grouped picker (reusing the same picker primitive
  behind `agents sessions`) instead of printing nothing but help. The project /
  device group headers show as inline dividers, and selecting a routine drills into
  four blocks — Definition, Next fire, Recent runs, Stats. `agents routines --json`
  and any non-interactive shell keep the exact `agents routines list` output, so
  pipes and the menu bar are unaffected. (RUSH-2503)
