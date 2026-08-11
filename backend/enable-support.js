/**
 * Prende (o apaga) la Mesa de Soporte (BPO) en UN tenant y le asegura sus
 * categorías por defecto. Más seguro que un UPDATE a mano (no te podés olvidar
 * el WHERE y encender TODOS los tenants, incl. clientes reales).
 *
 * Uso:
 *   node enable-support.js <tenant_id>        # PRENDE la mesa en ese tenant
 *   node enable-support.js <tenant_id> off    # la APAGA
 *
 * Local (contra la DB de prod):
 *   DATABASE_URL=<prod_database_url> node enable-support.js 1
 * En Railway (Console del servicio sg-ventas, DATABASE_URL ya en el env):
 *   node enable-support.js 1
 *
 * OJO: al prender la mesa, TODAS las conversaciones de ese tenant pasan a soporte
 * (operación de soporte pura, tipo Yango). El bot responde igual; solo se agrega
 * la capa de tickets. Por eso conviene un tenant dedicado (p.ej. 1 = SG Bolivia
 * para dogfood), NO uno que esté vendiendo en serio. Es reversible (... off).
 */
const db = require('./db');

const DEFAULT_CATEGORIES = [
  ['horario',       'Horarios',         'auto',     30, 240,  1],
  ['ubicacion',     'Ubicación',        'auto',     30, 240,  2],
  ['estado_pedido', 'Estado de pedido', 'auto',     20, 180,  3],
  ['facturacion',   'Facturación',      'suggest',  30, 240,  4],
  ['reembolso',     'Reembolso',        'escalate', 15, 120,  5],
  ['reclamo',       'Reclamo',          'escalate', 10,  90,  6],
  ['otro',          'Otro',             'escalate', 30, 240, 99],
];

async function main() {
  const id = parseInt(process.argv[2], 10);
  const off = String(process.argv[3] || '').toLowerCase() === 'off';
  if (!id) {
    console.error('Uso: node enable-support.js <tenant_id> [off]');
    process.exit(1);
  }
  const t = await db.query('SELECT id, name FROM tenants WHERE id = $1', [id]);
  if (!t.rows[0]) { console.error(`❌ No existe el tenant ${id}`); process.exit(1); }
  const name = t.rows[0].name;

  await db.query('UPDATE tenants SET support_enabled = $2 WHERE id = $1', [id, !off]);

  if (off) {
    console.log(`🔌 Mesa de soporte APAGADA en tenant ${id} (${name}). Las convos vuelven a comportarse como venta.`);
    console.log('   (Las que ya están en plane=soporte siguen así; si querés revertir el plano: UPDATE conversations SET plane=\'venta\' WHERE tenant_id=' + id + ';)');
    process.exit(0);
  }

  let seeded = 0;
  for (const [key, label, autonomy, sla1, sla2, ord] of DEFAULT_CATEGORIES) {
    const r = await db.query(
      `INSERT INTO support_categories
         (tenant_id, key, label, autonomy, sla_first_response_min, sla_resolution_min, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [id, key, label, autonomy, sla1, sla2, ord]
    );
    seeded += r.rowCount;
  }
  console.log(`✅ Mesa de soporte PRENDIDA en tenant ${id} (${name}). Categorías nuevas sembradas: ${seeded} (${DEFAULT_CATEGORIES.length} en total).`);
  console.log('   Desde ahora: cada inbound de ese tenant crea/actualiza ticket, setea la ventana de 24h y registra la 1ª respuesta humana.');
  console.log('   Probá en vivo: mandá un WhatsApp al número del tenant y mirá la barra de ticket + el dashboard en Reportes 📊.');
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
