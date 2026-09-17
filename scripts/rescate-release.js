#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   RED DE SEGURIDAD DEL UPLOAD (v1.8.224)
   ---------------------------------------------------------------------------
   Subir a GitHub es lo ÚLTIMO que hace electron-builder en un job que tarda
   ~30 minutos, y es el tramo que más se cae:

     ⨯ Request timed out  failedTask=build
       at TLSSocket.<anonymous> (builder-util-runtime/src/httpExecutor.ts:352)

   Cuando se cortó en la v1.8.223 los .dmg y .zip ya estaban arriba y lo único
   que faltó fue latest-mac.yml — 400 bytes. Sin ese archivo el auto-update de
   Mac no ve la versión nueva, y la única salida era rebuildear y renotarizar
   otros 30 minutos.

   Esto sube lo que haya quedado en dist/ sin reconstruir nada, y después
   TERMINA CON CÓDIGO 1 a propósito: el job tiene que quedar rojo para que se
   mire, aunque el release haya quedado completo.

   Vive acá y no en el workflow porque modificar .github/workflows/ necesita un
   token con permiso de Workflows; esto se cuelga del `||` de publish:mac /
   publish:win en package.json y hace exactamente lo mismo.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXT = ['.dmg', '.zip', '.exe', '.blockmap'];
/* de los .yml sólo los latest*: builder-debug.yml y builder-effective-config.yaml
   son basura de diagnóstico y no tienen nada que hacer en un release */
const esLatest = (f) => /^latest.*\.yml$/i.test(f);
const DIST = path.join(__dirname, '..', 'dist');

function salir(codigo, msg) {
  if (msg) console.log(msg);
  /* siempre 1: el publish falló, el job tiene que verse rojo */
  process.exit(codigo);
}

console.log('\n══ el publish se cortó — intentando rescatar lo que quedó en dist/ ══');

if (!fs.existsSync(DIST)) {
  salir(1, 'dist/ no existe: el build se cortó antes de generar nada, no hay qué rescatar.');
}

/* sólo lo de la raíz de dist/: adentro de mac/ y win-unpacked/ está el .app sin empaquetar */
let archivos = [];
try {
  archivos = fs.readdirSync(DIST)
    .filter((f) => EXT.indexOf(path.extname(f).toLowerCase()) >= 0 || esLatest(f))
    .filter((f) => { try { return fs.statSync(path.join(DIST, f)).isFile(); } catch (e) { return false; } })
    .map((f) => path.join(DIST, f));
} catch (e) {
  salir(1, 'No se pudo leer dist/: ' + e.message);
}

if (!archivos.length) salir(1, 'dist/ está vacío de artefactos publicables, no hay qué rescatar.');

const tag = process.env.GITHUB_REF_NAME || ('v' + require('../package.json').version);
console.log('Release: ' + tag);
archivos.forEach((f) => {
  let kb = 0; try { kb = Math.round(fs.statSync(f).size / 1024); } catch (e) {}
  console.log('  · ' + path.basename(f) + ' (' + kb + ' KB)');
});

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  salir(1, 'Sin GH_TOKEN en el entorno: no puedo subir nada. (Fuera de CI esto es normal.)');
}

const r = spawnSync('gh', ['release', 'upload', tag].concat(archivos).concat(['--clobber']), {
  stdio: 'inherit',
  shell: process.platform === 'win32'   /* en windows-latest gh es un .cmd */
});

if (r.error) salir(1, 'No se pudo ejecutar gh: ' + r.error.message);
if (r.status !== 0) salir(1, '\ngh terminó con código ' + r.status + ' — el release quedó incompleto.');

salir(1, '\n✅ Assets subidos: el release quedó completo SIN rebuildear.\n' +
  '   El job igual queda rojo a propósito — revisá por qué se cortó el publish.');
