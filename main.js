const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const db = require('./src/db/database');
const sync = require('./src/sync/syncManager');

const store = new Store();
let mainWindow;
let tray;
let syncInterval;

// ── App lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  db.initialize();
  createWindow();
  createTray();
  startSyncScheduler();
  checkForUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (syncInterval) clearInterval(syncInterval);
});

// ── Main window ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Estancia 5M — Sistema de Gestión',
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // Allow inline scripts (needed for onclick handlers in HTML)
    backgroundColor: '#0D1117',
    titleBarStyle: 'default',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  // Allow all inline scripts — required for onclick handlers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:"]
      }
    });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.openDevTools(); // debug
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Menu bar (macOS) + Tray ────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Estancia 5M', enabled: false },
    { type: 'separator' },
    { label: 'Mostrar ventana', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Sincronizar ahora', click: () => triggerSync() },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Estancia 5M');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });

  // macOS native app menu
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: 'Estancia 5M',
        submenu: [
          { label: 'Acerca de Estancia 5M', role: 'about' },
          { type: 'separator' },
          { label: 'Sincronizar', click: () => triggerSync(), accelerator: 'Cmd+S' },
          { type: 'separator' },
          { label: 'Ocultar', role: 'hide' },
          { label: 'Ocultar otras', role: 'hideOthers' },
          { type: 'separator' },
          { label: 'Salir', role: 'quit', accelerator: 'Cmd+Q' },
        ],
      },
      {
        label: 'Edición',
        submenu: [
          { role: 'undo', label: 'Deshacer' },
          { role: 'redo', label: 'Rehacer' },
          { type: 'separator' },
          { role: 'cut', label: 'Cortar' },
          { role: 'copy', label: 'Copiar' },
          { role: 'paste', label: 'Pegar' },
          { role: 'selectAll', label: 'Seleccionar todo' },
        ],
      },
      {
        label: 'Ver',
        submenu: [
          { role: 'reload', label: 'Recargar' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Pantalla completa' },
          { role: 'zoomIn', label: 'Acercar' },
          { role: 'zoomOut', label: 'Alejar' },
          { role: 'resetZoom', label: 'Tamaño original' },
        ],
      },
      {
        label: 'Ventana',
        submenu: [
          { role: 'minimize', label: 'Minimizar', accelerator: 'Cmd+M' },
          { role: 'zoom', label: 'Zoom' },
          { type: 'separator' },
          { role: 'front', label: 'Traer al frente' },
        ],
      },
    ]);
    Menu.setApplicationMenu(appMenu);
  }
}

// ── Auto sync scheduler (every 5 minutes when online) ─────────
function startSyncScheduler() {
  syncInterval = setInterval(async () => {
    const online = await checkOnline();
    if (online) triggerSync();
  }, 5 * 60 * 1000); // 5 minutes
}

async function triggerSync() {
  try {
    mainWindow?.webContents.send('sync:started');
    const result = await sync.syncAll();
    mainWindow?.webContents.send('sync:completed', result);
    store.set('lastSync', new Date().toISOString());
    tray?.setToolTip(`Estancia 5M — Último sync: ${new Date().toLocaleTimeString('es-BO')}`);
  } catch (err) {
    mainWindow?.webContents.send('sync:error', err.message);
  }
}

async function checkOnline() {
  try {
    const fetch = (await import('node-fetch')).default;
    const apiUrl = store.get('apiUrl', '');
    if (!apiUrl) return false;
    const res = await fetch(apiUrl + '/ping', { timeout: 3000 });
    return res.ok;
  } catch { return false; }
}

// ── Auto updater ───────────────────────────────────────────────
function checkForUpdates() {
  // El auto-updater solo funciona en app empaquetada, no en desarrollo
  if (!app.isPackaged) {
    console.log('[Updater] Modo desarrollo — update check omitido');
    return;
  }

  // Registrar listeners siempre (antes de verificar token)
  autoUpdater.removeAllListeners();

  // Token para repo privado de GitHub
  var ghToken = store.get('github_token', '');
  if (!ghToken) { console.log('[Updater] No hay GitHub token'); return; }
  autoUpdater.requestHeaders = { 'Authorization': 'token ' + ghToken };
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'jasm91',
    repo: 'estancia5m-electron',
    private: true,
    token: ghToken
  });
  autoUpdater.autoDownload = true;
  autoUpdater.logger = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';

  console.log('[Updater] Verificando actualizaciones... versión actual:', app.getVersion());

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Buscando actualización...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Actualización disponible:', info.version, '— descargando en segundo plano...');
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] Sin actualizaciones. Versión más reciente:', info.version);
  });
  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Descarga completa:', info.version);
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Actualización lista',
      message: 'La versión ' + info.version + ' está lista. ¿Reiniciar ahora para instalar?',
      buttons: ['Reiniciar', 'Más tarde'],
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.checkForUpdates();
}

// ── IPC Handlers — bridge between renderer and main ───────────
// DATABASE OPERATIONS
ipcMain.handle('db:query', (_, { table, action, data, where }) => {
  return db.query(table, action, data, where);
});

ipcMain.handle('db:raw', (_, sql) => {
  return db.raw(sql);
});

// SYNC
ipcMain.handle('sync:trigger', async () => {
  const online = await checkOnline();
  if (!online) return { success: false, message: 'Sin conexión a internet' };
  await triggerSync();
  return { success: true };
});

ipcMain.handle('sync:status', async () => {
  const online = await checkOnline();
  return {
    online,
    lastSync: store.get('lastSync', null),
    pendingChanges: db.getPendingChangesCount(),
  };
});

// SETTINGS
ipcMain.handle('settings:get', (_, key) => store.get(key));
ipcMain.handle('settings:set', (_, key, value) => { store.set(key, value); return true; });
ipcMain.handle('settings:getAll', () => store.store);

// APP INFO
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:set-gh-token', (_, token) => {
  if (token) {
    store.set('github_token', token);
    if (app.isPackaged) checkForUpdates();
  }
  return true;
});
ipcMain.handle('app:openExternal', (_, url) => shell.openExternal(url));

// EXPORT
ipcMain.handle('export:csv', async (_, { filename, data }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { success: false };
  const fs = require('fs');
  fs.writeFileSync(filePath, data, 'utf8');
  return { success: true, path: filePath };
});

ipcMain.handle('export:openFolder', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── Auto backup silencioso ──────────────────────────────────
ipcMain.handle('backup:auto', async (_, { data, filename }) => {
  try {
    const fs = require('fs');
    const path = require('path');
    // Carpeta de backups: Documents/Jisunu5M_Backups
    const docsPath = app.getPath('documents');
    const backupDir = path.join(docsPath, 'Jisunu5M_Backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const filePath = path.join(backupDir, filename);
    fs.writeFileSync(filePath, data, 'utf8');
    // Mantener solo los ultimos 30 backups
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup_jisunu5m_') && f.endsWith('.json'))
      .sort().reverse();
    if (files.length > 30) {
      files.slice(30).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f)); } catch(e) {}
      });
    }
    return { success: true, path: filePath, dir: backupDir };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('backup:getDir', () => {
  const path = require('path');
  return path.join(app.getPath('documents'), 'Jisunu5M_Backups');
});
