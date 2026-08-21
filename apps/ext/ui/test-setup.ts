// Suite-wide bun test preload (wired via bunfig.toml). Registers happy-dom
// globals BEFORE any test file is imported, so modules that bind to `window`
// at evaluation time — dompurify behind renderMarkdown
// (settings/utils/markdown.ts) — work in every test regardless of file
// ordering. Before this preload, tests rendering a markdown-bearing component
// (FeedItem) only passed when another file happened to register happy-dom
// first (RUSH-2974).
//
// Guarded because individual test files (App.test.tsx,
// FeedItem.preview.test.tsx) keep their own guarded registration for runs
// launched outside this directory, where bunfig.toml — and this preload —
// are not picked up: registering twice throws.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
