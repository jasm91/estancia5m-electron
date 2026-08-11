const db = require('./db');
(async () => {
  const tables = ['conversations','leads','tasks','messages','conversation_notes','media_assets','appointments','handover_requests'];
  console.log('📊 ¿Qué tablas tienen tenant_id?\n');
  for (const t of tables) {
    try {
      const col = await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'",
        [t]
      );
      const exists = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name=$1",[t]);
      if (exists.rows.length === 0) { console.log(`${t.padEnd(22)} (tabla no existe)`); continue; }
      console.log(`${t.padEnd(22)} tenant_id=${col.rows.length>0?'SÍ':'NO ❌'}`);
    } catch(e) { console.log(`${t.padEnd(22)} error: ${e.message.split(chr(10))[0]}`); }
  }
  process.exit(0);
})();
function chr(n){return String.fromCharCode(n);}
