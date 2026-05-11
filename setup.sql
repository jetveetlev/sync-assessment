-- ═══════════════════════════════════════════════════════════════
--   SYNC ASSESSMENT — Supabase Setup
--   Paste this entire file into Supabase > SQL Editor > Run
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clients (
    id            BIGSERIAL PRIMARY KEY,
    coach_id      INTEGER NOT NULL,
    name          TEXT NOT NULL,
    phone         TEXT DEFAULT '',
    type          TEXT NOT NULL CHECK (type IN ('single', 'couple')),
    code          TEXT UNIQUE NOT NULL,
    partner_code  TEXT UNIQUE,
    partner_name  TEXT DEFAULT '',
    partner_phone TEXT DEFAULT '',
    group_prefix  TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id             BIGSERIAL PRIMARY KEY,
    client_code    TEXT NOT NULL,
    session_number INTEGER NOT NULL,
    type           TEXT NOT NULL CHECK (type IN ('PRIBADI', 'RELASI')),
    date           DATE NOT NULL,
    skor1          NUMERIC(4,1) DEFAULT 0,
    skor2          NUMERIC(4,1) DEFAULT 0,
    skor3          NUMERIC(4,1) DEFAULT 0,
    skor4          NUMERIC(4,1) DEFAULT 0,
    skor5          NUMERIC(4,1) DEFAULT 0,
    total          NUMERIC(5,1) DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_code    ON sessions(client_code);
CREATE INDEX IF NOT EXISTS idx_clients_code     ON clients(code);
CREATE INDEX IF NOT EXISTS idx_clients_partner  ON clients(partner_code);
CREATE INDEX IF NOT EXISTS idx_clients_prefix   ON clients(group_prefix);
CREATE INDEX IF NOT EXISTS idx_clients_coach    ON clients(coach_id);

-- Admin login sessions (token-based, replaces PHP sessions)
CREATE TABLE IF NOT EXISTS admin_sessions (
    token           TEXT PRIMARY KEY,
    coach_id        INTEGER NOT NULL,
    coach_name      TEXT NOT NULL,
    coach_username  TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token);
