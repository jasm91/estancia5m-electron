const db = require('../db/database');
const Store = require('electron-store');
const store = new Store();

// Table mapping: local table → API endpoint
const TABLE_ENDPOINTS = {
  lots:                 '/lots',
  vet_products:         '/vet-products',
  treatments:           '/treatments',
  health_alerts:        '/health-alerts',
  sales:                '/sales',
  purchases:            '/purchases',
  employees:            '/employees',
  field_activities:     '/field-activities',
  traceability_records: '/traceability',
  weight_records:       '/weight-records',
  lot_movements:        '/lot-movements',
};

async function syncAll() {
  const fetch = (await import('node-fetch')).default;
  const apiUrl = store.get('apiUrl', '') || 'https://estancia5m-api-production.up.railway.app/api';
  const apiToken = store.get('apiToken', '') || 'estancia5m-2026-secreto';

  if (!apiUrl) return { pushed: 0, pulled: 0, errors: [] };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
    'X-Device': 'desktop',
  };

  const results = { pushed: 0, pulled: 0, errors: [] };

  // ── PUSH: send local changes to server ─────────────────────
  const pending = db.getPendingChanges();

  for (const change of pending) {
    const endpoint = TABLE_ENDPOINTS[change.table_name];
    if (!endpoint) continue;

    try {
      const payload = JSON.parse(change.payload);
      let res;

      if (change.action === 'insert') {
        res = await fetch(`${apiUrl}${endpoint}`, {
          method: 'POST', headers, body: JSON.stringify(payload),
        });
      } else if (change.action === 'update') {
        const record = db.query(change.table_name, 'selectOne', {}, { id: change.record_id });
        const serverId = record?.server_id;
        if (!serverId) continue; // not yet pushed
        res = await fetch(`${apiUrl}${endpoint}/${serverId}`, {
          method: 'PUT', headers, body: JSON.stringify(payload),
        });
      } else if (change.action === 'delete') {
        const record = db.query(change.table_name, 'selectOne', {}, { id: change.record_id });
        const serverId = record?.server_id;
        if (!serverId) {
          db.markSynced([change.id], change.table_name, change.record_id, null);
          continue;
        }
        res = await fetch(`${apiUrl}${endpoint}/${serverId}`, { method: 'DELETE', headers });
      }

      if (res && (res.ok || res.status === 404)) {
        const serverData = res.ok ? await res.json() : null;
        db.markSynced([change.id], change.table_name, change.record_id, serverData?.id || null);
        results.pushed++;
      } else {
        results.errors.push(`${change.table_name}#${change.record_id}: HTTP ${res?.status}`);
      }
    } catch (err) {
      results.errors.push(`${change.table_name}#${change.record_id}: ${err.message}`);
    }
  }

  // ── PULL: fetch updates from server ────────────────────────
  try {
    const lastSync = store.get('lastSync', '2020-01-01T00:00:00Z');

    for (const [table, endpoint] of Object.entries(TABLE_ENDPOINTS)) {
      try {
        const res = await fetch(`${apiUrl}${endpoint}?updated_since=${lastSync}`, { headers });
        if (!res.ok) continue;

        const serverRecords = await res.json();
        const records = Array.isArray(serverRecords) ? serverRecords : serverRecords.data || [];

        for (const serverRecord of records) {
          const local = db.raw(`SELECT * FROM ${table} WHERE server_id = ${serverRecord.id} LIMIT 1`)[0];
          if (local) {
            // Update local if server is newer and local is clean
            if (!local._dirty) {
              const updateData = { ...serverRecord, server_id: serverRecord.id, _dirty: 0, synced_at: new Date().toISOString() };
              delete updateData.id;
              db.query(table, 'update', updateData, { id: local.id });
            }
          } else {
            // Insert new record from server
            const insertData = { ...serverRecord, server_id: serverRecord.id, _dirty: 0, synced_at: new Date().toISOString() };
            delete insertData.id;
            db.query(table, 'insert', insertData);
          }
          results.pulled++;
        }
      } catch (tableErr) {
        // Don't fail entire sync for one table
        results.errors.push(`Pull ${table}: ${tableErr.message}`);
      }
    }
  } catch (pullErr) {
    results.errors.push(`Pull failed: ${pullErr.message}`);
  }

  return results;
}

module.exports = { syncAll };
