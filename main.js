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
  app.quit();
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
      // Interceptar primer close: pedir backup al renderer y luego quitear
      e.preventDefault();
      app.isQuitting = true;
      // Timeout de seguridad: si renderer no responde en 4s, salimos igual
      const forceQuitTimer = setTimeout(() => {
        try { mainWindow.removeAllListeners('close'); } catch(_) {}
        app.quit();
      }, 4000);
      // Pedir al renderer que ejecute backup pre-cierre
      try {
        ipcMain.once('backup:shutdown-done', () => {
          clearTimeout(forceQuitTimer);
          try { mainWindow.removeAllListeners('close'); } catch(_) {}
          app.quit();
        });
        mainWindow.webContents.send('backup:shutdown-request');
      } catch(_) {
        clearTimeout(forceQuitTimer);
        try { mainWindow.removeAllListeners('close'); } catch(_) {}
        app.quit();
      }
    }
  });
}

// ── Menu bar (macOS) + Tray ────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());

  const contextMenu = Menu.buildFromTemplate([
    { label: 'EstanciaPro', enabled: false },
    { type: 'separator' },
    { label: 'Mostrar ventana', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Sincronizar ahora', click: () => triggerSync() },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('EstanciaPro');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });

  // macOS native app menu
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: 'EstanciaPro',
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
// Track update state globally
let _updateDownloaded = false;
let _updateVersion = null;

// Registrar listeners de progreso SIEMPRE (fuera de checkForUpdates)
if (app.isPackaged) {
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoDownload = true;

  autoUpdater.on('download-progress', (progress) => {
    console.log('[Updater] Progreso:', Math.round(progress.percent) + '%', Math.round(progress.bytesPerSecond/1024) + 'KB/s');
    if (mainWindow) mainWindow.webContents.send('update:progress', { percent: Math.round(progress.percent), speed: progress.bytesPerSecond, transferred: progress.transferred, total: progress.total });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Descarga completa:', info.version);
    _updateDownloaded = true;
    _updateVersion = info.version;
    if (mainWindow) mainWindow.webContents.send('update:downloaded', { version: info.version });
  });
}

function checkForUpdates() {
  if (!app.isPackaged) {
    console.log('[Updater] Modo desarrollo — update check omitido');
    return;
  }

  // v1.8.70: el repo de releases es PÚBLICO → NO mandar token. El token hardcodeado/vencido
  // hacía que GitHub respondiera 401 y el auto-update fallara (la app cerraba sin actualizar y no
  // se reabría). Además era un riesgo de seguridad (P-04). Si algún día el repo pasa a privado,
  // se carga un token desde Configuración → Actualizaciones (se guarda en 'gh_token').
  try {
    var _ghTok = store.get('gh_token', '');
    autoUpdater.requestHeaders = _ghTok ? { 'Authorization': 'token ' + _ghTok } : null;
  } catch (e) { autoUpdater.requestHeaders = null; }
  autoUpdater.autoDownload = true;
  autoUpdater.logger = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';

  console.log('[Updater] Verificando actualizaciones... versión actual:', app.getVersion());

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Buscando actualización...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Actualización disponible:', info.version);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] Sin actualizaciones. Versión más reciente:', info.version);
  });
  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    if (mainWindow) mainWindow.webContents.send('update:error', { message: err.message });
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

ipcMain.handle('app:check-update', async () => {
  if (!app.isPackaged) return { status: 'dev', message: 'Modo desarrollo — no se verifican actualizaciones' };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      return { status: result.updateInfo.version !== app.getVersion() ? 'available' : 'current', version: result.updateInfo.version, currentVersion: app.getVersion() };
    }
    return { status: 'current', version: app.getVersion(), currentVersion: app.getVersion() };
  } catch(e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('app:force-update', async () => {
  if (!app.isPackaged) return { status: 'dev', message: 'Modo desarrollo' };
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const result = await autoUpdater.checkForUpdatesAndNotify();
    if (result && result.updateInfo && result.updateInfo.version !== app.getVersion()) {
      return { status: 'downloading', version: result.updateInfo.version };
    }
    return { status: 'current', message: 'Ya tienes la versión más reciente' };
  } catch(e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('app:quit-and-install', () => {
  console.log('[Updater] quitAndInstall called. Downloaded:', _updateDownloaded, 'Version:', _updateVersion);
  if (_updateDownloaded) {
    // Force quit all windows and install
    autoUpdater.autoInstallOnAppQuit = true;
    if (mainWindow) {
      mainWindow.removeAllListeners('close');
      mainWindow.close();
    }
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch(e) {
        console.error('[Updater] quitAndInstall failed:', e);
        // Fallback: relaunch
        app.relaunch();
        app.exit(0);
      }
    }, 1000);
    // Force exit after 5 seconds if quitAndInstall hangs
    setTimeout(() => {
      console.log('[Updater] Force exit after timeout');
      app.exit(0);
    }, 5000);
  }
  return { ok: true, downloaded: _updateDownloaded };
});

ipcMain.handle('app:update-status', () => {
  return { downloaded: _updateDownloaded, version: _updateVersion };
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('app:set-gh-token', (_, token) => {
  if (token) {
    try { store.set('gh_token', token); } catch(e) {}   // v1.8.70: persistir para checkForUpdates (repo privado)
    autoUpdater.requestHeaders = { 'Authorization': 'token ' + token };
    autoUpdater.checkForUpdatesAndNotify();
  } else {
    try { store.set('gh_token', ''); } catch(e) {}
    autoUpdater.requestHeaders = null;
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

// ── Guardar archivo XLSX (usa SheetJS desde renderer) ──────
ipcMain.handle('xlsx:save-as', async (_, { sheetsData, filename }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename || 'plantilla.xlsx',
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (!filePath) return { success: false };
  try {
    // v1.8.76: xlsx-js-style (drop-in de SheetJS que SÍ escribe estilos) para una plantilla profesional.
    const XLSX = require('xlsx-js-style');
    const wb = XLSX.utils.book_new();
    const HEADER_FILL='1B5E20', HEADER_TXT='FFFFFF', BAND='F1F8F4', BORDER='D9D9D9';
    const thin = { style:'thin', color:{ rgb:BORDER } };
    const allBorder = { top:thin, bottom:thin, left:thin, right:thin };
    // sheetsData es un objeto: { 'NombreHoja': [['celda1','celda2'], ...] }
    Object.keys(sheetsData).forEach(name => {
      const aoa = sheetsData[name] || [];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const isCover = /INSTRUC|PORTADA/i.test(name);
      const nRows = aoa.length;
      const nCols = aoa.reduce((m,r)=>Math.max(m,(r||[]).length),0) || 1;

      if (isCover) {
        ws['!cols'] = [{ wch: 100 }];
        for (let r=0; r<nRows; r++) {
          const ref = XLSX.utils.encode_cell({ r, c:0 });
          if (!ws[ref]) continue;
          const txt = (aoa[r] && aoa[r][0] != null) ? String(aoa[r][0]) : '';
          if (r === 0) ws[ref].s = { font:{ bold:true, sz:16, color:{ rgb:HEADER_FILL } } };
          else if (/^Modo de importaci|OBLIGATOR/i.test(txt)) ws[ref].s = { font:{ bold:true, sz:11, color:{ rgb:HEADER_FILL } } };
          else ws[ref].s = { font:{ sz:11, color:{ rgb:'333333' } }, alignment:{ wrapText:true, vertical:'center' } };
        }
        ws['!rows'] = [{ hpt: 28 }];
      } else {
        // anchos por contenido
        const cols = [];
        for (let c=0; c<nCols; c++) {
          let w = 10;
          for (let r=0; r<nRows; r++) { const v=(aoa[r]&&aoa[r][c]!=null)?String(aoa[r][c]):''; if (v.length+2>w) w=v.length+2; }
          cols.push({ wch: Math.min(Math.max(w,10), 42) });
        }
        ws['!cols'] = cols;
        for (let r=0; r<nRows; r++) {
          for (let c=0; c<nCols; c++) {
            const ref = XLSX.utils.encode_cell({ r, c });
            if (!ws[ref]) ws[ref] = { t:'s', v:'' };
            if (r === 0) ws[ref].s = { font:{ bold:true, sz:11, color:{ rgb:HEADER_TXT } }, fill:{ fgColor:{ rgb:HEADER_FILL } }, alignment:{ horizontal:'center', vertical:'center', wrapText:true }, border:allBorder };
            else ws[ref].s = { font:{ sz:10, color:{ rgb:'222222' } }, alignment:{ vertical:'center', wrapText:true }, border:allBorder, fill:{ fgColor:{ rgb:(r%2===0?BAND:'FFFFFF') } } };
          }
        }
        // asegurar que el rango cubra toda la grilla (celdas vacías estilizadas incluidas)
        ws['!ref'] = XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:Math.max(0,nRows-1), c:Math.max(0,nCols-1) } });
        ws['!rows'] = [{ hpt: 22 }];
        if (nRows > 0) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:Math.max(0,nRows-1), c:Math.max(0,nCols-1) } }) };
      }
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel limita 31 chars
    });
    XLSX.writeFile(wb, filePath);
    return { success: true, path: filePath };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

// ── Auto backup silencioso ──────────────────────────────────
function getBackupDir() {
  const path = require('path');
  return path.join(app.getPath('documents'), 'EstanciaPro_Backups');
}

function getLegacyBackupDir() {
  const path = require('path');
  return path.join(app.getPath('documents'), 'Jisunu5M_Backups');
}

ipcMain.handle('backup:auto', async (_, { data, filename }) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const backupDir = getBackupDir();
    const legacyDir = getLegacyBackupDir();
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    // Migración one-time: si existe la carpeta vieja, mover sus backups a la nueva
    try {
      if (fs.existsSync(legacyDir) && legacyDir !== backupDir) {
        const oldFiles = fs.readdirSync(legacyDir).filter(f => f.endsWith('.json'));
        oldFiles.forEach(f => {
          const dest = path.join(backupDir, f);
          if (!fs.existsSync(dest)) {
            try { fs.renameSync(path.join(legacyDir, f), dest); } catch(e) {}
          }
        });
        // Borrar carpeta vieja si quedó vacía
        try { if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir); } catch(e) {}
      }
    } catch(e) { /* migración best-effort */ }
    const filePath = path.join(backupDir, filename);
    fs.writeFileSync(filePath, data, 'utf8');
    // Mantener solo los ultimos 30 backups
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup_estanciapro_') && f.endsWith('.json'))
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
  return getBackupDir();
});
