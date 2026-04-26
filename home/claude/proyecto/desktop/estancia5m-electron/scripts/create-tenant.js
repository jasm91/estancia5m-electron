// Uso: node scripts/create-tenant.js
// Crea un nuevo cliente en Railway con su token unico

const API_URL  = process.env.API_URL  || 'https://estancia5m-api-production.up.railway.app';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'sgbolivia-admin-2026';

const crypto = require('crypto');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q = (txt) => new Promise(r => rl.question(txt, r));

async function main() {
  console.log('\n=== Crear nuevo cliente Jisunu5M ===\n');
  const name  = await q('Nombre del cliente/estancia: ');
  const plan  = await q('Plan (standard/premium): ') || 'standard';
  const notes = await q('Notas adicionales: ');

  // Generar token unico para este cliente
  const token = 'jisunu-' + crypto.randomBytes(8).toString('hex');

  console.log(`\nToken generado: ${token}`);
  const confirm = await q('Confirmar creacion? (s/n): ');
  if (confirm.toLowerCase() !== 's') { console.log('Cancelado.'); rl.close(); return; }

  const res = await fetch(`${API_URL}/api/admin/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ name, token, plan, notes })
  });
  const data = await res.json();
  if (!res.ok) { console.error('Error:', data); rl.close(); return; }

  console.log('\n=== Cliente creado exitosamente ===');
  console.log(`ID:    ${data.tenant.id}`);
  console.log(`Nombre: ${data.tenant.name}`);
  console.log(`Plan:   ${data.tenant.plan}`);
  console.log(`\nTOKEN DEL CLIENTE (guardar y compartir):`);
  console.log(`  ${token}`);
  console.log('\nInstrucciones para el cliente:');
  console.log(`  1. Instalar la app Jisunu5M en su PC`);
  console.log(`  2. Ir a Configuracion > Servidor`);
  console.log(`  3. URL: ${API_URL}/api`);
  console.log(`  4. Token: ${token}`);
  console.log(`  5. Guardar y sincronizar\n`);
  rl.close();
}
main().catch(e => { console.error(e); rl.close(); });
