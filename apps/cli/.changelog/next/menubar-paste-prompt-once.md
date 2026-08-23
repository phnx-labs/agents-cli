---
type: fix
---

Cmd-Shift-V once again pastes the clip reference in a single keystroke. 1.22.47 decoupled the paste from Accessibility so it never prompted — but that meant an ungranted machine silently fell back to copying the token to the clipboard, so you had to press Cmd-V yourself (two keystrokes). The helper now prompts for Accessibility **once** per launch to restore the one-keystroke auto-type, then falls back to the clipboard silently if you decline (no per-paste nagging). Because dev builds now use a distinct `.dev` bundle id and the release pins the helper's designated requirement, granting it once sticks across upgrades — so a single prompt is all it takes.
