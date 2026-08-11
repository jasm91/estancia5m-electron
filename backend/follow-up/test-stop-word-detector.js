/**
 * test-stop-word-detector.js — Tests del detector de stop words
 *
 * Corre con: node test-stop-word-detector.js
 */

const { detectStopWord } = require('./stop-word-detector');

const cases = [
  // Deberían detectar (TRUE)
  { body: 'no me escriban más', expect: true },
  { body: 'No me escriban más por favor', expect: true },
  { body: 'No me escribas más', expect: true },
  { body: 'no me molesten', expect: true },
  { body: 'déjenme en paz', expect: true },
  { body: 'dejame tranquilo', expect: true },
  { body: 'Basta', expect: true },
  { body: 'basta ya', expect: true },
  { body: 'no me interesa nada', expect: true },
  { body: 'No me interesa más', expect: true },
  { body: 'borrame de la lista', expect: true },
  { body: 'sáquenme de su base', expect: true },
  { body: 'unsubscribe', expect: true },
  { body: 'STOP', expect: true },
  { body: 'paren de escribir', expect: true },
  { body: 'ya no me interesa', expect: true },
  { body: 'ya no me interesan sus servicios', expect: true },
  { body: 'no quiero recibir más mensajes', expect: true },
  { body: 'no vuelvan a escribir', expect: true },
  { body: 'ya les dije que no', expect: true },
  { body: 'es spam', expect: true },

  // NO deberían detectar (FALSE)
  { body: 'hola', expect: false },
  { body: 'quiero más información', expect: false },
  { body: 'sí, me interesa', expect: false },
  { body: 'me interesa el producto', expect: false },
  { body: 'no entiendo bien', expect: false },
  { body: 'no he podido revisarlo aún', expect: false },
  { body: 'cuanto cuesta?', expect: false },
  { body: 'gracias por la info', expect: false },
  { body: 'quiero saber más sobre los planes', expect: false },
  { body: 'me molesta el precio', expect: false }, // "molesta" pero NO "me molesten"
  { body: '', expect: false },
  { body: null, expect: false },
];

let pass = 0, fail = 0;
console.log('\n=== Test stop-word detector ===\n');

for (const c of cases) {
  const result = detectStopWord(c.body);
  const detected = result !== null;
  const ok = detected === c.expect;

  if (ok) {
    pass++;
    console.log(`✅ ${c.expect ? 'STOP' : 'OK  '} | "${(c.body || '').slice(0, 50)}"${detected ? ` → matched: ${result.slice(0, 40)}` : ''}`);
  } else {
    fail++;
    console.log(`❌ esperaba ${c.expect ? 'STOP' : 'OK  '}, obtuve ${detected ? 'STOP' : 'OK  '} | "${(c.body || '').slice(0, 60)}"`);
    if (detected) console.log(`   matched: ${result}`);
  }
}

console.log(`\n=== Resultado: ${pass}/${pass + fail} pasaron ===\n`);
process.exit(fail > 0 ? 1 : 0);
