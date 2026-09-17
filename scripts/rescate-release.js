#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   RED DE SEGURIDAD DEL UPLOAD (v1.8.225)
   ---------------------------------------------------------------------------
   Subir a GitHub es lo ÚLTIMO que hace electron-builder en un job que tarda
   entre 20 y 30 minutos, y es el tramo que más se cae:

     ⨯ Request timed out  failedTask=build
       at TLSSocket.<anonymous> (builder-util-runtime/src/httpExecutor.ts:352)

   Pasó en la v1.8.223 (Mac, faltó latest-mac.yml) y otra vez en la v1.8.224
   (Windows, a los 20m50s con el .exe a medio subir). Sin esos archivos el
   auto-update no ve la versión nueva, y la única salida era rebuildear.

   Esto sube lo que haya quedado en dist/ sin reconstruir nada, y después
   TERMINA CON CÓDIGO 1 a propósito: el job tiene que quedar rojo para que se
   mire, aunque el release haya quedado completo.

   Dos cosas que este script tiene que hacer bien o hace más daño que bien:

   1. NADA de `shell: true`. En Windows el archivo se llama
      "Estancia Pro Setup 1.8.224.exe" —con espacios— y cmd vuelve a partir el
      argumento: `no matches found for D:\...\dist\Estancia`. Se pasa el array
      directo al proceso, sin shell de por medio.

   2. Los nombres se NORMALIZAN antes de subir. electron-builder publica
      "Estancia-Pro-Setup-1.8.224.exe" (con guiones) y eso es lo que referencia
      latest.yml, pero el archivo en disco tiene espacios. Subirlo tal cual
      daría un asset llamado "Estancia.Pro.Setup.1.8.224.exe" —GitHub convierte
      los espacios en puntos— que NO matchea el latest.yml: el auto-update
      pediría una URL que da 404. Por eso se copia a dist/_rescate/ con el
      nombre ya normalizado y se sube desde ahí.

   Vive acá y no en .github/workflows/ porque tocar el workflow exige un token
   con permiso de Workflows; colgado del `||` de publish:mac / publish:win hace
   exactamente lo mismo.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const EXT = ['.dmg', '.zip', '.exe', '.blockmap'];
/* de los .yml sólo los latest*: builder-debug.yml y builder-effective-config.yaml
   son basura de diagnóstico y no tienen nada que hacer en un release */
const esLatest = (f) => /^latest.*\.yml$/i.test(f);
const DIST = path.join(__dirname, '..', 'dist');
const RESCATE = path.join(DIST, '_rescate');
const REINTENTOS = 3;

function salir(msg) {
  if (msg) console.log(msg);
  /* SIEMPRE 1: el publish falló, el job tiene que verse rojo */
  process.exit(1);
}
function kb(f) { try { return Math.round(fs.statSync(f).size / 1024); } catch (e) { return 0; } }
/* electron-builder reemplaza los espacios por guiones en el nombre publicado */
function normalizar(n) { return n.replace(/ /g, '-'); }

console.log('\n══ el publish se cortó — rescatando lo que quedó en dist/ ══');

if (!fs.existsSync(DIST)) salir('dist/ no existe: el build se cortó antes de generar nada, no hay qué rescatar.');

/* sólo lo de la raíz de dist/: adentro de mac/ y win-unpacked/ está la app sin empaquetar */
let nombres = [];
try {
  nombres = fs.readdirSync(DIST)
    .filter((f) => EXT.indexOf(path.extname(f).toLowerCase()) >= 0 || esLatest(f))
    .filter((f) => { try { return fs.statSync(path.join(DIST, f)).isFile(); } catch (e) { return false; } });
} catch (e) {
  salir('No se pudo leer dist/: ' + e.message);
}
if (!nombres.length) salir('dist/ no tiene artefactos publicables, no hay qué rescatar.');

const tag = process.env.GITHUB_REF_NAME || ('v' + require('../package.json').version);
console.log('Release: ' + tag);

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  nombres.forEach((n) => console.log('  · ' + n + ' (' + kb(path.join(DIST, n)) + ' KB)'));
  salir('Sin GH_TOKEN en el entorno: no puedo subir nada. (Fuera de CI esto es normal.)');
}

/* copiar con el nombre normalizado */
try { fs.mkdirSync(RESCATE, { recursive: true }); } catch (e) { salir('No pude crear ' + RESCATE + ': ' + e.message); }
const subir = [];
nombres.forEach((n) => {
  const org = path.join(DIST, n);
  const nn = normalizar(n);
  const dst = path.join(RESCATE, nn);
  try {
    fs.copyFileSync(org, dst);
    subir.push(dst);
    console.log('  · ' + nn + ' (' + kb(dst) + ' KB)' + (nn !== n ? '   ← renombrado, tenía espacios' : ''));
  } catch (e) {
    console.log('  ✗ ' + n + ': no se pudo preparar (' + e.message + ')');
  }
});
if (!subir.length) salir('No quedó ningún archivo listo para subir.');

/* gh: sin shell, y en Windows probando también gh.exe */
function gh(args) {
  const cands = process.platform === 'win32' ? ['gh', 'gh.exe'] : ['gh'];
  let ultimo = null;
  for (const bin of cands) {
    const r = spawnSync(bin, args, { stdio: 'inherit', shell: false });
    if (!r.error) return r;
    ultimo = r.error;
    if (r.error.code !== 'ENOENT') break;
  }
  return { status: -1, error: ultimo };
}

/* uno por uno: si uno se cae, los demás igual suben. Con reintentos, que para
   eso está — lo que falla es la red, no el archivo. */
let fallados = [];
subir.forEach((f) => {
  const nombre = path.basename(f);
  let ok = false;
  for (let i = 1; i <= REINTENTOS && !ok; i++) {
    if (i > 1) console.log('   reintento ' + i + '/' + REINTENTOS + ' de ' + nombre);
    const r = gh(['release', 'upload', tag, f, '--clobber']);
    if (r.error) { console.log('   ✗ no se pudo ejecutar gh: ' + r.error.message); break; }
    if (r.status === 0) ok = true;
  }
  if (ok) console.log('   ✔ ' + nombre);
  else { fallados.push(nombre); console.log('   ✗ ' + nombre); }
});

try { fs.rmSync(RESCATE, { recursive: true, force: true }); } catch (e) {}

if (fallados.length) {
  salir('\n⚠ Quedaron sin subir: ' + fallados.join(', ') +
    '\n  El release está INCOMPLETO. Revisá el job antes de anunciar la versión.');
}
salir('\n✅ ' + subir.length + ' asset(s) subidos: el release quedó completo SIN rebuildear.' +
  '\n   El job igual queda rojo a propósito — revisá por qué se cortó el publish.');
