// Electron preload: the standalone-host side of the HostBridge (P1).
//
// The React UI is host-agnostic — its bridge posts outbound over window.swarmHost
// and receives inbound over ordinary window 'message' events. So the preload only
// has to: (1) expose swarmHost.post -> ipcRenderer, (2) re-emit host->renderer IPC
// as window 'message' events (the exact channel the webview already listens on),
// and (3) supply window.__ICONS__ (the extension injects it in its HTML; here it
// comes from local asset files).

import { contextBridge, ipcRenderer } from 'electron'
import * as path from 'path'
import { pathToFileURL } from 'url'

// Main passes the resolved assets dir via --swarm-assets (see additionalArguments)
// so the preload needn't guess its own location.
const assetsArg = process.argv.find((a) => a.startsWith('--swarm-assets='))
const assetsDir = assetsArg ? assetsArg.slice('--swarm-assets='.length) : ''
const asset = (file: string) => pathToFileURL(path.join(assetsDir, file)).href

contextBridge.exposeInMainWorld('swarmHost', {
  post: (message: unknown) => ipcRenderer.send('to-host', message),
})

ipcRenderer.on('to-renderer', (_event, message) => {
  window.postMessage(message, '*')
})

contextBridge.exposeInMainWorld('__ICONS__', {
  claude: asset('claude.png'),
  codex: { dark: asset('chatgpt.png'), light: asset('chatgpt-light.png') },
  gemini: asset('gemini.png'),
  opencode: asset('opencode.png'),
  cursor: { dark: asset('cursor.png'), light: asset('cursor-light.png') },
  shell: asset('agents.png'),
  agents: asset('agents.png'),
  github: asset('github.png'),
  antigravity: asset('antigravity.png'),
  grok: asset('grok.png'),
})
