/**
 * usdt.js — Cobros en USDT sobre Polygon (v0.9.509)
 * ---------------------------------------------------------------------------
 * Mismo patrón que baneco.js (QR de cobro + acreditación automática), pero sin
 * pasarela, sin KYB y sin comisiones: la blockchain es la fuente de verdad y
 * este módulo la consulta.
 *
 * DECISIÓN DE DISEÑO — el servidor NUNCA tiene llaves privadas.
 *   Las direcciones salen de la wallet de José (MetaMask/Rabby: una cuenta por
 *   cliente desde la misma semilla) y acá SOLO vive la parte pública. El backend
 *   observa, no gasta. Si alguien vulnera el servidor se lleva direcciones —que
 *   son información pública— y ni un centavo.
 *
 * v0.9.508 — DERIVACIÓN AUTOMÁTICA (BIP-44) desde una clave pública extendida.
 *   El problema de cargar la dirección a mano es que no escala: con 100 clientes
 *   son 100 cuentas creadas y 100 copiar-y-pegar, cada uno con su chance de error.
 *   La solución es la que usan Coinbase Commerce y BitPay: se guarda la XPUB
 *   (clave pública extendida a nivel de cuenta, m/44'/60'/0') y de ahí se CALCULA
 *   la dirección de cada cliente. La xpub deriva direcciones pero NO puede firmar:
 *   aunque se filtre entera, nadie mueve un dólar. La semilla se queda en la
 *   máquina de José y nunca toca el servidor (ver derive-xpub.js).
 *
 *   El índice es SECUENCIAL, no el tenant_id, y a propósito: MetaMask muestra las
 *   cuentas en orden (índice 1 = "Cuenta 2", índice 2 = "Cuenta 3"…). Si usáramos
 *   el tenant_id, el tenant 57 caería en la cuenta 58 de MetaMask y habría que
 *   crear 58 cuentas para llegar a ver la plata. Con índice secuencial, el
 *   cliente número 3 es literalmente la tercera cuenta de la lista.
 *   Arranca en 1 (configurable) para dejar la "Cuenta 1" como la operativa tuya,
 *   la que tiene el POL para el gas.
 *
 * CONCILIACIÓN: una dirección por tenant ⇒ la dirección ES el identificador.
 *   Si entra USDT a la dirección del tenant 14, es el pago del tenant 14.
 *   Idempotencia por tx_hash (índice único): un pago no se acredita dos veces.
 *
 * Config por entorno (Railway):
 *   USDT_ENABLED          "true" para habilitar
 *   ETHERSCAN_API_KEY     key gratuita de etherscan.io (una sirve para todas las cadenas;
 *                         se acepta POLYGONSCAN_API_KEY como alias por compatibilidad)
 *   USDT_MIN_CONFIRMS     confirmaciones mínimas (default 30 ≈ 40 s en Polygon)
 *   ETHERSCAN_BASE        override del endpoint (default api.etherscan.io/v2/api)
 *   USDT_CONTRACT         override del contrato USDT (default el oficial de Polygon)
 *   USDT_XPUB             clave pública extendida (xpub...) para derivar solo
 *   USDT_INDEX_START      primer índice a repartir (default 1)
 */
const https = require('https');
const db = require('./db');

// USDT nativo de Polygon PoS. 6 decimales (NO 18 — error clásico).
const USDT_DEFAULT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const USDT_DECIMALS = 6;
const CHAIN_ID = 137;

function cfg() {
  return {
    enabled: String(process.env.USDT_ENABLED || '').toLowerCase() === 'true',
    // v0.9.509 — la key ahora es de ETHERSCAN (una sola sirve para todas las cadenas).
    // Se sigue aceptando POLYGONSCAN_API_KEY para no romper lo ya cargado en Railway.
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.POLYGONSCAN_API_KEY || '',
    base: process.env.POLYGONSCAN_BASE || process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api',
    contract: (process.env.USDT_CONTRACT || USDT_DEFAULT).toLowerCase(),
    minConfirms: parseInt(process.env.USDT_MIN_CONFIRMS || '30', 10) || 30,
    xpub: String(process.env.USDT_XPUB || '').trim(),
    indexStart: parseInt(process.env.USDT_INDEX_START || '1', 10) || 1,
  };
}
function isConfigured() { const c = cfg(); return !!(c.enabled && c.apiKey); }
function canDerive() { return !!cfg().xpub; }

