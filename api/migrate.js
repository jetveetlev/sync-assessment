// ONE-TIME migration endpoint: Supabase → Neon
// DELETE this file after migration is done!
// Access: /api/migrate?secret=syncmigrate2024
const { Client } = require('pg');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const POSTGRES_URL = process.env.POSTGRES_URL;

async function sbFetch(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?order=id.asc&limit=10000`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.query.secret !== 'syncmigrate2024') return res.status(403).json({ error: 'Forbidden' });

  const log = [];
  const db = new Client({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false } });

  try {
    await db.connect();
    log.push('Connected to Neon ✓');

    // ── Schema ──────────────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id            SERIAL PRIMARY KEY,
        coach_id      INTEGER NOT NULL,
        name          TEXT NOT NULL,
        phone         TEXT,
        type          TEXT NOT NULL DEFAULT 'single',
        code          TEXT UNIQUE NOT NULL,
        group_prefix  TEXT,
        partner_code  TEXT,
        partner_name  TEXT,
        partner_phone TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id             SERIAL PRIMARY KEY,
        client_code    TEXT NOT NULL,
        session_number INTEGER NOT NULL,
        type           TEXT NOT NULL DEFAULT 'PRIBADI',
        date           DATE,
        skor1          NUMERIC(5,2) DEFAULT 0,
        skor2          NUMERIC(5,2) DEFAULT 0,
        skor3          NUMERIC(5,2) DEFAULT 0,
        skor4          NUMERIC(5,2) DEFAULT 0,
        skor5          NUMERIC(5,2) DEFAULT 0,
        total          NUMERIC(6,2) DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id              SERIAL PRIMARY KEY,
        token           TEXT UNIQUE NOT NULL,
        coach_id        INTEGER NOT NULL,
        coach_name      TEXT,
        coach_username  TEXT,
        expires_at      TIMESTAMPTZ NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    log.push('Schema created ✓');

    // ── Clients ──────────────────────────────────────────────────────────
    const clients = await sbFetch('clients');
    log.push(`Found ${clients.length} clients in Supabase`);
    let cOk = 0;
    for (const c of clients) {
      await db.query(`
        INSERT INTO clients (id,coach_id,name,phone,type,code,group_prefix,partner_code,partner_name,partner_phone,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING
      `, [c.id,c.coach_id,c.name,c.phone||null,c.type||'single',c.code,c.group_prefix||null,
          c.partner_code||null,c.partner_name||null,c.partner_phone||null,c.created_at]);
      cOk++;
    }
    if (clients.length) await db.query(`SELECT setval('clients_id_seq', (SELECT MAX(id) FROM clients))`);
    log.push(`Clients migrated: ${cOk} ✓`);

    // ── Sessions ─────────────────────────────────────────────────────────
    const sessions = await sbFetch('sessions');
    log.push(`Found ${sessions.length} sessions in Supabase`);
    let sOk = 0;
    for (const s of sessions) {
      await db.query(`
        INSERT INTO sessions (id,client_code,session_number,type,date,skor1,skor2,skor3,skor4,skor5,total,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING
      `, [s.id,s.client_code,s.session_number,s.type||'PRIBADI',s.date||null,
          s.skor1||0,s.skor2||0,s.skor3||0,s.skor4||0,s.skor5||0,s.total||0,s.created_at]);
      sOk++;
    }
    if (sessions.length) await db.query(`SELECT setval('sessions_id_seq', (SELECT MAX(id) FROM sessions))`);
    log.push(`Sessions migrated: ${sOk} ✓`);

    await db.end();
    log.push('DONE — delete /api/migrate.js now!');
    return res.status(200).json({ success: true, log });

  } catch (e) {
    await db.end().catch(() => {});
    return res.status(500).json({ success: false, error: e.message, log });
  }
};
