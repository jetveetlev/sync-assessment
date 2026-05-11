// Netlify Serverless Function — Sync Assessment API
// Node 18+ (built-in fetch, crypto.randomUUID)
const { randomUUID } = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const COACHES = {
  jet: { id: 1, name: 'Jet', password: process.env.COACH_JET_PW || 'jet123' },
  lex: { id: 2, name: 'Lex', password: process.env.COACH_LEX_PW || 'lex123' },
};

// ── Supabase REST helper ───────────────────────────────────────────────────
async function sb(table, method = 'GET', data = null, filters = {}) {
  const params = new URLSearchParams(filters).toString();
  const url    = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation',
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });

  const body = await res.json().catch(() => []);
  return { code: res.status, data: body };
}

// ── Auth token helpers ─────────────────────────────────────────────────────
async function validateToken(token) {
  if (!token) return null;
  const r = await sb('admin_sessions', 'GET', null, {
    token:   `eq.${token}`,
    select:  'coach_id,coach_name,coach_username,expires_at',
    limit:   '1',
  });
  const s = r.data?.[0];
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    await sb('admin_sessions', 'DELETE', null, { token: `eq.${token}` });
    return null;
  }
  return s;
}

// ── Code generation ────────────────────────────────────────────────────────
function ini(name) {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || 'XX').toUpperCase().padEnd(2, 'X');
}

