---
name: "AGI terminal instrument"
fonts:
  body: "DejaVu Sans"
  mono: "DejaVu Sans Mono"
  display: "DejaVu Sans"
theme:
  default: system
themes:
  light:
    background: "#f7f8f4"
    surface: "#ffffff"
    surfaceAlt: "#eef1e9"
    line: "#d8ddd1"
    text: "#171a16"
    muted: "#596253"
    accent: "#4d7c0f"
    accentAlt: "#0e7490"
    warn: "#a16207"
    danger: "#dc2626"
  dark:
    background: "#0a0a0a"
    surface: "#111312"
    surfaceAlt: "#161a18"
    line: "#333333"
    text: "#e8e8e8"
    muted: "#888888"
    accent: "#a3e635"
    accentAlt: "#22d3ee"
    warn: "#facc15"
    danger: "#f87171"
layout:
  contentWidth: 980
  pagePadding: 28
  mobilePagePadding: 14
  heroTop: 42
  heroBottom: 28
  sectionSpacing: 38
  figureSpacing: 24
  panelPadding: 18
  footerSpacing: 64
  printMargin: 24
artifact:
  density: compact
  radius: 8
  printTheme: light
---

# Design

AGI artifact rendering: near-black terminal surfaces, one lime accent, calm gray hierarchy, and monospace code. The local DejaVu families are build-time substitutes for the product's Inter and JetBrains Mono stacks so the HTML remains fully offline and warning-free.
