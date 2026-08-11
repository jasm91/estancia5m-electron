#!/usr/bin/env node
/**
 * derive-xpub.js — saca la XPUB de tu wallet SIN que la semilla salga de tu máquina.
 * ---------------------------------------------------------------------------
 * ESTO NO CORRE EN EL SERVIDOR. Se corre UNA sola vez, en tu computadora.
 *
 * Qué hace: le das tus 12 (o 24) palabras y te devuelve la clave pública
 * extendida — la "xpub" — de la cuenta m/44'/60'/0', que es la ruta estándar
 * que usa MetaMask. Esa xpub es lo único que va a Railway.
 *
 * Por qué es seguro: una xpub puede CALCULAR direcciones, pero no puede FIRMAR.
 * Aunque se filtre entera, con ella no se mueve un solo dólar. Es la diferencia
 * entre el número de tu cuenta bancaria (que repartís) y tu clave (que no).
 *
 * Este script NO abre ninguna conexión de red. No manda nada a ningún lado.
 * Si querés estar 100% tranquilo, apagá el wifi antes de correrlo: va a andar
 * exactamente igual.
 *
 * USO:
 *   cd backend
 *   npm install ethers          (si todavía no está)
 *   node derive-xpub.js
 *
 * Después:
 *   1. Copiás la xpub que imprime y la cargás en Railway como USDT_XPUB.
 *   2. BORRÁS de la terminal lo que pegaste (o cerrás la ventana).
 *   3. Las 12 palabras vuelven al papel donde estaban. No las guardes en archivos.
 */
const readline = require('readline');

function ask(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pregunta, (r) => { rl.close(); resolve(r); }));
}

(async () => {
  let ethers;
  try { ({ ethers } = require('ethers')); }
  catch (e) {
    console.error('\n❌ Falta la librería. Corré primero:  npm install ethers\n');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  XPUB para cobros USDT — SG Ventas');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n  Este script no se conecta a internet. Tus palabras no salen');
  console.log('  de esta computadora. Podés desconectar el wifi si querés.\n');

  const frase = (await ask('  Pegá tus 12 o 24 palabras (separadas por espacios):\n  > ')).trim().replace(/\s+/g, ' ');
  if (!frase) { console.error('\n❌ No pegaste nada.\n'); process.exit(1); }

  const palabras = frase.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(palabras)) {
    console.error(`\n❌ Contaste ${palabras} palabras. Una frase válida tiene 12, 15, 18, 21 o 24.\n`);
    process.exit(1);
  }

  let cuenta;
  try {
    // m/44'/60'/0' = la cuenta estándar de MetaMask. Las direcciones que use el
    // panel van a ser 0/0, 0/1, 0/2… o sea "Cuenta 1", "Cuenta 2", "Cuenta 3".
    cuenta = ethers.HDNodeWallet.fromPhrase(frase, '', "m/44'/60'/0'");
  } catch (e) {
    console.error('\n❌ Esa frase no es válida (¿alguna palabra mal escrita?): ' + e.message + '\n');
    process.exit(1);
  }

  const xpub = cuenta.neuter().extendedKey;
  const vista = ethers.HDNodeWallet.fromExtendedKey(xpub);

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  ✅ Tu XPUB (esto SÍ va a Railway, como USDT_XPUB):\n');
  console.log('  ' + xpub);
  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  Verificá que estas direcciones sean las que ves en MetaMask.');
  console.log('  Si coinciden, la xpub es correcta:\n');
  for (let i = 0; i < 4; i++) {
    const etiqueta = i === 0 ? 'Cuenta 1  (tu cuenta operativa, la del gas)' : `Cuenta ${i + 1}  (cliente #${i})`;
    console.log(`    ${etiqueta.padEnd(44)} ${vista.derivePath('0/' + i).address}`);
  }
  console.log('\n  Si NO coinciden, no cargues la xpub: avisame antes de seguir.');
  console.log('───────────────────────────────────────────────────────────');
  console.log('\n  Ahora cerrá esta terminal para no dejar la frase en el historial.\n');
})();
