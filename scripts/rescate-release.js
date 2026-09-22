#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   RED DE SEGURIDAD DEL UPLOAD (v1.8.229)
   ---------------------------------------------------------------------------
   Subir a GitHub es lo ÚLTIMO que hace electron-builder en un job que tarda
   entre 5 y 30 minutos, y es el tramo que más se cae. Ya van tres:

     v1.8.223  Mac      ⨯ Request timed out         (faltó latest-mac.yml)
     v1.8.224  Windows  ⨯ Request timed out         (.exe a medio subir)
     v1.8.225  Mac      ⨯ 500 "Error saving asset"  (uploads.github.com)
     v1.8.226  Mac      ⨯ colgado en el último zip  (faltó latest-mac.yml)
     v1.8.228  Mac      ⨯ 422 already_exists        (el blockmap del zip con ESPACIOS:
                          GitHub lo guarda con puntos, el "overwrite" borra un nombre
                          que no existe y el re-POST choca. Arreglado con artifactName
                          literal en package.json — sin espacios no hay fantasma)

   Los 500 de uploads.github.com son de GitHub, no nuestros: "Error saving
   asset" y "Error creating asset temp dir". Contra eso sólo sirve reintentar
   —y funciona: en la v1.8.225 los tres archivos que fallaron subieron en el
   segundo intento—. electron-builder no reintenta: se muere en el primero.

   Esto sube lo que haya quedado en dist/ sin reconstruir nada, y después
   TERMINA CON CÓDIGO 1 a propósito: el job tiene que quedar rojo para que se
   mire, aunque el release haya quedado completo.

   Cuatro cosas que este script tiene que hacer bien o hace más daño que bien:

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

   3. Reintentos. Ver arriba: es literalmente la diferencia entre un release
      completo y uno roto.

   5. NO RE-SUBIR LO QUE YA ESTÁ. Se le pregunta al release qué assets tiene y con
      qué tamaño; lo que ya está entero se saltea. Antes se volvían a subir los
      430 MB completos, con más chances de comerse otro 500 y otros 5 minutos.

   4. GENERAR EL latest*.yml SI FALTA. Este es el que nos mordió dos veces sin
      que se notara. electron-builder escribe el latest-mac.yml / latest.yml
      DESPUÉS de subir los binarios; si el publish se corta en el medio, ese
      archivo nunca llega a dist/ y el rescate subía 8 binarios impecables...
      sin el índice que el auto-update lee. El release se veía completo y
      ninguna Mac se enteraba de que había versión nueva. Pasó en la v1.8.223 y
      otra vez en la v1.8.225. Ahora, si falta, se arma acá: es sha512 en
      base64 + tamaño de cada archivo, nada que electron-builder sepa y
      nosotros no.

   Vive acá y no en .github/workflows/ porque tocar el workflow exige un token
   con permiso de Workflows; colgado del `||` de publish:mac / publish:win hace
   exactamente lo mismo.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const EXT = ['.dmg', '.zip', '.exe', '.blockmap'];
/* de los .yml sólo los latest*: builder-debug.yml y builder-effective-config.yaml
   son basura de diagnóstico y no tienen nada que hacer en un release */
const esLatest = (f) => /^latest.*\.yml$/i.test(f);
const DIST = path.join(__dirname, '..', 'dist');
const RESCATE = path.join(DIST, '_rescate');
const REINTENTOS = 3;
const VERSION = require('../package.json').version;

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

/* ── el índice que lee el auto-update ─────────────────────────────────────
   Sin esto el release es un montón de binarios que nadie va a buscar. */
function sha512b64(f) {
  const h = crypto.createHash('sha512');
  h.update(fs.readFileSync(f));
  return h.digest('base64');
}
function entrada(nombreNormalizado, rutaReal) {
  return '  - url: ' + nombreNormalizado + '\n' +
    '    sha512: ' + sha512b64(rutaReal) + '\n' +
    '    size: ' + fs.statSync(rutaReal).size;
}
/* el orden importa poco para electron-updater (elige por arquitectura leyendo
   la url), pero se respeta el de electron-builder: zips primero, x64 antes que
   arm64 — así un diff contra un release sano no muestra ruido */
