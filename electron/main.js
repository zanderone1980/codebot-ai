const { app, BrowserWindow, Menu, shell, dialog, Tray, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ── Config ──
const DASHBOARD_PORT = 3120;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const MAX_STARTUP_WAIT = 15_000; // 15 seconds max wait for server

let mainWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
let serverCrashCount = 0;
let lastCrashTime = 0;
const MAX_AUTO_RESTARTS = 3;
const CRASH_WINDOW_MS = 60_000;

// ── Paths ──
function getCodebotPaths() {
  // In packaged app, resources are in app.asar's parent
  const resourcesPath = process.resourcesPath;
  const bundledDist = path.join(resourcesPath, 'codebot', 'dist');
  const bundledBin = path.join(resourcesPath, 'codebot', 'bin', 'codebot');

  // In development, use the parent directory
  const devDist = path.join(__dirname, '..', 'dist');
  const devBin = path.join(__dirname, '..', 'bin', 'codebot');

  if (app.isPackaged && fs.existsSync(bundledDist)) {
    return { dist: bundledDist, bin: bundledBin, root: path.join(resourcesPath, 'codebot') };
  }
  return { dist: devDist, bin: devBin, root: path.join(__dirname, '..') };
}

// ── Wait for server to be ready ──
function waitForServer(url, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url + '/api/health', (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
        res.resume();
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('Server failed to start within ' + (timeout / 1000) + ' seconds'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

// ── API Key Input Dialog ──
function promptForApiKey() {
  return new Promise((resolve) => {
    const inputWin = new BrowserWindow({
      width: 500, height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Enter API Key',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      backgroundColor: '#1a1a2e',
    });
    inputWin.setMenuBarVisibility(false);
    const html = `<!DOCTYPE html><html><head><style>
      body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; margin: 0; display: flex; flex-direction: column; justify-content: center; height: 100vh; box-sizing: border-box; }
      h3 { margin: 0 0 12px 0; color: #00d4ff; font-size: 16px; }
      input { width: 100%; padding: 10px; font-size: 14px; background: #0a0a1a; color: #fff; border: 1px solid #333; border-radius: 6px; box-sizing: border-box; font-family: monospace; }
      input:focus { outline: none; border-color: #00d4ff; }
      .btns { display: flex; gap: 10px; margin-top: 14px; justify-content: flex-end; }
      button { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
      .ok { background: #00d4ff; color: #000; font-weight: 600; }
      .cancel { background: #333; color: #ccc; }
    </style></head><body>
      <h3>Anthropic API Key</h3>
      <input id="key" type="password" placeholder="sk-ant-..." autofocus />
      <div class="btns">
        <button class="cancel" onclick="window.close()">Cancel</button>
        <button class="ok" onclick="submitKey()">Save</button>
      </div>
      <script>
        function submitKey() {
          const k = document.getElementById('key').value.trim();
          if (k) { document.title = 'KEY:' + k; }
        }
        document.getElementById('key').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitKey();
          if (e.key === 'Escape') window.close();
        });
      </script>
    </body></html>`;
    inputWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    inputWin.webContents.on('page-title-updated', (event, title) => {
      if (title.startsWith('KEY:')) {
        resolve(title.slice(4));
        inputWin.close();
      }
    });
    inputWin.on('closed', () => resolve(null));
  });
}

// ── Start CodeBot Dashboard Server ──
async function startServer() {
  const paths = getCodebotPaths();

  // Check if server is already running
  try {
    await waitForServer(DASHBOARD_URL, 2000);
    console.log('Dashboard already running on port ' + DASHBOARD_PORT);
    return true;
  } catch {
    // Not running — start it
  }

  // Find node binary — macOS .app bundles don't inherit shell PATH
  let nodeBin = process.execPath;
  if (nodeBin.includes('Electron') || nodeBin.includes('CodeBot AI')) {
    // Try common node locations
    const candidates = [
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      path.join(process.env.HOME || '', '.nvm/versions/node', 'current', 'bin', 'node'),
      '/usr/bin/node',
    ];
    // Also check PATH if available
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
      candidates.push(path.join(dir, 'node'));
    }
    nodeBin = candidates.find(p => fs.existsSync(p)) || 'node';
    console.log('  Using node at:', nodeBin);
  }

  const binPath = paths.bin;
  if (!fs.existsSync(binPath)) {
    dialog.showErrorBox('CodeBot AI',
      'Could not find CodeBot at:\n' + binPath +
      '\n\nPlease run "npm run build" in the codebot-ai directory first.');
    app.quit();
    return false;
  }

  console.log('Starting CodeBot dashboard server...');
  console.log('  Bin path:', binPath);
  console.log('  CWD:', paths.root);

  // Ensure PATH includes common bin dirs for macOS .app context
  const extraPath = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'].join(':');
  const fullPath = process.env.PATH ? `${extraPath}:${process.env.PATH}` : extraPath;

  // Resolve API key: embedded .env > user config > env vars
  let apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    // Check for .env file next to the app (for demo/investor builds)
    const envLocations = [
      path.join(paths.root, '.env'),
      path.join(app.getPath('userData'), '.env'),
      path.join(process.env.HOME || '', '.codebot', '.env'),
    ];
    for (const envPath of envLocations) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
        if (match) { apiKey = match[1].trim(); break; }
      } catch { /* not found, try next */ }
    }
  }
  let openaiKey = process.env.OPENAI_API_KEY || '';
  let geminiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    // Check user's codebot config
    try {
      const configPath = path.join(process.env.HOME || '', '.codebot', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.apiKey) apiKey = config.apiKey;
      if (config.openaiApiKey) openaiKey = config.openaiApiKey;
      if (config.geminiApiKey) geminiKey = config.geminiApiKey;
    } catch { /* no config */ }
  }
  // Also check .env files for additional keys
  if (!openaiKey || !geminiKey) {
    const envLocations = [
      path.join(process.env.HOME || '', '.codebot', '.env'),
      path.join(app.getPath('userData'), '.env'),
    ];
    for (const envPath of envLocations) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        if (!openaiKey) { const m = envContent.match(/OPENAI_API_KEY=(.+)/); if (m) openaiKey = m[1].trim(); }
        if (!geminiKey) { const m = envContent.match(/GEMINI_API_KEY=(.+)/); if (m) geminiKey = m[1].trim(); }
      } catch { /* not found */ }
    }
  }

  // Prompt user for API key if none found
  if (!apiKey) {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      title: 'CodeBot AI — API Key Required',
      message: 'No Anthropic API key found.',
      detail: 'CodeBot needs a Claude API key to work.\n\nGet one at: console.anthropic.com\n\nPaste your key below or set ANTHROPIC_API_KEY in your environment.',
      buttons: ['Enter Key', 'Open Console', 'Quit'],
      defaultId: 0,
    });
    if (response === 1) {
      shell.openExternal('https://console.anthropic.com');
      // Give them time to get the key, then re-prompt
      const retry = await dialog.showMessageBox({
        type: 'question',
        title: 'CodeBot AI — Enter API Key',
        message: 'Paste your API key after getting it from the console.',
        buttons: ['Enter Key', 'Quit'],
        defaultId: 0,
      });
      if (retry.response === 1) { app.quit(); return false; }
    } else if (response === 2) {
      app.quit();
      return false;
    }
    // Use a simple input prompt via a hidden window trick
    const inputKey = await promptForApiKey();
    if (inputKey) {
      apiKey = inputKey;
      // Save to config for next time
      try {
        const configDir = path.join(process.env.HOME || '', '.codebot');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        const configPath = path.join(configDir, 'config.json');
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        config.apiKey = apiKey;
        config.provider = 'anthropic';
        config.model = 'claude-sonnet-4-6';
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      } catch { /* best effort save */ }
    } else {
      app.quit();
      return false;
    }
  }

  const serverEnv = {
    ...process.env,
    PATH: fullPath,
    CODEBOT_DASHBOARD_PORT: String(DASHBOARD_PORT),
  };
  if (apiKey) {
    serverEnv.ANTHROPIC_API_KEY = apiKey;
    // Also set provider/model so it doesn't try to autodetect local LLMs
    if (!process.env.CODEBOT_MODEL) serverEnv.CODEBOT_MODEL = 'claude-sonnet-4-6';
    if (!process.env.CODEBOT_PROVIDER) serverEnv.CODEBOT_PROVIDER = 'anthropic';
  }
  if (openaiKey) serverEnv.OPENAI_API_KEY = openaiKey;
  if (geminiKey) serverEnv.GEMINI_API_KEY = geminiKey;

  serverProcess = spawn(nodeBin, [binPath, '--dashboard', '--host', '127.0.0.1', '--no-open'], {
    cwd: paths.root,
    env: serverEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    console.log('[server]', data.toString().trim());
  });

  serverProcess.stderr.on('data', (data) => {
    console.error('[server:err]', data.toString().trim());
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err.message);
    dialog.showErrorBox('CodeBot AI', 'Failed to start server: ' + err.message);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log('Server process exited with code', code, 'signal', signal);
    serverProcess = null;
    if (isQuitting) return;

    const now = Date.now();
    if (now - lastCrashTime > CRASH_WINDOW_MS) serverCrashCount = 0;
    serverCrashCount++;
    lastCrashTime = now;

    if (serverCrashCount <= MAX_AUTO_RESTARTS) {
      const delay = Math.min(1000 * Math.pow(2, serverCrashCount - 1), 10000);
      console.log('Auto-restarting server (attempt ' + serverCrashCount + '/' + MAX_AUTO_RESTARTS + ') in ' + delay + 'ms...');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend-status', { status: 'restarting', attempt: serverCrashCount });
      }
      setTimeout(() => {
        startServer().then((ok) => {
          if (ok && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(DASHBOARD_URL);
            mainWindow.webContents.send('backend-status', { status: 'connected' });
          }
        });
      }, delay);
    } else {
      const detail = 'Exit code: ' + (code || 'none') + ', Signal: ' + (signal || 'none') + '\n\nLikely causes: bad API key, missing dependency, or port conflict.';
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        title: 'CodeBot AI',
        message: 'Server crashed ' + serverCrashCount + ' times in the last minute.',
        detail: detail,
        buttons: ['Restart', 'Quit'],
        defaultId: 0,
      });
      serverCrashCount = 0;
      if (choice === 0) {
        startServer().then((ok) => {
          if (ok && mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DASHBOARD_URL);
        });
      } else {
        app.quit();
      }
    }
  });

  // Wait for server to be ready
  try {
    await waitForServer(DASHBOARD_URL, MAX_STARTUP_WAIT);
    console.log('Dashboard server is ready');
    return true;
  } catch (err) {
    dialog.showErrorBox('CodeBot AI',
      'Dashboard server failed to start.\n\n' + err.message +
      '\n\nCheck that your API key is configured in ~/.codebot/config.json');
    app.quit();
    return false;
  }
}

