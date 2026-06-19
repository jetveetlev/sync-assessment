// Migration: Supabase → Neon
// Run: node scripts/migrate.js
require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const POSTGRES_URL = process.env.POSTGRES_URL;

async function sb(table, filters = {}) {
  const params = new URLSearchParams(filters).toString();
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  return res.json();
}

async function main() {
  const db = new Client({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log('Connected to Neon ✓');

  // ── Create schema ─────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id            SERIAL PRIMARY KEY,
      coach_id      INTEGER NOT NULL,
      name          TEXT NOT NULL,
      phone         TEXT,
      type          TEXT NOT NULL DEFAULT 'single',
      code          TEXT UNIQUE NOT NULL,
      group_prefix  TEXT,
      partner_code  TEXT UNIQUE,
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
  console.log('Schema created ✓');

  // ── Migrate clients ───────────────────────────────────────────────────
  const clients = await sb('clients', { order: 'id.asc' });
  console.log(`Migrating ${clients.length} clients...`);
  for (const c of clients) {
    await db.query(`
      INSERT INTO clients (id, coach_id, name, phone, type, code, group_prefix, partner_code, partner_name, partner_phone, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO NOTHING
    `, [c.id, c.coach_id, c.name, c.phone||null, c.type||'single', c.code, c.group_prefix||null,
        c.partner_code||null, c.partner_name||null, c.partner_phone||null, c.created_at]);
  }
  // Reset sequence
  await db.query(`SELECT setval('clients_id_seq', COALESCE((SELECT MAX(id) FROM clients), 1))`);
  console.log(`Clients migrated ✓`);

  // ── Migrate sessions ──────────────────────────────────────────────────
  const sessions = await sb('sessions', { order: 'id.asc' });
  console.log(`Migrating ${sessions.length} sessions...`);
  for (const s of sessions) {
    await db.query(`
      INSERT INTO sessions (id, client_code, session_number, type, date, skor1, skor2, skor3, skor4, skor5, total, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO NOTHING
    `, [s.id, s.client_code, s.session_number, s.type||'PRIBADI', s.date||null,
        s.skor1||0, s.skor2||0, s.skor3||0, s.skor4||0, s.skor5||0, s.total||0, s.created_at]);
  }
  await db.query(`SELECT setval('sessions_id_seq', COALESCE((SELECT MAX(id) FROM sessions), 1))`);
  console.log(`Sessions migrated ✓`);

  await db.end();
  console.log('\n✅ Migration complete! All data moved to Neon.');
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
