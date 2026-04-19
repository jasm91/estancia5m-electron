# Estancia 5M — Desktop + Mobile
**SG Bolivia** · Sistema de Gestión Ganadera

---

## Estructura del proyecto

```
estancia5m-electron/
├── main.js              ← Electron main process (ventana, tray, sync scheduler)
├── preload.js           ← Bridge seguro renderer ↔ Node.js
├── package.json         ← Dependencias y config de build
├── src/
│   ├── index.html       ← App de escritorio (frontend completo)
│   ├── android-app.html ← App Android (Capacitor)
│   ├── db/
│   │   └── database.js  ← SQLite con better-sqlite3 (todas las tablas)
│   └── sync/
│       └── syncManager.js ← Lógica de sincronización offline→online
└── assets/
    ├── icon.ico         ← Ícono Windows (agregar manualmente)
    └── tray-icon.png    ← Ícono bandeja sistema
```

---

## 🖥️ App de Escritorio macOS (.dmg / .app)

### Requisitos
- Node.js 18+ → https://nodejs.org/en/download
- macOS 10.13 o superior
- Xcode Command Line Tools: `xcode-select --install`

### Pasos

```bash
# 1. Descomprimir el ZIP y entrar a la carpeta
cd ~/Downloads
unzip estancia5m-desktop-mobile.zip
cd estancia5m-electron

# 2. Instalar dependencias
npm install

# 3. Probar en desarrollo (abre la app directamente)
npm run dev

# 4. Compilar .dmg instalable para Mac
npm run build:mac

# El instalador queda en:
#   dist/Estancia 5M-1.0.0.dmg         ← instalar en Mac
#   dist/Estancia 5M-1.0.0-arm64.dmg   ← para Mac con chip Apple Silicon (M1/M2/M3)
#   dist/Estancia 5M-1.0.0-x64.dmg     ← para Mac con Intel
```

### ¿Mac con chip Apple Silicon (M1/M2/M3)?
```bash
# Compilar solo para arm64 (más rápido)
npx electron-builder --mac --arm64
```

### Lo que incluye el .dmg
- ✅ Instalador drag-and-drop a /Applications
- ✅ Ícono en la barra de menú (esquina superior derecha)
- ✅ Base de datos SQLite local (`~/Library/Application Support/estancia5m/estancia5m.db`)
- ✅ Auto-sincronización cada 5 minutos cuando hay internet
- ✅ Funciona 100% offline

### ¿También necesitás el .exe para Windows?
```bash
# Desde Mac también podés compilar para Windows (requiere wine opcionalmente)
npm run build:win
```

### Configuración de sincronización
Al abrir la app, ir a Configuración y pegar:
- **URL del servidor**: `https://tu-api.sgbolivia.com/api`
- **Token de acceso**: (generar desde el panel admin)

---

## 📱 App Android (APK)

### Stack: Capacitor.js
Capacitor convierte el HTML en una APK nativa con acceso a SQLite local.

### Requisitos
- Node.js 18+
- Android Studio (https://developer.android.com/studio)
- JDK 17+

### Pasos

```bash
# 1. Instalar Capacitor
npm install -g @capacitor/cli
npm install @capacitor/core @capacitor/android
npm install @capacitor-community/sqlite

# 2. Inicializar proyecto Android
npx cap init "Estancia5M" "com.sgbolivia.estancia5m" --web-dir="src"
npx cap add android

# 3. Copiar la app
cp src/android-app.html src/index.html  # La app móvil como index

# 4. Sincronizar y abrir Android Studio
npx cap sync android
npx cap open android

# 5. En Android Studio: Build → Generate Signed APK
```

### capacitor.config.json (crear este archivo)
```json
{
  "appId": "com.sgbolivia.estancia5m",
  "appName": "Estancia 5M",
  "webDir": "src",
  "android": {
    "allowMixedContent": true,
    "backgroundColor": "#0D1117"
  },
  "plugins": {
    "CapacitorSQLite": {
      "androidIsEncryption": false,
      "androidBiometric": false
    },
    "SplashScreen": {
      "launchShowDuration": 1500,
      "backgroundColor": "#0D1117",
      "androidSplashResourceName": "splash"
    }
  }
}
```

### Funcionalidades de la app Android (capataz/campo)
| Función | Disponible |
|---|---|
| Ver lotes y estado | ✅ |
| Registrar curación semanal | ✅ |
| Anotar actividad de campo | ✅ |
| Registrar pesaje | ✅ |
| Mover lote de potrero | ✅ |
| Ver stock veterinario | ✅ |
| Resolver alertas | ✅ |
| Funciona sin internet | ✅ |
| Sincroniza al conectarse | ✅ |
| Dashboard financiero | ❌ Solo desktop |
| Registrar ventas/compras | ❌ Solo desktop |
| Trazabilidad | ❌ Solo desktop |
| Gestión de personal | ❌ Solo desktop |

---

## 🔄 Arquitectura de sincronización

```
ANDROID (campo)          DESKTOP (oficina)         SERVIDOR (opcional)
     │                        │                          │
     │  Trabaja offline        │  Trabaja offline         │
     │  Guarda en              │  Guarda en               │
     │  localStorage/SQLite    │  SQLite local            │
     │                        │                          │
     │  ──── WiFi/Datos ────► │  ──── Internet ────────► │
     │  sync_queue[]           │  sync_queue[]            │
     │  (pendingSync[])        │  (mejor-sqlite3)         │
     │                        │                          │
     └── Los cambios del campo llegan al desktop y viceversa ──┘
```

### Flujo offline→online
1. Capataz registra curación en el campo (sin internet)
2. Registro va a `pendingSync[]` / `sync_queue` local
3. Al detectar internet → `syncManager.syncAll()` automático
4. Se hace PUSH de cambios locales al servidor
5. Se hace PULL de cambios del servidor (ventas, nuevos lotes, etc.)
6. Desktop se actualiza con los registros del campo

---

## 📦 Entregables finales

| Archivo | Para quién | Cómo distribuir |
|---|---|---|
| `dist/Estancia 5M Setup 1.0.0.exe` | César (oficina/casa) | USB, email, descarga web |
| `app-release.apk` | Juan Ríos (capataz) | WhatsApp, cable USB |
| API REST (Laravel) | Servidor | VPS Bolivia ($10/mes) |

---

## 💡 Para tu co-founder técnico

### Tiempo estimado de implementación
- App Electron funcional: **3-4 días** (el HTML ya está hecho, falta conectar IPC)
- APK con Capacitor: **2-3 días** (el HTML ya está hecho, agregar plugins)
- API de sincronización: **3-4 días** (el backend Laravel ya está generado)
- **Total: ~2 semanas** incluyendo pruebas

### Dependencias clave
```bash
# Electron app
npm install better-sqlite3 electron-store electron-updater

# Android
npm install @capacitor/core @capacitor/android @capacitor-community/sqlite

# Build
npm install --save-dev electron electron-builder
```

*SG Bolivia — sgbolivia.com*