function ordenMac(a, b) {
  const peso = (n) => (/\.zip$/i.test(n) ? 0 : 10) + (/arm64/i.test(n) ? 1 : 0);
  return peso(a) - peso(b);
}
function generarYml(destino, candidatos, ordenar) {
  const archivos = nombres
    .filter(candidatos)
    .filter((n) => !/\.blockmap$/i.test(n));   /* los blockmap no van en el índice */
  if (!archivos.length) return null;
  archivos.sort(ordenar);
  let cuerpo;
  try {
    cuerpo = archivos.map((n) => entrada(normalizar(n), path.join(DIST, n)));
  } catch (e) {
    console.log('  ✗ no pude hashear para ' + destino + ': ' + e.message);
    return null;
  }
  const primero = normalizar(archivos[0]);
  const txt = 'version: ' + VERSION + '\n' +
    'files:\n' + cuerpo.join('\n') + '\n' +
    'path: ' + primero + '\n' +
    'sha512: ' + sha512b64(path.join(DIST, archivos[0])) + '\n' +
    "releaseDate: '" + new Date().toISOString() + "'\n";
  const ruta = path.join(DIST, destino);
  fs.writeFileSync(ruta, txt);
  nombres.push(destino);
  console.log('  ⚑ ' + destino + ' no estaba (el publish murió antes de escribirlo) — generado acá con ' +
    archivos.length + ' archivo(s)');
  return ruta;
}

const hayMac = nombres.some((n) => /-mac\.zip$/i.test(n) || /\.dmg$/i.test(n));
const hayWin = nombres.some((n) => /\.exe$/i.test(n));
if (hayMac && !nombres.some((n) => /^latest-mac\.yml$/i.test(n))) {
  generarYml('latest-mac.yml', (n) => /-mac\.zip$/i.test(n) || /\.dmg$/i.test(n), ordenMac);
}
if (hayWin && !nombres.some((n) => /^latest\.yml$/i.test(n))) {
  generarYml('latest.yml', (n) => /\.exe$/i.test(n), (a, b) => a.localeCompare(b));
}

const tag = process.env.GITHUB_REF_NAME || ('v' + VERSION);
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

/* qué tiene ya el release (nombre → tamaño). Si no se puede consultar, se sube todo. */
function yaSubidos() {
  const out = {};
  try {
    const cands = process.platform === 'win32' ? ['gh', 'gh.exe'] : ['gh'];
    for (const bin of cands) {
      const r = spawnSync(bin, ['release', 'view', tag, '--json', 'assets'], { encoding: 'utf8', shell: false });
      if (r.error) { if (r.error.code === 'ENOENT') continue; break; }
      if (r.status !== 0 || !r.stdout) break;
      const j = JSON.parse(r.stdout);
      (j.assets || []).forEach((a) => { if (a && a.name) out[a.name] = Number(a.size) || 0; });
      break;
    }
  } catch (e) {}
  return out;
}
const arriba = yaSubidos();
const nArriba = Object.keys(arriba).length;
if (nArriba) console.log('El release ya tiene ' + nArriba + ' asset(s): se sube sólo lo que falta o quedó a medias.');

/* uno por uno: si uno se cae, los demás igual suben. Con reintentos, que para
   eso está — lo que falla es la red o GitHub, no el archivo.
   Los latest*.yml van AL FINAL: si un binario no logra subir, es preferible que
   el índice ni exista a que apunte a una URL que da 404. */
const orden = subir.slice().sort((a, b) => (esLatest(path.basename(a)) ? 1 : 0) - (esLatest(path.basename(b)) ? 1 : 0));
let fallados = [];
let salteados = 0;
orden.forEach((f) => {
  const nombre = path.basename(f);
  /* ya está, y entero: no se toca. Los latest*.yml se suben siempre (son chicos y
     pueden haber cambiado) */
  if (!esLatest(nombre) && arriba[nombre] != null) {
    let local = 0; try { local = fs.statSync(f).size; } catch (e) {}
    if (local && arriba[nombre] === local) { salteados++; console.log('   = ' + nombre + ' (ya estaba, ' + kb(f) + ' KB)'); return; }
    console.log('   ~ ' + nombre + ' está a medias arriba (' + Math.round(arriba[nombre] / 1024) + ' KB de ' + kb(f) + '): se reemplaza');
  }
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
salir('\n✅ ' + (subir.length - salteados) + ' asset(s) subidos' + (salteados ? ' (' + salteados + ' ya estaban)' : '') + ': el release quedó completo SIN rebuildear.' +
  '\n   El job igual queda rojo a propósito — revisá por qué se cortó el publish.');