// ── schema self-migrante (idempotente, corre al boot) ────────────────
async function ensureSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS usdt_addresses (
        tenant_id  INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        address    TEXT NOT NULL,
        label      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // Una dirección no se comparte entre tenants: rompería la conciliación.
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS usdt_addresses_addr_key ON usdt_addresses (LOWER(address))`);
    // v0.9.508 — índice de derivación. NULL = dirección cargada a mano (las viejas).
    await db.query(`ALTER TABLE usdt_addresses ADD COLUMN IF NOT EXISTS derivation_index INTEGER`);
    // Dos tenants no pueden compartir índice: derivarían la misma dirección.
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS usdt_addresses_idx_key ON usdt_addresses (derivation_index) WHERE derivation_index IS NOT NULL`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS usdt_payments (
        id           SERIAL PRIMARY KEY,
        tenant_id    INTEGER NOT NULL,
        tx_hash      TEXT NOT NULL,
        from_address TEXT,
        to_address   TEXT NOT NULL,
        amount       NUMERIC(18,6) NOT NULL,
        block_number BIGINT,
        paid_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // La llave de la idempotencia: el mismo tx jamás se acredita dos veces.
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS usdt_payments_tx_key ON usdt_payments (LOWER(tx_hash))`);
    await db.query(`CREATE INDEX IF NOT EXISTS usdt_payments_tenant_idx ON usdt_payments (tenant_id, paid_at DESC)`);
  } catch (e) { console.error('[usdt] ensureSchema:', e.message); }
}

// ── direcciones ──────────────────────────────────────────────────────
function isValidEvmAddress(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim()); }

async function setAddress(tenantId, address, label) {
  const addr = String(address || '').trim();
  if (!isValidEvmAddress(addr)) throw new Error('Dirección inválida: tiene que ser una dirección EVM (0x + 40 caracteres hex).');
  const dup = await db.query('SELECT tenant_id FROM usdt_addresses WHERE LOWER(address) = LOWER($1) AND tenant_id <> $2', [addr, tenantId]);
  if (dup.rows.length) throw new Error(`Esa dirección ya está asignada al tenant ${dup.rows[0].tenant_id}. Cada cliente necesita la suya o se mezclan los pagos.`);
  // derivation_index vuelve a NULL: si la pegaron a mano ya no es una dirección
  // derivada, y dejar el índice viejo mentiría sobre qué cuenta de la wallet es.
  await db.query(
    `INSERT INTO usdt_addresses (tenant_id, address, label, derivation_index) VALUES ($1, $2, $3, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET address = EXCLUDED.address, label = EXCLUDED.label, derivation_index = NULL`,
    [tenantId, addr, label || null]);
  return { tenant_id: tenantId, address: addr };
}

async function getAddress(tenantId) {
  const r = await db.query('SELECT address, label, derivation_index FROM usdt_addresses WHERE tenant_id = $1', [tenantId]);
  return r.rows[0] || null;
}

/**
 * v0.9.508 — Calcula la dirección número `index` de la xpub configurada.
 *
 * La ruta es 0/index sobre la xpub de cuenta (m/44'/60'/0'), que es exactamente
 * lo que hace MetaMask: su "Cuenta 2" es m/44'/60'/0'/0/1. Por eso la dirección
 * que sale de acá es la MISMA que el usuario ve en su wallet, sin trucos.
 *
 * `ethers` no se carga arriba a propósito: si alguien no usa derivación, que el
 * require ni exista. Un módulo pesado no debería costarle el arranque a nadie.
 */
function deriveAddress(index) {
  const c = cfg();
  if (!c.xpub) throw new Error('No hay USDT_XPUB configurada: no se puede derivar. Cargala en Railway o pegá la dirección a mano.');
  let ethers;
  try { ethers = require('ethers'); }
  catch (e) { throw new Error('Falta la dependencia "ethers" en el servidor (npm install ethers).'); }
  try {
    const node = ethers.HDNodeWallet.fromExtendedKey(c.xpub);
    return node.derivePath('0/' + index).address;
  } catch (e) {
    throw new Error('La USDT_XPUB no parece válida: ' + e.message);
  }
}

/** Próximo índice libre. Secuencial y sin huecos salvo que se borre un tenant. */
async function nextIndex() {
  const c = cfg();
  const r = await db.query('SELECT MAX(derivation_index) AS m FROM usdt_addresses');
  const max = r.rows[0] && r.rows[0].m != null ? Number(r.rows[0].m) : null;
  return max == null ? c.indexStart : max + 1;
}

/**
 * Asigna automáticamente la próxima dirección al tenant. Idempotente: si ya
 * tiene una, la devuelve tal cual en vez de generar otra — cambiarle la
 * dirección a un cliente que ya la tiene sería catastrófico, porque podría
 * pagar a la vieja y el cobro quedaría sin atribuir.
 */
async function assignDerived(tenantId) {
  const existente = await getAddress(tenantId);
  if (existente) return { ...existente, already: true };
  const index = await nextIndex();
  const address = deriveAddress(index);
  await db.query(
    `INSERT INTO usdt_addresses (tenant_id, address, label, derivation_index)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, address, 'Cuenta ' + (index + 1) + ' de la wallet', index]);
  console.log(`🔑 [usdt] tenant ${tenantId} → índice ${index} → ${address}`);
  return { address, derivation_index: index, already: false };
}

