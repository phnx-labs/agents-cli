// Standalone Electron app: the Factory work stream running outside any editor.
// It loads the exact same React UI bundle the VS Code webview uses (built by
// vite.standalone.config.ts) and feeds it floor data over IPC, speaking the same
// message protocol the extension host does. Running agents show as telemetry; the
// editor keeps ownership of live terminal tabs.

import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import * as os from 'os'
import { getDefaultSettings } from '../src/core/settings'
import { fetchAllFloorTasks } from './floorData'
import { FloorPoll } from './floorPoll'

// Resolve UI / preload / assets for both dev and a packaged .app.
//   dev  (`electron ./dist/main.js`): getAppPath() = <ext>/app/dist; the built
//        UI + assets sit at <ext>/out/app-ui and <ext>/assets.
//   packaged (electron-builder): getAppPath() = .../Resources/app.asar with
//        main/preload under dist/ inside it; the UI + assets are copied to
//        Resources/ via `extraResources` (see package.json build config).
const APP = app.getAppPath()
const UI_INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'app-ui', 'index.html')
  : path.join(APP, '..', '..', 'out', 'app-ui', 'index.html')
const PRELOAD = app.isPackaged
  ? path.join(APP, 'dist', 'preload.js')
  : path.join(APP, 'preload.js')
const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(APP, '..', '..', 'assets')
const POLL_MS = 5000

let win: BrowserWindow | null = null

function send(message: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('to-renderer', message)
}

// The floor poll pauses when the floor is hidden and resumes when shown, so a
// dashboard tab nobody is looking at stops burning CPU/network + `agents` calls
// every 5s (mirrors the VS Code host's subscribeFloor / cleanupFloorWatchers).
const floorPoll = new FloorPoll(POLL_MS, () => void pushFloor())

async function pushFloor(): Promise<void> {
  // The standalone app owns no editor terminal tabs, so allTerminalsData is empty
  // and agents surface entirely from tasksData (local + cloud). The UI's
  // buildUnifiedList(terminals, tasks) handles the empty-terminals case.
  send({ type: 'allTerminalsData', terminals: [] })
  const tasks = await fetchAllFloorTasks()
  send({ type: 'tasksData', tasks })
}

ipcMain.on('to-host', (_event, message: { type?: string } | null) => {
  const type = message?.type
  if (type === 'ready') {
    // The UI blocks on `init` (its settings gate) before rendering anything, so
    // seed it with defaults, then open the floor.
    send({
      type: 'init',
      settings: getDefaultSettings(),
      runningCounts: { claude: 0, codex: 0, gemini: 0, opencode: 0, cursor: 0, shell: 0, custom: {} },
      workspacePath: os.homedir(),
      dismissedTaskIds: [],
    })
    send({ type: 'panelVisibility', visible: true })
    floorPoll.start()
    void pushFloor()
    return
  }
  if (type === 'subscribeFloor') {
    // Floor shown again — resume the poll and push a fresh snapshot immediately.
    floorPoll.start()
    void pushFloor()
    return
  }
  if (type === 'unsubscribeFloor') {
    // Floor hidden — pause the poll so it stops running while nobody's looking.
    floorPoll.stop()
    return
  }
  if (type === 'fetchTasks' || type === 'fetchAllTerminals') {
    void pushFloor()
  }
  // Other message types (dispatch, settings, oauth, foreman, ...) are extension-only
  // for now; the standalone host ignores them until those surfaces are wired.
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Factory',
    backgroundColor: '#000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses Node builtins (path/url) to resolve local asset URLs, so
      // it can't run in the default sandbox. contextIsolation stays on — the UI
      // still only sees the narrow swarmHost surface exposed via contextBridge.
      sandbox: false,
      additionalArguments: [`--swarm-assets=${ASSETS_DIR}`],
    },
  })
  void win.loadFile(UI_INDEX)
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(() => {
  createWindow()
  // The floor is visible on launch, so start polling now; subscribe/unsubscribe
  // from the UI toggle it thereafter.
  floorPoll.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  floorPoll.stop()
  if (process.platform !== 'darwin') app.quit()
})
