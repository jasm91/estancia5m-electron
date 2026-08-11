/**
 * v0.9.410 — Importador de vehículos desde ficha técnica PDF (formato Nissan "Esto es Nissan").
 *
 * Las cartillas del fabricante son muy consistentes, así que parseamos el texto (pdf-parse)
 * y devolvemos un BORRADOR de ítem de inventario (modelo, motor, potencia, torque, transmisión,
 * tracción, combustible, plazas, capacidad → features). El PANEL pre-llena el form de alta y el
 * usuario agrega el PRECIO (los PDF no lo traen) y confirma.
 *
 * Imagen hero: escaneamos el buffer del PDF por streams JPEG (FFD8…FFD9) y elegimos el de mayor
 * área con relación de aspecto razonable. Los JPEG2000 (JPX) no tienen ese marcador → devolvemos
 * null y el usuario sube la foto a mano. SIN dependencias nativas.
 *
 * Best-effort: si algo no matchea, ese campo queda vacío para que el usuario lo complete.
 */

const KNOWN_VERSIONS = ['SENSE', 'ADVANCE', 'EXCLUSIVE', 'SR', 'SE', 'XE', 'PRO-4X', 'S', 'MINIBÚS', 'FURGÓN', 'PLUS', 'ACENTA', 'TEKNA', 'VISIA'];
const BODY_BY_MODEL = {
  FRONTIER: 'Pick-up', NP300: 'Pick-up', URVAN: 'Van', NV350: 'Van',
  SENTRA: 'Sedán', VERSA: 'Sedán', ALTIMA: 'Sedán',
  'X-TRAIL': 'SUV', KICKS: 'SUV', QASHQAI: 'SUV', PATHFINDER: 'SUV', PATROL: 'SUV', JUKE: 'SUV', MURANO: 'SUV',
  MARCH: 'Hatchback', NOTE: 'Hatchback', LEAF: 'Hatchback',
};

function ccToLiters(cc) {
  const n = parseInt(String(cc).replace(/[^\d]/g, ''), 10);
  return n ? (Math.round(n / 100) / 10).toFixed(1) : null;
}
function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

/**
 * Parsea el texto de una ficha Nissan → borrador de ítem.
 * @param {string} text  texto devuelto por pdf-parse
 * @returns {object} { name, model, brand, category, model_year, condition, body_type, fuel, transmission, features, description, versions, _matched }
 */