async function generateCodes(name, partnerName = '') {
  for (let i = 0; i < 30; i++) {
    const digits = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    const code   = ini(name) + digits;

    const r = await sb('clients', 'GET', null, { or: `(code.eq.${code},partner_code.eq.${code})`, select: 'id' });
    if (r.data?.length) continue;

    if (partnerName) {
      let ini2 = ini(partnerName);
      if (ini2 === ini(name)) {
        const l = partnerName.replace(/[^a-zA-Z]/g, '');
        ini2    = ((l[0] || 'X') + (l[l.length - 1] || 'X')).toUpperCase();
      }
      const pCode = ini2 + digits;
      const r2 = await sb('clients', 'GET', null, { or: `(code.eq.${pCode},partner_code.eq.${pCode})`, select: 'id' });
      if (r2.data?.length) continue;
      return { digits, code, partnerCode: pCode };
    }
    return { digits, code };
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const q      = event.queryStringParameters || {};
  const action = q.action || '';
  const body   = event.body ? JSON.parse(event.body) : {};
  const token  = (event.headers['authorization'] || '').replace('Bearer ', '').trim();

  const ok  = (d, s = 200)  => ({ statusCode: s, headers: CORS, body: JSON.stringify(d) });
  const err = (msg, s = 400) => ({ statusCode: s, headers: CORS, body: JSON.stringify({ error: msg }) });

  async function mustLogin() {
    const s = await validateToken(token);
    if (!s) throw { _err: true, msg: 'Unauthorized', code: 401 };
    return s;
  }

  try {
    switch (action) {

      // ── Client: verify code ──────────────────────────────────────────────
      case 'verify': {
        const code = (q.code || '').toUpperCase().trim();
        if (code.length !== 8) return ok({ mode: 'invalid' });
        const r = await sb('clients', 'GET', null, {
          or: `(code.eq.${code},partner_code.eq.${code})`, select: 'type', limit: '1',
        });
        return r.data?.length ? ok({ mode: 'input', type: r.data[0].type }) : ok({ mode: 'invalid' });
      }

      // ── Client: next session number ──────────────────────────────────────
      case 'next_session': {
        const code = (q.code || '').toUpperCase().trim();
        const r    = await sb('sessions', 'GET', null, {
          client_code: `eq.${code}`, select: 'session_number', order: 'session_number.desc', limit: '1',
        });
        return ok({ next: (r.data?.[0]?.session_number || 0) + 1 });
      }

      // ── Client: submit session ───────────────────────────────────────────
      case 'submit': {
        const code   = (body.kode || '').toUpperCase();
        const sesiKe = parseInt(body.sesi) || 1;
        const tipe   = body.tipe || 'PRIBADI';

        const valid = await sb('clients', 'GET', null, {
          or: `(code.eq.${code},partner_code.eq.${code})`, select: 'id', limit: '1',
        });
        if (!valid.data?.length) return err('Invalid code', 403);

        const dup = await sb('sessions', 'GET', null, {
          client_code: `eq.${code}`, session_number: `eq.${sesiKe}`, type: `eq.${tipe}`, select: 'id', limit: '1',
        });
        if (dup.data?.length) return ok({ success: true, duplicate: true });

        const row = {
          client_code:    code,
          session_number: sesiKe,
          type:           tipe,
          date:           body.tanggal || new Date().toISOString().split('T')[0],
          skor1: parseFloat(body.skor1) || 0,
          skor2: parseFloat(body.skor2) || 0,
          skor3: parseFloat(body.skor3) || 0,
          skor4: parseFloat(body.skor4) || 0,
          skor5: parseFloat(body.skor5) || 0,
          total: parseFloat(body.total) || 0,
        };
        const r = await sb('sessions', 'POST', row);
        return ok({ success: r.code === 201 });
      }

      // ── Coach: login ─────────────────────────────────────────────────────
      case 'login': {
        const username = (body.username || '').toLowerCase().trim();
        const coach    = COACHES[username];
        if (!coach || coach.password !== body.password) return err('Invalid credentials', 401);

        const newToken = randomUUID();
        const expires  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const ins = await sb('admin_sessions', 'POST', {
          token: newToken, coach_id: coach.id, coach_name: coach.name,
          coach_username: username, expires_at: expires,
        });
        console.log('INSERT admin_sessions:', ins.code, JSON.stringify(ins.data));
        return ok({ success: true, name: coach.name, token: newToken });
      }

      // ── Coach: logout ────────────────────────────────────────────────────
      case 'logout': {
        if (token) await sb('admin_sessions', 'DELETE', null, { token: `eq.${token}` });
        return ok({ success: true });
      }

      // ── Coach: check session ─────────────────────────────────────────────
      case 'me': {
        const s = await validateToken(token);
        return s
          ? ok({ loggedIn: true, name: s.coach_name, username: s.coach_username })
          : ok({ loggedIn: false });
      }

      // ── Coach: list clients ──────────────────────────────────────────────
      case 'clients': {
        const session  = await mustLogin();
        const r        = await sb('clients', 'GET', null, { coach_id: `eq.${session.coach_id}`, order: 'created_at.desc' });
        const clients  = r.data || [];

        for (const c of clients) {
          const filter = c.partner_code
            ? { or: `(client_code.eq.${c.code},client_code.eq.${c.partner_code})`, select: 'session_number,date', order: 'date.desc' }
            : { client_code: `eq.${c.code}`, select: 'session_number,date', order: 'date.desc' };
          const sr         = await sb('sessions', 'GET', null, filter);
          const sessions   = sr.data || [];
          c.session_count      = sessions.length;
          c.last_session_date  = sessions[0]?.date || null;
          c.max_session        = sessions.length ? Math.max(...sessions.map(s => s.session_number)) : 0;
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

        const codes = await generateCodes(name, type === 'couple' ? partnerName : '');
        if (!codes) return err('Could not generate unique code. Retry.', 500);

        const row = {
          coach_id:     session.coach_id,
          name,
          phone:        (body.phone || '').trim(),
          type,
          code:         codes.code,
          group_prefix: codes.digits,
          ...(type === 'couple' ? {
            partner_code:  codes.partnerCode,
            partner_name:  partnerName,
            partner_phone: (body.partner_phone || '').trim(),
          } : {}),
        };

        const result = await sb('clients', 'POST', row);
        return result.code === 201
          ? ok({ success: true, client: result.data[0] || row })
          : err('Failed to create', 500);
      }

      // ── Coach: delete client ─────────────────────────────────────────────
      case 'delete_client': {
        const session = await mustLogin();
        const cid     = parseInt(body.id);
        const r       = await sb('clients', 'GET', null, {
          id: `eq.${cid}`, coach_id: `eq.${session.coach_id}`, select: 'id,code,partner_code',
        });
        if (!r.data?.length) return err('Forbidden', 403);

        const cl = r.data[0];
        await sb('sessions', 'DELETE', null, { client_code: `eq.${cl.code}` });
        if (cl.partner_code) await sb('sessions', 'DELETE', null, { client_code: `eq.${cl.partner_code}` });
        await sb('clients',  'DELETE', null, { id: `eq.${cid}` });
        return ok({ success: true });
      }

      // ── Coach: get client session data ───────────────────────────────────
      case 'client_data': {
        const session = await mustLogin();
        const cid     = parseInt(q.id);
        const r       = await sb('clients', 'GET', null, {
          id: `eq.${cid}`, coach_id: `eq.${session.coach_id}`,
        });
        if (!r.data?.length) return err('Forbidden', 403);

        const client = r.data[0];
        const c = client.code, pc = client.partner_code;
        const filter = pc
          ? { or: `(client_code.eq.${c},client_code.eq.${pc})`, order: 'session_number.asc,created_at.asc' }
          : { client_code: `eq.${c}`, order: 'session_number.asc,created_at.asc' };

        const sr       = await sb('sessions', 'GET', null, filter);
        const sessions = (sr.data || []).map(s => ({
          kode: s.client_code, tipe: s.type, sesi: s.session_number, tanggal: s.date,
          skor1: s.skor1, skor2: s.skor2, skor3: s.skor3, skor4: s.skor4, skor5: s.skor5, total: s.total,
        }));
        return ok({ success: true, client, sessions });
      }

      default:
        return err('Unknown action', 404);
    }
  } catch (e) {
    if (e._err) return err(e.msg, e.code);
    console.error(e);
    return err('Server error', 500);
  }
};
