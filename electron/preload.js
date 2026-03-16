const { contextBridge } = require('electron');

// Expose minimal API to renderer
let version = '2.9.0';
try { version = require('./package.json').version; } catch { /* asar path issue */ }

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  version: version,
});
