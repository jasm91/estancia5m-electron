const { contextBridge, ipcRenderer } = require('electron');

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
  },

  // ── Export ───────────────────────────────────────────────
  export: {
    csv: (filename, data) => ipcRenderer.invoke('export:csv', { filename, data }),
    openFolder: (path) => ipcRenderer.invoke('export:openFolder', path),
  },
  backup: {
    auto: (data, filename) => ipcRenderer.invoke('backup:auto', { data, filename }),
    getDir: () => ipcRenderer.invoke('backup:getDir'),
  },
});
