const { contextBridge, ipcRenderer } = require('electron');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Expose safe APIs to renderer (src/index.html)
contextBridge.exposeInMainWorld('estancia', {

  // ── Database ──────────────────────────────────────────────
  db: {
    query: (table, action, data, where) =>
      ipcRenderer.invoke('db:query', { table, action, data, where }),
    raw: (sql) => ipcRenderer.invoke('db:raw', sql),
  },

  // ── Sync ─────────────────────────────────────────────────
  sync: {
    trigger: () => ipcRenderer.invoke('sync:trigger'),
    status: () => ipcRenderer.invoke('sync:status'),
    onStarted: (cb) => ipcRenderer.on('sync:started', cb),
    onCompleted: (cb) => ipcRenderer.on('sync:completed', (_, data) => cb(data)),
    onError: (cb) => ipcRenderer.on('sync:error', (_, msg) => cb(msg)),
  },

  // ── Settings ─────────────────────────────────────────────
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // ── App ──────────────────────────────────────────────────
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    setGhToken: (token) => ipcRenderer.invoke('app:set-gh-token', token),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    forceUpdate: () => ipcRenderer.invoke('app:force-update'),
    quitAndInstall: () => ipcRenderer.invoke('app:quit-and-install'),
    updateStatus: () => ipcRenderer.invoke('app:update-status'),
    restart: () => ipcRenderer.invoke('app:restart'),
    onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_, data) => cb(data)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, data) => cb(data)),
    onUpdateError: (cb) => ipcRenderer.on('update:error', (_, data) => cb(data)),
  },

  // ── Export ───────────────────────────────────────────────
  export: {
    csv: (filename, data) => ipcRenderer.invoke('export:csv', { filename, data }),
    openFolder: (path) => ipcRenderer.invoke('export:openFolder', path),
  },
  backup: {
    auto: (data, filename) => ipcRenderer.invoke('backup:auto', { data, filename }),
    getDir: () => ipcRenderer.invoke('backup:getDir'),
    onShutdownRequest: (cb) => ipcRenderer.on('backup:shutdown-request', () => cb()),
    shutdownDone: () => ipcRenderer.send('backup:shutdown-done'),
  },

  // ── XLSX (SheetJS) — leer y escribir archivos Excel ─────
  xlsx: {
    // Leer archivo Excel desde un ArrayBuffer
    readBuffer: (buffer) => {
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
      const result = {};
      wb.SheetNames.forEach(name => {
        result[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: false });
      });
      return { sheetNames: wb.SheetNames, sheets: result };
    },
    // Generar un xlsx desde un array de hojas y descargarlo
    saveAs: (sheetsData, filename) => {
      return ipcRenderer.invoke('xlsx:save-as', { sheetsData, filename });
    },
  },
});
