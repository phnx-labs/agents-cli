- **Dispatch-bar screenshots now upload via `linear create --image` instead of
  landing as dead local paths.** The menu-bar helper previously injected
  screenshot paths into the ticket-agent prompt, and the model echoed them into
  the issue description as `/Users/…` text. The agent now returns ticket fields
  as JSON, and the helper itself runs `linear create` with `--image <path>` for
  each selected screenshot, so paths pass through Swift argv and survive spaces
  or `@` in CleanShot filenames. Coordinates with the `linear create --image`
  support added in `phnx-labs/linear-cli#28`. Source:
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/IssueSelfTest.swift`.