/**
 * v0.9.506 — TIPO DE CAMBIO Bs → USDT.
 *
 * Fuentes posibles (USDT_RATE_SOURCE):
 *   'platform'  (default) — usa platform_pricing.usd_to_bs_rate, la MISMA tasa con
 *                la que ya facturás en Bs. Coherente con el resto del sistema.
 *   'fixed'     — usa USDT_RATE_BS fijo, para cuando querés una tasa propia
 *                (p. ej. la del mercado real de USDT, que en Bolivia NO es la oficial).
 *
 * OJO — esto es una decisión COMERCIAL, no técnica: la tasa oficial del BCB y lo
 * que a un cliente le cuesta conseguir USDT en Bolivia no son lo mismo. Si cobrás
 * al oficial, el cliente que compra USDT en el mercado paga de más en la práctica.
 * Por eso la fuente es configurable y no está clavada en el código.
 */
async function usdToBsRate() {
  if (String(process.env.USDT_RATE_SOURCE || '').toLowerCase() === 'fixed') {
    const fixed = Number(process.env.USDT_RATE_BS);
    if (fixed > 0) return { rate: fixed, source: 'fixed' };
  }
  try {
    const { getUsdToBsRate } = require('./catalog-matcher');
    return { rate: await getUsdToBsRate(db), source: 'platform' };
  } catch (e) {
    return { rate: Number(process.env.USDT_RATE_BS) || 0, source: 'unavailable' };
  }
}

/**
 * Datos para mostrar el cobro. El QR se dibuja en el PANEL (librería por CDN):
 * así no sumamos dependencia al backend y la imagen se genera en el cliente.
 * `uri` sigue el estándar EIP-681 → la wallet abre con red, token y monto puestos.
 *
 * Acepta el monto en USD (`amountUsd`) o en bolivianos (`amountBs`), y en ese
 * caso convierte al vuelo. Se redondea a 2 decimales: un monto exacto ayuda a
 * conciliar de un vistazo, y USDT soporta 6 decimales así que no se pierde nada.
 */
async function paymentRequest(tenantId, amountUsd, opts = {}) {
  const row = await getAddress(tenantId);
  if (!row) throw new Error('Este cliente todavía no tiene dirección USDT asignada.');
  const c = cfg();

  let amount = Number(amountUsd) > 0 ? Number(amountUsd) : 0;
  let conversion = null;
  const bs = Number(opts.amountBs);
  if (!amount && bs > 0) {
    const { rate, source } = await usdToBsRate();
    if (!(rate > 0)) throw new Error('No hay tipo de cambio disponible para convertir de Bs a USDT.');
    amount = Math.round((bs / rate) * 100) / 100;
    conversion = { amount_bs: bs, rate_bs_per_usd: rate, rate_source: source };
  }

  const uri = (amount > 0)
    ? `ethereum:${c.contract}@${CHAIN_ID}/transfer?address=${row.address}&uint256=${Math.round(amount * 10 ** USDT_DECIMALS)}`
    : `ethereum:${c.contract}@${CHAIN_ID}/transfer?address=${row.address}`;

  return {
    address: row.address, uri,
    amount: amount > 0 ? amount : null,
    network: 'Polygon (POS)', token: 'USDT', chain_id: CHAIN_ID,
    conversion, // null si el monto vino ya en USD
  };
}

// ── consulta a la blockchain ─────────────────────────────────────────
function _get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Respuesta no-JSON del explorador')); } });
    }).on('error', reject);
  });
}

