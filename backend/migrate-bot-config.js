/**
 * Migración v0.4.0 — Tablas de configuración dinámica de Aitana
 * v0.9.191 (20-jun-2026): el seed de bot_global_config ya NO usa
 *   ON CONFLICT (config_key) (esa PK single-tenant se elimina en la migración
 *   multi-tenant). Usa WHERE NOT EXISTS → no depende de ninguna constraint.
 *   Arregla el crash-loop 42P10 "no unique or exclusion constraint matching".
 *
 * Crea:
 *   - bot_verticals       (verticales editables)
 *   - bot_pricing_plans   (planes editables)
 *   - bot_proof_points    (clientes referenciales)
 *   - bot_global_config   (key-value para configuración global)
 *   - bot_prompt_base     (texto del prompt base, editable)
 *   - bot_prompt_history  (snapshots de versiones anteriores)
 *
 * Pre-carga los datos actuales del prompt v2.3 para que la consola arranque funcional.
 *
 * Idempotente: se puede correr múltiples veces sin duplicar datos.
 */

const db = require('./db');

async function runMigration() {
  console.log('🔄 Migración v0.4.0 — Bot Config Tables');

  // =================================================================
  // TABLA 1: bot_verticals
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_verticals (
      vertical_id     VARCHAR(50) PRIMARY KEY,         -- 'comercial', 'restaurante', etc.
      display_name    VARCHAR(100) NOT NULL,
      tagline         TEXT,
      ideal_client    TEXT,
      problem_solved  TEXT,
      features        JSONB DEFAULT '[]',              -- array de strings
      keywords        TEXT[] DEFAULT '{}',             -- palabras del cliente que activan
      differentiator  TEXT,                            -- qué lo hace único vs otros
      sort_order      INTEGER DEFAULT 100,
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_verticals_active ON bot_verticals(active);
  `);
  console.log('✅ bot_verticals creada');

  // =================================================================
  // TABLA 2: bot_pricing_plans
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_pricing_plans (
      plan_id           VARCHAR(50) PRIMARY KEY,
      display_name      VARCHAR(100) NOT NULL,
      monthly_bs        NUMERIC(10,2) NOT NULL,
      target_description TEXT,                          -- "1 persona usa el sistema"
      includes          JSONB DEFAULT '[]',             -- array de features incluidos
      excludes          JSONB DEFAULT '[]',             -- array de lo que NO incluye
      max_users         INTEGER,
      max_branches      INTEGER,
      support_hours     VARCHAR(100),                   -- 'L-V 8am-6pm', '24/7'
      sort_order        INTEGER DEFAULT 100,            -- para ordenar planes
      recommended       BOOLEAN DEFAULT FALSE,          -- "más popular"
      active            BOOLEAN DEFAULT TRUE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_pricing_plans_active ON bot_pricing_plans(active);
  `);
  console.log('✅ bot_pricing_plans creada');

  // =================================================================
  // TABLA 3: bot_proof_points
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_proof_points (
      id              SERIAL PRIMARY KEY,
      vertical_id     VARCHAR(50) REFERENCES bot_verticals(vertical_id) ON DELETE CASCADE,
      client_name     VARCHAR(150) NOT NULL,
      client_location VARCHAR(150),
      description     TEXT,
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_proof_points_vertical ON bot_proof_points(vertical_id);
  `);
  console.log('✅ bot_proof_points creada');

  // =================================================================
  // TABLA 4: bot_global_config (key-value)
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_global_config (
      config_key      VARCHAR(100) PRIMARY KEY,
      config_value    TEXT,
      description     TEXT,                              -- ayuda contextual en la UI
      data_type       VARCHAR(20) DEFAULT 'string',      -- string, number, boolean, json
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ bot_global_config creada');

  // =================================================================
  // TABLA 5: bot_prompt_base (texto editable del prompt base)
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_prompt_base (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      content         TEXT NOT NULL,
      version         INTEGER DEFAULT 1,
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT bot_prompt_base_singleton CHECK (id = 1)  -- solo un row
    );
  `);
  console.log('✅ bot_prompt_base creada');

  // =================================================================
  // TABLA 6: bot_prompt_history (snapshots de cada cambio)
  // =================================================================
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_prompt_history (
      id              SERIAL PRIMARY KEY,
      snapshot        JSONB NOT NULL,                    -- estado completo: prompt + verticales + planes + ...
      change_summary  TEXT,                              -- "Cambió precio Plan Mínimo de 250 a 280"
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_prompt_history_created ON bot_prompt_history(created_at DESC);
  `);
  console.log('✅ bot_prompt_history creada');

  // =================================================================
  // PRE-CARGAR DATOS: Verticales (las 5 actuales)
  // =================================================================
  const verticals = [
    {
      id: 'comercial',
      name: 'Sistema Comercial',
      tagline: 'Todo lo que necesitas para gestionar tu negocio desde un solo lugar',
      ideal: 'tiendas, mini-markets, ferreterías, distribuidoras, fábricas, importadoras',
      problem: 'dueños que pierden el control de su inventario, manejan stock con cuadernos o Excel',
      features: ['Catálogo completo con códigos de barras', 'Compras y ventas integradas', 'Reportes en tiempo real', 'Control de inventario con alertas', 'Lotes y fechas de vencimiento', 'Gestión de proveedores'],
      keywords: ['tienda','comercio','inventario','stock','almacén','distribuidora','fábrica','ferretería','market','productos','ventas','código de barras'],
      differentiator: 'Módulos base: Catálogo, Compras, Ventas, Inventario',
      sort: 10,
    },
    {
      id: 'restaurante',
      name: 'Sistema Restaurante',
      tagline: 'Optimiza tu servicio y aumenta tus ventas diarias',
      ideal: 'restaurantes, cafeterías, bares, snacks, comida rápida, catering',
      problem: 'comandas con confusión, mesoneros que olvidan pedidos, demoras cocina-mesa',
      features: ['Gestión de mesas y comandas en tablet', 'Pedidos directos a cocina/bar', 'Control de insumos por receta', 'Cuenta dividida por mesa o comensal', 'Reportes de platos por horario'],
      keywords: ['restaurante','cafetería','bar','snack','comida','mesas','comandas','mesonero','cocina','insumos','pizzería','hamburguesería'],
      differentiator: 'Módulo Venta Rápida (POS comida rápida con tickets veloces)',
      sort: 20,
    },
    {
      id: 'lavadero',
      name: 'Sistema Lavadero de Autos',
      tagline: 'Controla servicios, personal y fideliza clientes',
      ideal: 'lavaderos express, talleres con servicios de limpieza, lubricentros con lavado',
      problem: 'comisiones que no cuadran, no saber qué cliente vino antes, perder clientes por no tener historial',
      features: ['Gestión de servicios por placa', 'Control de comisiones por empleado', 'Membresías y paquetes recurrentes', 'Historial por cliente y vehículo', 'Recordatorios automáticos'],
      keywords: ['lavadero','car wash','lavado autos','lavadero express','autos','vehículos','lavadores','comisiones'],
      differentiator: 'Búsqueda por placa de vehículo + proformas para órdenes de trabajo',
      sort: 30,
    },
    {
      id: 'dental',
      name: 'Sistema Clínica Dental',
      tagline: 'Gestiona pacientes y tratamientos profesionalmente',
      ideal: 'clínicas dentales, consultorios odontológicos, ortodoncistas',
      problem: 'historias clínicas en papel, doble agendamiento, presupuestos sin seguimiento',
      features: ['Historia clínica digital completa', 'Agenda con recordatorios por WhatsApp', 'Presupuestos de tratamiento', 'Odontograma digital interactivo', 'Planes de pago con seguimiento'],
      keywords: ['dentista','dental','odontología','odontólogo','consultorio dental','clínica dental','pacientes','ortodoncia','odontograma','brackets'],
      differentiator: 'Módulo Odontología completo (agenda, fichas, odontograma, presupuestos)',
      sort: 40,
    },
    {
      id: 'club',
      name: 'Sistema Club Deportivo',
      tagline: 'Administra socios, instalaciones y actividades',
      ideal: 'gimnasios, clubes deportivos, canchas, academias, polideportivos',
      problem: 'control manual de socios al día y morosos, doble reserva de canchas, asistencia en cuaderno',
      features: ['Membresías y cuotas con alertas de cobro', 'Gestión de accesos a instalaciones', 'Reserva de canchas online', 'Control de clases y entrenadores', 'Reportes de asistencia'],
      keywords: ['gimnasio','gym','club','deportivo','cancha','fútbol','pádel','tenis','academia','entrenador','socios','membresía'],
      differentiator: 'Módulo Reserva de Canchas (gestión de instalaciones, horarios, ocupación)',
      sort: 50,
    },
  ];

  for (const v of verticals) {
    await db.query(`
      INSERT INTO bot_verticals (vertical_id, display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT (vertical_id) DO NOTHING
    `, [v.id, v.name, v.tagline, v.ideal, v.problem, JSON.stringify(v.features), v.keywords, v.differentiator, v.sort]);
  }
  console.log('✅ Verticales pre-cargadas (5)');

  // =================================================================
  // PRE-CARGAR DATOS: Planes
  // =================================================================
  const plans = [
    {
      id: 'minimo',
      name: 'Plan Mínimo',
      price: 250,
      target: 'Dueño opera personalmente. Solo 1 persona usa el sistema directamente.',
      includes: ['Catálogo básico', 'Ventas simples + notas de venta', 'Reportes básicos', 'Inventario con Kardex', '3 roles fijos: Admin, Caja, Visor'],
      excludes: ['Compras', 'Gastos', 'Gestión avanzada de usuarios', 'Multi-sucursal'],
      max_users: 3,
      max_branches: 1,
      support: 'L-V 8am-6pm',
      sort: 10,
      recommended: false,
    },
    {
      id: 'intermedio',
      name: 'Plan Intermedio',
      price: 350,
      target: 'Negocios establecidos con equipo. 2 a 10 personas usan el sistema.',
      includes: ['Catálogo avanzado (precios doble, lotes, perfiles cliente)', 'Compras con órdenes que actualizan stock', 'Gastos categorizados', 'Ventas con apertura/cierre caja, QR, crédito', 'Reportes detallados', 'Inventario multi-almacén', 'Trabajadores con comisiones', 'Hasta 10 usuarios con cualquier rol/permiso', 'Hasta 5 sucursales'],
      excludes: [],
      max_users: 10,
      max_branches: 5,
      support: '24/7',
      sort: 20,
      recommended: true,
    },
    {
      id: 'premium',
      name: 'Plan Premium',
      price: 700,
      target: 'Cadenas y negocios grandes. Más de 10 usuarios o multi-sucursal.',
      includes: ['Todo el sistema completo', 'Usuarios ilimitados', 'Sucursales ilimitadas', 'Gerenciamiento autónomo', 'Soporte 24/7 prioritario'],
      excludes: [],
      max_users: null,
      max_branches: null,
      support: '24/7 prioritario',
      sort: 30,
      recommended: false,
    },
  ];

  for (const p of plans) {
    await db.query(`
      INSERT INTO bot_pricing_plans (plan_id, display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)
      ON CONFLICT (plan_id) DO NOTHING
    `, [p.id, p.name, p.price, p.target, JSON.stringify(p.includes), JSON.stringify(p.excludes), p.max_users, p.max_branches, p.support, p.sort, p.recommended]);
  }
  console.log('✅ Planes pre-cargados (3)');

  // =================================================================
  // PRE-CARGAR DATOS: Proof Points
  // =================================================================
  const proofPoints = [
    { vertical: 'lavadero', name: 'ExpressWash', location: 'Genex, 3er anillo, Santa Cruz' },
    { vertical: 'lavadero', name: 'Totitos Car Wash', location: 'zona Sevilla, Santa Cruz' },
    { vertical: 'comercial', name: 'La Boteca', location: 'Santa Cruz' },
    { vertical: 'comercial', name: 'Fábrica de telas', location: 'Argentina' },
    { vertical: 'comercial', name: 'CaterinGS', location: 'Santa Cruz' },
    { vertical: 'dental', name: 'Odontokids', location: 'Torres Platinum, Equipetrol' },
  ];

  for (const pp of proofPoints) {
    await db.query(`
      INSERT INTO bot_proof_points (vertical_id, client_name, client_location)
      SELECT $1::varchar, $2::varchar, $3::varchar
      WHERE NOT EXISTS (
        SELECT 1 FROM bot_proof_points
        WHERE vertical_id = $1::varchar AND client_name = $2::varchar
      )
    `, [pp.vertical, pp.name, pp.location]);
  }
  console.log('✅ Proof points pre-cargados (6)');

  // =================================================================
  // PRE-CARGAR DATOS: Global Config
  // =================================================================
  const globalConfig = [
    ['company_name', 'SG Sistemas Digitales', 'Nombre comercial de la empresa', 'string'],
    ['company_short_name', 'SG Bolivia', 'Nombre corto', 'string'],
    ['bot_persona_name', 'Aitana', 'Nombre del bot', 'string'],
    ['bot_persona_age', '28', 'Edad de la persona del bot', 'number'],
    ['bot_persona_origin', 'Santa Cruz, Bolivia', 'Origen', 'string'],
    ['bot_persona_style', 'profesional pero cálida, español neutro con toques de Bolivia', 'Estilo de comunicación', 'string'],
    ['setup_fee_bs', '350', 'Fee único de implementación (Bs)', 'number'],
    ['min_commitment_months', '6', 'Compromiso mínimo en meses', 'number'],
    ['trial_days', '10', 'Días de prueba gratis', 'number'],
    ['qualification_score_threshold', '70', 'Score mínimo para calificar como lead', 'number'],
    ['offer_trial_when', 'cliente muestra interés genuino y ya capturaste sus datos básicos', 'Cuándo ofrecer trial', 'string'],
    ['discount_policy', 'NO ofrecer descuentos por iniciativa propia. Si insiste, escalar a humano.', 'Política de descuentos', 'string'],
  ];

  for (const [key, value, desc, type] of globalConfig) {
    // v0.9.191: NO usar ON CONFLICT (config_key). Esa PK/unique single-tenant se
    // elimina en la migración multi-tenant (bot_global_config pasa a (tenant_id,
    // config_key)). Con ON CONFLICT (config_key) este seed tiraba 42P10 y crasheaba
    // el deploy en loop. Usamos WHERE NOT EXISTS → no depende de NINGUNA constraint
    // (mismo patrón que el seed de proof_points de arriba). Idempotente.
    await db.query(`
      INSERT INTO bot_global_config (config_key, config_value, description, data_type)
      SELECT $1::text, $2::text, $3::text, $4::text
      WHERE NOT EXISTS (SELECT 1 FROM bot_global_config WHERE config_key = $1::text)
    `, [key, value, desc, type]);
  }
  console.log('✅ Global config pre-cargado (12 entries)');

  // =================================================================
  // PRE-CARGAR DATOS: Prompt Base
  // =================================================================
  const promptBase = `Eres {{bot_persona_name}}, asesora comercial de {{company_short_name}} ({{company_name}}). Tienes {{bot_persona_age}} años, eres de {{bot_persona_origin}}, {{bot_persona_style}}. Eres directa, escuchas más de lo que hablas, y solo recomiendas cuando entendiste el problema del cliente.

══════════════════════════════════════════════════════════════
QUÉ VENDE LA EMPRESA
══════════════════════════════════════════════════════════════

Vendes UN sistema integral de gestión que se adapta al rubro de cada cliente. NO son productos separados — es la misma plataforma con módulos y configuraciones específicas según la vertical.

{{verticals_block}}

══════════════════════════════════════════════════════════════
PLANES Y PRECIOS
══════════════════════════════════════════════════════════════

**Setup único (implementación): {{setup_fee_bs}} Bs** (todos los planes)
**Compromiso mínimo: {{min_commitment_months}} meses**
**Trial: {{trial_days}} días gratis** ({{offer_trial_when}})

{{plans_block}}

══════════════════════════════════════════════════════════════
CÓMO CLASIFICAR AL CLIENTE Y RECOMENDAR PLAN
══════════════════════════════════════════════════════════════

REGLA DE ORO: lo que define el plan NO es cuánta gente trabaja en el negocio, sino **cuántas personas necesitan login propio en el sistema**.

Pregunta: "¿Cuántas personas usarían el sistema directamente? Por ejemplo, en un lavadero los lavadores no usan el sistema, pero el cajero sí."

Política de descuentos: {{discount_policy}}

══════════════════════════════════════════════════════════════
🚨 VÁLVULAS DE ESCAPE CRÍTICAS
══════════════════════════════════════════════════════════════

REGLA #1 — Solo conoces y vendes las verticales listadas arriba. Si el cliente menciona CUALQUIER otro rubro (bienes raíces, hoteles, salones de belleza, lavanderías de ropa, escuelas, talleres mecánicos, parqueos, carpinterías, servicios profesionales, salud no-dental, etc.), NO sigas vendiendo. Escala a humano INMEDIATAMENTE.

NO digas "nuestro sistema se adapta a cualquier rubro" — eso es FALSO.
NO inventes features ni módulos que no existen.
Reconoce honestamente que ese rubro NO es tu especialidad.
Marca calificado: true con reason: "escalation_unknown_vertical".

REGLA #2 — JAMÁS INVENTES FEATURES O MÓDULOS

Solo puedes hablar de los módulos y features que están explícitamente listados arriba.

PROHIBIDO mencionar (no existen):
- "Agente IA integrado"
- "ChatBot integrado"
- "Marketing automation"
- "Email marketing"
- "Integración con redes sociales"
- "Análisis predictivo"
- "Apps móviles nativas"
- Integraciones con software externo (POS marca, ERP, contabilidad, SIN, Mercadolibre, Shopify, etc.)

REGLA #3 — MULTIMEDIA RECIBIDO

Si el último mensaje del cliente es multimedia con transcripción/análisis, responde al CONTENIDO transcrito como si fuera texto normal.
Si NO viene con transcripción, NO digas "gracias por el multimedia". Pídele al cliente que describa por escrito qué quiere mostrarte o consultarte.

══════════════════════════════════════════════════════════════
METODOLOGÍA: SPIN-then-BANT
══════════════════════════════════════════════════════════════

PRIMERA FASE — SPIN (descubrimiento, primeros 4-6 turnos):
- S (Situación): contexto del negocio
- P (Problema): dolor actual
- I (Implicación): costo de no resolver
- N (Necesidad): compromiso de cambio

SEGUNDA FASE — BANT (calificación, después del SPIN):
- B (Budget): se infiere del plan que cabe
- A (Authority): ¿Eres tú quien decide implementar?
- N (Need): urgencia
- T (Timing): ¿Cuándo te gustaría empezar?

REGLAS DE CONVERSACIÓN:
- UNA pregunta por turno. Nunca dos.
- Mensajes de máximo 4 líneas.
- Validar antes de avanzar.
- Mencionar proof points DESPUÉS de identificar el rubro, no antes.
- No cotizar precio hasta haber capturado: rubro + cuántas personas usan el sistema + problema principal.
- Enviar video demo (asset) DESPUÉS de identificar problema concreto, NO al inicio.

══════════════════════════════════════════════════════════════
CALIFICACIÓN Y SCORE (0-{{qualification_score_threshold}}+)
══════════════════════════════════════════════════════════════

Score mínimo para calificar: {{qualification_score_threshold}}

Suma puntos turno a turno:
+10 vertical identificada
+15 problema concreto descrito
+10 número de personas que usan el sistema
+15 nombre + nombre del negocio
+10 email
+15 cliente confirma autoridad
+10 no objeta el precio
+10 timing claro
+5 pidió ver demo
+10 mencionó referido o anuncio

Cuando llega a {{qualification_score_threshold}}, marca calificado: true.

Si pide hablar con humano explícitamente, calificar inmediatamente con reason: "client_requested_human".

══════════════════════════════════════════════════════════════
FORMATO DE RESPUESTA (JSON OBLIGATORIO)
══════════════════════════════════════════════════════════════

Siempre responde con JSON válido sin markdown ni backticks:

{
  "respuesta": "texto al cliente (max 4 líneas, una pregunta máximo)",
  "asset_to_send": "asset_id o null",
  "vertical_detectada": "comercial | restaurante | lavadero | dental | club | null",
  "calificado": true/false,
  "score": 0-100,
  "bant_progress": { "B": "...", "A": "...", "N": "...", "T": "..." },
  "spin_progress": { "S": "...", "P": "...", "I": "...", "N": "..." },
  "summary": "resumen de 1-2 líneas",
  "nombre_detectado": "string o null",
  "empresa_detectada": "string o null",
  "email_detectado": "string o null",
  "reason": "qualified_lead | client_requested_human | escalation_unknown_vertical | escalation_complaint | escalation_custom_dev | null"
}`;

  await db.query(`
    INSERT INTO bot_prompt_base (id, content, version)
    VALUES (1, $1, 1)
    ON CONFLICT (id) DO NOTHING
  `, [promptBase]);
  console.log('✅ Prompt base pre-cargado');

  // =================================================================
  // TRIGGER: actualizar updated_at automáticamente
  // =================================================================
  for (const t of ['bot_verticals','bot_pricing_plans','bot_proof_points','bot_prompt_base']) {
    await db.query(`
      DROP TRIGGER IF EXISTS set_timestamp_${t} ON ${t};
      CREATE TRIGGER set_timestamp_${t}
      BEFORE UPDATE ON ${t}
      FOR EACH ROW
      EXECUTE FUNCTION trigger_set_timestamp();
    `).catch(() => {});  // si trigger_set_timestamp ya existe en otra tabla, lo reusamos
  }
  console.log('✅ Triggers de updated_at configurados');

  console.log('🎉 Migración v0.4.0 completada');
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error en migración:', err);
      process.exit(1);
    });
}

module.exports = { runMigration };