function parseNissanText(text) {
  const flat = String(text || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const o = { brand: 'Nissan', category: 'Automóvil', model_year: new Date().getFullYear(), condition: '0km', body_type: '', fuel: '', transmission: '', features: '', description: '', versions: [] };

  // --- Modelo (título "ESTO ES NISSAN <MODELO>") ---
  let mm = flat.match(/ESTO ES NISSAN\s+([A-ZÁÉÍÓÚ0-9][A-ZÁÉÍÓÚ0-9\- ]{1,20}?)\s+(?:Estructura|Interior|Conectividad|C[oó]modo|[A-Z]{2}\d{2}[A-Z]{2}|MEC[ÁA]NICA|R ?O ?T|A ?C ?I|$)/);
  let raw = mm ? mm[1].trim() : ((flat.match(/ESTO ES NISSAN\s+([A-ZÁÉÍÓÚ0-9\-]+(?:\s+CS)?)/) || [])[1] || '').trim();
  raw = raw.replace(/\s+(FRONTIER|URVAN|SENTRA|VERSA)\b/, '').trim();
  if (raw) {
    o.model = raw.split(' ').map((w) => /^(CS|V8|SR|MT|CVT|PRO-4X|SE|XE)$/i.test(w) ? w.toUpperCase() : titleCase(w)).join(' ');
    o.name = 'Nissan ' + o.model;
    o.body_type = BODY_BY_MODEL[raw.split(' ')[0].toUpperCase()] || '';
  }

  // --- Mecánica ---
  const eng = flat.match(/([A-Z]{2}\d{2}[A-Z]{2})\d?\s*(?:\d+\s*CILINDROS[^0-9]*)?([\d.,]+)\s*cc/i);
  const code = eng ? eng[1] : null;
  const L = eng ? ccToLiters(eng[2]) : null;
  const hp = (flat.match(/(\d{2,3})\s*hp/i) || [])[1];
  const nm = (flat.match(/(\d{2,3})\s*Nm/i) || [])[1];

  // Transmisión (puede haber más de una en la gama)
  const trans = [];
  if (/XTRONIC|®?\s*CVT/i.test(flat)) trans.push('CVT');
  const mt = flat.match(/Manual de (\d) velocidades/i);
  if (mt) trans.push('Manual ' + mt[1] + ' vel');
  if (/\bAT\b|Autom[aá]tic/i.test(flat) && !trans.includes('CVT')) trans.push('Automática');
  o.transmission = trans.length ? trans.join(' / ') : (/Manual/i.test(flat) ? 'Manual' : '');

  // Tracción
  const tr = flat.match(/Tracci[oó]n\s*(?:Delantera\s*)?(4x[24]|AWD|4WD)/i);
  const tracc = tr ? tr[1] : (/4x4/i.test(flat) ? '4x4' : (/4x2/i.test(flat) ? '4x2' : ''));

  // Combustible
  o.fuel = /Gasolina/i.test(flat) ? 'Nafta' : (/Di[eé]sel/i.test(flat) ? 'Diésel' : (/(El[eé]ctric|e-POWER|EV)/i.test(flat) ? 'Eléctrico' : ''));

  // Plazas / capacidad
  const pl = (flat.match(/Plazas\s*Pers\.?\s*(\d{1,2})/i) || flat.match(/(\d{1,2})\s*pasajeros/i) || [])[1];
  const mal = (flat.match(/maletera\s*l?\s*([\d.,]+)/i) || [])[1];
  const carga = (flat.match(/carga\s*kg\s*([\d.,]+)/i) || [])[1];

  // Versiones (heurística sobre nombres conocidos)
  o.versions = KNOWN_VERSIONS.filter((v) => new RegExp('\\b' + v.replace('-', '\\-') + '\\b').test(flat));

  // --- Features (una por línea → el bot las bulletea) ---
  const F = [];
  if (code || hp) F.push(`Motor ${L ? L + 'L ' : ''}${code ? '(' + code + ') ' : ''}${hp ? '· ' + hp + ' hp' : ''}`.replace(/\s+/g, ' ').trim());
  if (nm) F.push(`Torque ${nm} Nm`);
  const tl = [o.transmission, tracc ? 'Tracción ' + tracc : ''].filter(Boolean).join(' · ');
  if (tl) F.push(tl);
  const cap = [pl ? pl + ' plazas' : '', mal ? 'maletera ' + mal + ' L' : '', carga ? 'carga ' + carga + ' kg' : ''].filter(Boolean).join(' · ');
  if (cap) F.push(cap);
  if (/Android Auto|Apple CarPlay/i.test(flat)) F.push('Conectividad Android Auto y Apple CarPlay');
  o.features = F.join('\n');

  // --- Descripción: plantilla de versiones para que el usuario ponga precios ---
  if (o.versions.length) {
    o.description = 'Precios referenciales por versión:\n' + o.versions.map((v) => `• ${v} — desde $`).join('\n') + '\n(Referenciales.)';
  }

  o._matched = { model: !!o.model, engine: !!code, hp: !!hp, torque: !!nm, transmission: !!o.transmission, traccion: !!tracc, fuel: !!o.fuel, plazas: !!pl };
  return o;
}

/** Lee dimensiones de un JPEG desde su marcador SOF. */
function jpegDims(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const mk = buf[i + 1];
    if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
      try { return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; } catch (e) { return null; }
    }
    if (mk === 0xD8 || mk === 0xD9 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
    try { i += 2 + buf.readUInt16BE(i + 2); } catch (e) { break; }
  }
  return null;
}

/**
 * Extrae la mejor imagen JPEG embebida del PDF (hero). Devuelve Buffer o null.
 * JPEG2000/JPX no tienen marcador FFD8 → null → el usuario sube la foto a mano.
 */
function extractHeroJpeg(pdfBuffer) {
  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const cands = [];
  let i = 0;
  while (i < buf.length - 3) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      let j = i + 2;
      while (j < buf.length - 1) { if (buf[j] === 0xFF && buf[j + 1] === 0xD9) { j += 2; break; } j++; }
      const slice = buf.slice(i, j);
      const d = jpegDims(slice);
      if (d && d.w >= 600 && slice.length > 15000) {
        const ar = d.w / d.h;
        if (ar >= 0.4 && ar <= 2.6) cands.push({ buf: slice, area: d.w * d.h, w: d.w, h: d.h });
      }
      i = j;
    } else i++;
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.area - a.area);
  return cands[0].buf;
}

module.exports = { parseNissanText, extractHeroJpeg };
