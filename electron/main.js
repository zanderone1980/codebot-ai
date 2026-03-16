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
  if (!apiKey) {
    // Check user's codebot config
    try {
      const configPath = path.join(process.env.HOME || '', '.codebot', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.apiKey) apiKey = config.apiKey;
    } catch { /* no config */ }
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

  serverProcess = spawn(nodeBin, [binPath, '--dashboard', '--host', '127.0.0.1'], {
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

  serverProcess.on('exit', (code) => {
    console.log('Server process exited with code', code);
    serverProcess = null;
    if (!isQuitting) {
      // Server crashed — show error and restart option
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        title: 'CodeBot AI',
        message: 'The CodeBot server stopped unexpectedly.',
        buttons: ['Restart', 'Quit'],
        defaultId: 0,
      });
      if (choice === 0) {
        startServer().then(() => {
          if (mainWindow) mainWindow.loadURL(DASHBOARD_URL);
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
    show: false,  // Show after ready-to-show
  });

  // Show window when content is ready (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Load dashboard
  mainWindow.loadURL(DASHBOARD_URL);

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