// ── Create Main Window ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 500,
    title: 'CodeBot AI',
    titleBarStyle: 'hiddenInset',  // macOS native title bar with traffic lights
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
    show: true,
  });

  // Load dashboard with retry on network errors
  mainWindow.loadURL(DASHBOARD_URL);

  let loadRetryCount = 0;
  const MAX_LOAD_RETRIES = 8;
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (errorCode === -3) return; // navigation aborted, not an error
    if (errorCode === -6 || errorDescription.includes('ERR_CONNECTION_REFUSED') || errorDescription.includes('ERR_CONNECTION_RESET')) {
      loadRetryCount++;
      if (loadRetryCount <= MAX_LOAD_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, loadRetryCount - 1), 10000);
        console.log('Dashboard load failed (' + errorDescription + '), retry ' + loadRetryCount + '/' + MAX_LOAD_RETRIES + ' in ' + delay + 'ms...');
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DASHBOARD_URL);
        }, delay);
      } else {
        console.error('Dashboard failed to load after ' + MAX_LOAD_RETRIES + ' attempts');
      }
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    loadRetryCount = 0;
    // Force enable text selection and copy/paste in Electron
    mainWindow.webContents.executeJavaScript(`
      document.body.style.webkitUserSelect = 'text';
      document.body.style.userSelect = 'text';
      document.querySelectorAll('.chat-messages, .chat-messages *, .message-content, .message-content *, pre, code, p, span').forEach(el => {
        el.style.webkitUserSelect = 'text';
        el.style.userSelect = 'text';
        el.style.webkitAppRegion = 'no-drag';
      });
      // MutationObserver to fix dynamically added messages
      new MutationObserver((mutations) => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              node.style.webkitUserSelect = 'text';
              node.style.userSelect = 'text';
              node.style.webkitAppRegion = 'no-drag';
              node.querySelectorAll && node.querySelectorAll('*').forEach(child => {
                child.style.webkitUserSelect = 'text';
                child.style.userSelect = 'text';
                child.style.webkitAppRegion = 'no-drag';
              });
            }
          });
        });
      }).observe(document.querySelector('.chat-messages') || document.body, { childList: true, subtree: true });
    `).catch(() => {});
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Handle navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.includes('127.0.0.1') && !url.includes('localhost')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App Menu ──
function createMenu() {
  const template = [
    {
      label: 'CodeBot AI',
      submenu: [
        { label: 'About CodeBot AI', role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'Cmd+,',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"memory\"]')?.click()"
              );
            }
          },
        },
        { type: 'separator' },
        { label: 'Hide CodeBot AI', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit CodeBot AI',
          accelerator: 'Cmd+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'Cmd+N',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript("App.newChat()");
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Chat',
          accelerator: 'Cmd+1',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"chat\"]')?.click()"
              );
            }
          },
        },
        {
          label: 'Sessions',
          accelerator: 'Cmd+2',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"sessions\"]')?.click()"
              );
            }
          },
        },
        {
          label: 'Workflows',
          accelerator: 'Cmd+3',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"workflows\"]')?.click()"
              );
            }
          },
        },
        {
          label: 'Tools',
          accelerator: 'Cmd+4',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"tools\"]')?.click()"
              );
            }
          },
        },
        {
          label: 'Terminal',
          accelerator: 'Cmd+5',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.executeJavaScript(
                "document.querySelector('[data-panel=\"terminal\"]')?.click()"
              );
            }
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com/Ascendral/codebot-ai'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/Ascendral/codebot-ai/issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App Lifecycle ──
app.whenReady().then(async () => {
  createMenu();

  const serverReady = await startServer();
  if (!serverReady) return;

  createWindow();

  // macOS: re-create window when dock icon clicked
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  // Kill the server process
  if (serverProcess) {
    console.log('Stopping dashboard server...');
    serverProcess.kill('SIGTERM');
    // Force kill after 3 seconds
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL');
      }
    }, 3000);
  }
});

// macOS: don't quit when all windows closed (keep in dock)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});


// ── Uncaught Exception Handling ──
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  try {
    dialog.showErrorBox('CodeBot AI — Unexpected Error',
      err.message + '\n\n' + (err.stack || '').split('\n').slice(0, 5).join('\n'));
  } catch { /* dialog may not be available during shutdown */ }
});

process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection:', reason);
});

// ── IPC Handlers ──
const { ipcMain } = require('electron');

ipcMain.handle('get-backend-status', () => {
  return { alive: serverProcess !== null, crashCount: serverCrashCount };
});

ipcMain.handle('restart-backend', async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  }
  serverCrashCount = 0;
  const ok = await startServer();
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(DASHBOARD_URL);
  }
  return ok;
});
