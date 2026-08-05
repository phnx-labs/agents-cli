- **`agents share` serves screenshots and recordings with a real content-type.**
  Publishing a PNG/JPEG/GIF/WebP/AVIF image, an MP4/MOV/WebM video, or a PDF now
  sets the matching `content-type` instead of `application/octet-stream`. GitHub's
  image proxy (camo) only renders an inline `![](url)` when the asset is served as
  a real image/video type, so this is what lets an agent drop a screenshot or a
  screen recording straight into a PR body via `agents share <file>`. HTML, SVG,
  CSS, JS, JSON, and text were already typed correctly. Source:
  `apps/cli/src/lib/share/publish.ts`.
