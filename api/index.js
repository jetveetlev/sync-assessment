// Vercel Serverless Function — Sync Assessment API (Neon/PostgreSQL)
const { randomUUID } = require('crypto');
const { Client }     = require('pg');

const COACHES = {
  jet: { id: 1, name: 'Jet', password: process.env.COACH_JET_PW || 'jet123' },
  lex: { id: 2, name: 'Lex', password: process.env.COACH_LEX_PW || 'lex123' },
};

// ── DB client factory (new client per request — serverless safe) ────────────
function db() {
  return new Client({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Auth token helpers ─────────────────────────────────────────────────────
async function validateToken(token, pg) {
  if (!token) return null;
  const r = await pg.query(
    `SELECT coach_id, coach_name, coach_username, expires_at
     FROM admin_sessions WHERE token=$1 LIMIT 1`, [token]
  );
  const s = r.rows[0];
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    await pg.query(`DELETE FROM admin_sessions WHERE token=$1`, [token]);
    return null;
  }
  return s;
}

// ── Code generation ────────────────────────────────────────────────────────
function ini(name) {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || 'XX').toUpperCase().padEnd(2, 'X');
}

async function generateCodes(name, partnerName = '', pg) {
  for (let i = 0; i < 30; i++) {
    const digits = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    const code   = ini(name) + digits;
    const r = await pg.query(
      `SELECT id FROM clients WHERE code=$1 OR partner_code=$1 LIMIT 1`, [code]
    );
    if (r.rows.length) continue;

    if (partnerName) {
      let ini2 = ini(partnerName);
      if (ini2 === ini(name)) {
        const l = partnerName.replace(/[^a-zA-Z]/g, '');
        ini2 = ((l[0] || 'X') + (l[l.length - 1] || 'X')).toUpperCase();
      }
      const pCode = ini2 + digits;
      const r2 = await pg.query(
        `SELECT id FROM clients WHERE code=$1 OR partner_code=$1 LIMIT 1`, [pCode]
      );
      if (r2.rows.length) continue;
      return { digits, code, partnerCode: pCode };
    }
    return { digits, code };
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q      = req.query || {};
  const action = q.action || '';
  let body = {};
  if (req.body) body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();

  const ok  = (d, s = 200)   => { pg.end().catch(() => {}); return res.status(s).json(d); };
  const err = (msg, s = 400) => { pg.end().catch(() => {}); return res.status(s).json({ error: msg }); };

  const pg = db();
  try {
    await pg.connect();
  } catch (e) {
    return res.status(500).json({ error: 'DB connection failed: ' + e.message });
  }

  async function mustLogin() {
    const s = await validateToken(token, pg);
    if (!s) throw { _err: true, msg: 'Unauthorized', code: 401 };
    return s;
  }

  try {
    switch (action) {

      // ── Client: verify code ──────────────────────────────────────────────
      case 'verify': {
        const code = (q.code || '').toUpperCase().trim();
        if (code.length !== 8) return ok({ mode: 'invalid' });
        const r = await pg.query(
          `SELECT type FROM clients WHERE code=$1 OR partner_code=$1 LIMIT 1`, [code]
        );
        return r.rows.length ? ok({ mode: 'input', type: r.rows[0].type }) : ok({ mode: 'invalid' });
      }

      // ── Client: next session number ──────────────────────────────────────
      case 'next_session': {
        const code = (q.code || '').toUpperCase().trim();
        const r = await pg.query(
          `SELECT session_number FROM sessions WHERE client_code=$1 ORDER BY session_number DESC LIMIT 1`, [code]
        );
        return ok({ next: (r.rows[0]?.session_number || 0) + 1 });
      }

      // ── Client: submit session ───────────────────────────────────────────
      case 'submit': {
        const code   = (body.kode || '').toUpperCase();
        const sesiKe = parseInt(body.sesi) || 1;
        const tipe   = body.tipe || 'PRIBADI';

        const valid = await pg.query(
          `SELECT id FROM clients WHERE code=$1 OR partner_code=$1 LIMIT 1`, [code]
        );
        if (!valid.rows.length) return err('Invalid code', 403);

        const dup = await pg.query(
          `SELECT id FROM sessions WHERE client_code=$1 AND session_number=$2 AND type=$3 LIMIT 1`,
          [code, sesiKe, tipe]
        );
        if (dup.rows.length) return ok({ success: true, duplicate: true });

        await pg.query(`
          INSERT INTO sessions (client_code,session_number,type,date,skor1,skor2,skor3,skor4,skor5,total)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [code, sesiKe, tipe,
            body.tanggal || new Date().toISOString().split('T')[0],
            parseFloat(body.skor1)||0, parseFloat(body.skor2)||0, parseFloat(body.skor3)||0,
            parseFloat(body.skor4)||0, parseFloat(body.skor5)||0, parseFloat(body.total)||0]);
        return ok({ success: true });
      }

      // ── Coach: auto-login via secret code ───────────────────────────────
      case 'autologin': {
        const secrets = {
          [process.env.SECRET_JET || '102132']: 'jet',
          [process.env.SECRET_LEX || '010203']: 'lex',
        };
        const username = secrets[(body.secret || '').trim()];
        if (!username) return err('Invalid', 403);
        const coach    = COACHES[username];
        const newToken = randomUUID();
        const expires  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pg.query(
          `INSERT INTO admin_sessions (token,coach_id,coach_name,coach_username,expires_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [newToken, coach.id, coach.name, username, expires]
        );
        return ok({ success: true, name: coach.name, token: newToken });
      }

      // ── Coach: login ─────────────────────────────────────────────────────
      case 'login': {
        const username = (body.username || '').toLowerCase().trim();
        const coach    = COACHES[username];
        if (!coach || coach.password !== body.password) return err('Invalid credentials', 401);
        const newToken = randomUUID();
        const expires  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pg.query(
          `INSERT INTO admin_sessions (token,coach_id,coach_name,coach_username,expires_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [newToken, coach.id, coach.name, username, expires]
        );
        return ok({ success: true, name: coach.name, token: newToken });
      }

      // ── Coach: logout ────────────────────────────────────────────────────
      case 'logout': {
        if (token) await pg.query(`DELETE FROM admin_sessions WHERE token=$1`, [token]);
        return ok({ success: true });
      }

      // ── Coach: check session ─────────────────────────────────────────────
      case 'me': {
        const s = await validateToken(token, pg);
        return s
          ? ok({ loggedIn: true, name: s.coach_name, username: s.coach_username })
          : ok({ loggedIn: false });
      }

      // ── Coach: list clients ──────────────────────────────────────────────
      case 'clients': {
        const session = await mustLogin();
        const cr = await pg.query(
          `SELECT * FROM clients WHERE coach_id=$1 ORDER BY created_at DESC`, [session.coach_id]
        );
        const clients = cr.rows;

        for (const c of clients) {
          const codes = c.partner_code ? [c.code, c.partner_code] : [c.code];
          const sr = await pg.query(
            `SELECT session_number, date, total, client_code FROM sessions
             WHERE client_code = ANY($1) ORDER BY session_number ASC, client_code ASC`,
            [codes]
          );
          const sessions = sr.rows;
          c.session_count     = sessions.length;
          c.last_session_date = sessions.length ? sessions[sessions.length-1].date : null;
          c.max_session       = sessions.length ? Math.max(...sessions.map(s => s.session_number)) : 0;

          c.score_summary = codes.map(code => {
            const ps = sessions.filter(s => s.client_code === code)
              .sort((a,b) => parseInt(a.session_number)-parseInt(b.session_number));
            const totals = ps.map(s => parseFloat(s.total)||0);
            const pcts   = totals.slice(1).map((t,i) =>
              totals[i] > 0 ? Math.round((t-totals[i])/totals[i]*100) : 0);
            return { code, latest: totals.length ? totals[totals.length-1] : null, pcts };
          });

          if (c.partner_code) {
            const ps0 = sessions.filter(s => s.client_code === c.code)
              .sort((a,b) => parseInt(a.session_number)-parseInt(b.session_number));
            const ps1 = sessions.filter(s => s.client_code === c.partner_code)
              .sort((a,b) => parseInt(a.session_number)-parseInt(b.session_number));
            const minLen = Math.min(ps0.length, ps1.length);
            const combined = [];
            for (let i=0; i<minLen; i++) combined.push((parseFloat(ps0[i].total)||0)+(parseFloat(ps1[i].total)||0));
            const cPcts = combined.slice(1).map((t,i) => combined[i]>0 ? Math.round((t-combined[i])/combined[i]*100) : 0);
            c.score_combined = { latest: combined.length ? combined[combined.length-1] : null, pcts: cPcts };
          }
        }
        return ok(clients);
      }

      // ── Coach: create client ─────────────────────────────────────────────
      case 'create_client': {
        const session     = await mustLogin();
        const name        = (body.name || '').trim();
        const partnerName = (body.partner_name || '').trim();
        const type        = body.type || 'single';
        if (!name) return err('Name required');
        if (type === 'couple' && !partnerName) return err('Partner name required');

        const codes = await generateCodes(name, type === 'couple' ? partnerName : '', pg);
        if (!codes) return err('Could not generate unique code', 500);

        const r = await pg.query(`
          INSERT INTO clients (coach_id,name,phone,type,code,group_prefix,partner_code,partner_name,partner_phone)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
        `, [session.coach_id, name, (body.phone||'').trim(), type, codes.code, codes.digits,
            type === 'couple' ? codes.partnerCode : null,
            type === 'couple' ? partnerName : null,
            type === 'couple' ? (body.partner_phone||'').trim() : null]);
        return ok({ success: true, client: r.rows[0] });
      }

      // ── Coach: delete client ─────────────────────────────────────────────
      case 'delete_client': {
        const session = await mustLogin();
        const cid = parseInt(body.id);
        const r = await pg.query(
          `SELECT id,code,partner_code FROM clients WHERE id=$1 AND coach_id=$2 LIMIT 1`,
          [cid, session.coach_id]
        );
        if (!r.rows.length) return err('Forbidden', 403);
        const cl = r.rows[0];
        const codes = [cl.code, cl.partner_code].filter(Boolean);
        await pg.query(`DELETE FROM sessions WHERE client_code = ANY($1)`, [codes]);
        await pg.query(`DELETE FROM clients WHERE id=$1`, [cid]);
        return ok({ success: true });
      }

      // ── Coach: get client session data ───────────────────────────────────
      case 'client_data': {
        const session = await mustLogin();
        const cid = parseInt(q.id);
        const r = await pg.query(
          `SELECT * FROM clients WHERE id=$1 AND coach_id=$2 LIMIT 1`,
          [cid, session.coach_id]
        );
        if (!r.rows.length) return err('Forbidden', 403);
        const client = r.rows[0];
        const codes  = [client.code, client.partner_code].filter(Boolean);
        const sr = await pg.query(
          `SELECT id,client_code,type,session_number,date,skor1,skor2,skor3,skor4,skor5,total
           FROM sessions WHERE client_code = ANY($1)
           ORDER BY session_number ASC, created_at ASC`,
          [codes]
        );
        const sessions = sr.rows.map(s => ({
          id: s.id, kode: s.client_code, tipe: s.type, sesi: s.session_number,
          tanggal: s.date, skor1: s.skor1, skor2: s.skor2, skor3: s.skor3,
          skor4: s.skor4, skor5: s.skor5, total: s.total,
        }));
        return ok({ success: true, client, sessions });
      }

      // ── Coach: update session scores ─────────────────────────────────────
      case 'update_session': {
        const session = await mustLogin();
        const sid  = parseInt(body.id);
        const code = (body.client_code || '').toUpperCase();
        const cr = await pg.query(
          `SELECT id FROM clients WHERE (code=$1 OR partner_code=$1) AND coach_id=$2 LIMIT 1`,
          [code, session.coach_id]
        );
        if (!cr.rows.length) return err('Forbidden', 403);
        const s1=parseFloat(body.skor1)||0, s2=parseFloat(body.skor2)||0,
              s3=parseFloat(body.skor3)||0, s4=parseFloat(body.skor4)||0, s5=parseFloat(body.skor5)||0;
        await pg.query(
          `UPDATE sessions SET skor1=$1,skor2=$2,skor3=$3,skor4=$4,skor5=$5,total=$6 WHERE id=$7`,
          [s1,s2,s3,s4,s5,s1+s2+s3+s4+s5,sid]
        );
        return ok({ success: true });
      }

      // ── Coach: delete single session ─────────────────────────────────────
      case 'delete_session': {
        const session = await mustLogin();
        const sid = parseInt(body.id);
        const sr = await pg.query(`SELECT client_code FROM sessions WHERE id=$1 LIMIT 1`, [sid]);
        if (!sr.rows.length) return err('Not found', 404);
        const code = sr.rows[0].client_code;
        const cr = await pg.query(
          `SELECT id FROM clients WHERE (code=$1 OR partner_code=$1) AND coach_id=$2 LIMIT 1`,
          [code, session.coach_id]
        );
        if (!cr.rows.length) return err('Forbidden', 403);
        await pg.query(`DELETE FROM sessions WHERE id=$1`, [sid]);
        return ok({ success: true });
      }

      default:
        return err('Unknown action', 404);
    }
  } catch (e) {
    if (e._err) return err(e.msg, e.code);
    console.error(e);
    return err('Server error: ' + e.message, 500);
  }
};