/**
 * Revisa los depósitos USDT de UNA dirección y acredita los nuevos.
 * Devuelve los pagos recién acreditados (los que ya estaban se ignoran solos).
 */
async function checkAddress(tenantId, address) {
  const c = cfg();
  // v0.9.509 — Etherscan API V2 (multichain). La V1 —api.polygonscan.com— fue
  // dada de baja en agosto de 2025, así que el endpoint viejo ya no responde:
  // ahora es un único host con ?chainid=. Una sola key sirve para todas las redes.
  const url = `${c.base}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${c.contract}` +
              `&address=${address}&page=1&offset=50&sort=desc&apikey=${encodeURIComponent(c.apiKey)}`;
  const r = await _get(url);
  // status "0" con message "No transactions found" es normal (dirección sin uso).
  if (!r || (r.status !== '1' && !/No transactions found/i.test(r.message || ''))) {
    throw new Error('Polygonscan: ' + (r && (r.result || r.message) ? String(r.result || r.message).slice(0, 160) : 'respuesta inesperada'));
  }
  const txs = Array.isArray(r.result) ? r.result : [];
  const nuevos = [];
  for (const tx of txs) {
    // Solo ENTRANTES: un envío saliente desde esta dirección no es un cobro.
    if (String(tx.to || '').toLowerCase() !== address.toLowerCase()) continue;
    // Esperar confirmaciones: evita acreditar algo que una reorg pueda revertir.
    if (Number(tx.confirmations || 0) < c.minConfirms) continue;
    const amount = Number(tx.value) / 10 ** USDT_DECIMALS;
    if (!(amount > 0)) continue;
    const ins = await db.query(
      `INSERT INTO usdt_payments (tenant_id, tx_hash, from_address, to_address, amount, block_number, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
       ON CONFLICT DO NOTHING RETURNING id`,
      [tenantId, tx.hash, tx.from || null, address, amount, tx.blockNumber || null, Number(tx.timeStamp) || null]);
    if (ins.rows.length) {
      nuevos.push({ tenant_id: tenantId, tx_hash: tx.hash, amount, from: tx.from });
      console.log(`💵 [usdt] tenant ${tenantId}: +${amount} USDT (tx ${String(tx.hash).slice(0, 12)}…)`);
    }
  }
  return nuevos;
}

/** Recorre TODAS las direcciones registradas. Lo llama el cron. */
async function checkAll() {
  if (!isConfigured()) return { skipped: 'no configurado' };
  const rows = (await db.query('SELECT tenant_id, address FROM usdt_addresses')).rows;
  let acreditados = 0;
  for (const row of rows) {
    try {
      const nuevos = await checkAddress(row.tenant_id, row.address);
      acreditados += nuevos.length;
    } catch (e) {
      console.warn(`[usdt] tenant ${row.tenant_id}: ${e.message}`);
    }
    // El plan gratuito de Polygonscan limita a ~5 req/s: vamos tranquilos.
    await new Promise((r) => setTimeout(r, 250));
  }
  return { direcciones: rows.length, acreditados };
}

/** Pagos recibidos de un tenant (para el panel). */
async function payments(tenantId, limit = 50) {
  const r = await db.query(
    `SELECT tx_hash, from_address, amount, paid_at, block_number
       FROM usdt_payments WHERE tenant_id = $1 ORDER BY paid_at DESC NULLS LAST LIMIT $2`,
    [tenantId, Math.min(Number(limit) || 50, 200)]);
  return r.rows;
}

/** Total cobrado a un tenant (útil para cruzar con lo facturado). */
async function totalPaid(tenantId) {
  const r = await db.query('SELECT COALESCE(SUM(amount), 0) AS total FROM usdt_payments WHERE tenant_id = $1', [tenantId]);
  return Number(r.rows[0].total);
}

// Cron: cada 2 minutos. Barato — son ~30 requests a un endpoint gratuito.
let _running = false;
async function cronTick() {
  if (!isConfigured() || _running) return;
  _running = true;
  try { await checkAll(); }
  catch (e) { console.error('[usdt cron]', e.message); }
  finally { _running = false; }
}

module.exports = {
  isConfigured, canDerive, cfg, ensureSchema,
  isValidEvmAddress, setAddress, getAddress, paymentRequest, usdToBsRate,
  deriveAddress, nextIndex, assignDerived,
  checkAddress, checkAll, payments, totalPaid, cronTick,
  USDT_DECIMALS, CHAIN_ID,
};
