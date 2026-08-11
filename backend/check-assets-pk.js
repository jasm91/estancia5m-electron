const db = require('./db');
(async () => {
  const r = await db.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'media_assets'::regclass AND contype IN ('p','u')
  `);
  console.log('Constraints UNIQUE/PK de media_assets:');
  r.rows.forEach(x => console.log(`  ${x.conname} [${x.contype}]: ${x.def}`));
  process.exit(0);
})();
