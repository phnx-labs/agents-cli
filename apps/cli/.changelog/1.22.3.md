- **Menubar home-base self-test accepts `MenubarHelper-universal`.** The
  signed-helper gate required `executablePath` to end in exactly `MenubarHelper`,
  but lipo production builds name the binary `MenubarHelper-universal`, so every
  1.22.2 publish on mac-mini failed after the release PR had already merged and
  tagged. Source: `menubar/Sources/MenubarHelper/ChildProcessSelfTest.swift`.
