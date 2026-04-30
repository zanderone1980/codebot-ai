const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

function readDesktopVersion() {
  const candidates = [
    path.join(__dirname, 'package.json'),
    path.join(process.resourcesPath || '', 'codebot', 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (pkg.version) return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }

  return 'unknown';
}

const version = readDesktopVersion();

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  version: version,
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  onBackendStatus: (callback) => {
    ipcRenderer.on('backend-status', (event, data) => callback(data));
  },
  // PR 17 — workspace picker bridge. Renderer can call
  //   electronAPI.getWorkspace()  → { workspaceDir, defaultWorkspace, fromEnv }
  //   electronAPI.pickWorkspace() → opens native folder picker, persists, restarts
  // Both delegate to ipcMain handlers in electron/main.js. The Pick
  // Workspace… menu item invokes the same IPC handler, so the two
  // entry points are guaranteed to behave identically.
  getWorkspace: () => ipcRenderer.invoke('get-workspace'),
  pickWorkspace: () => ipcRenderer.invoke('pick-workspace'),
});

window.addEventListener('error', (e) => {
  console.error('[renderer] Uncaught error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] Unhandled rejection:', e.reason);
});
