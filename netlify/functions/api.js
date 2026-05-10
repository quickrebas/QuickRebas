// QuickRebas API v7 — uses Supabase (free, reliable, zero config issues)

const https = require('https');

function res(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(data),
  };
}

function rnd(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function mkCode(book) {
  return 'QR-' + book.toUpperCase() + '-' + rnd(4) + '-' + rnd(4);
}
function fmt(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }
  catch(e) { return iso; }
}
function addMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

// ── Supabase REST API ─────────────────────────────────────────────────────────
function supaReq(method, path, body) {
  const url   = process.env.SUPABASE_URL;
  const key   = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_KEY not set');

  const host     = url.replace('https://', '');
  const bodyStr  = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: '/rest/v1/' + path,
      method,
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: data ? JSON.parse(data) : null }); }
        catch(e) { resolve({ status: r.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function dbGet(table, col, val) {
  const r = await supaReq('GET', table + '?' + col + '=eq.' + encodeURIComponent(val) + '&limit=1', null);
  if (r.status !== 200 || !r.data || !r.data.length) return null;
  return r.data[0];
}

async function dbInsert(table, row) {
  const r = await supaReq('POST', table, row);
  return r.status === 201 || r.status === 200;
}

async function dbUpdate(table, col, val, updates) {
  const r = await supaReq('PATCH', table + '?' + col + '=eq.' + encodeURIComponent(val), updates);
  return r.status === 200;
}

async function dbList(table, filters) {
  let path = table;
  if (filters) path += '?' + filters;
  const r = await supaReq('GET', path, null);
  if (r.status !== 200) return [];
  return r.data || [];
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return res({ ok: true });

  const p      = event.queryStringParameters || {};
  const action = p.action || '';
  const PASS   = process.env.ADMIN_PASS || 'quickrebas2025';

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  // PING
  if (action === 'ping') {
    try {
      const r = await supaReq('GET', 'codes?limit=1', null);
      return res({ status: 'ok', message: 'QuickRebas API v7 — Supabase', dbWorking: r.status === 200, dbStatus: r.status });
    } catch(e) {
      return res({ status: 'ok', message: 'QuickRebas API v7', dbWorking: false, error: e.message });
    }
  }

  // GENERATE
  if (action === 'generate') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const book  = (body.book || 'A0').toUpperCase();
    const qty   = Math.min(parseInt(body.qty) || 10, 200);
    const now   = new Date().toISOString();
    const codes = [];

    for (let i = 0; i < qty; i++) {
      const code = mkCode(book);
      const ok   = await dbInsert('codes', { code, book, status: 'unused', created_at: now });
      if (ok) codes.push(code);
    }
    return res({ status: 'ok', codes, count: codes.length });
  }

  // VERIFY
  if (action === 'verify') {
    const code = p.code;
    if (!code) return res({ status: 'invalid' });
    const row = await dbGet('codes', 'code', code);
    if (!row)                      return res({ status: 'invalid' });
    if (row.status === 'active')   return res({ status: 'used' });
    if (row.status === 'revoked')  return res({ status: 'invalid' });
    return res({ status: 'valid', book: 'QuickRebas ' + row.book, level: row.book.toLowerCase() });
  }

  // ACTIVATE
  if (action === 'activate') {
    const { code, name, email } = body;
    if (!code || !name || !email) return res({ status: 'error', message: 'Missing fields' });
    const row = await dbGet('codes', 'code', code);
    if (!row || row.status !== 'unused') return res({ status: 'error', message: 'Code not valid or already used' });
    const now = new Date().toISOString(), expiry = addMonths(6);
    await dbUpdate('codes', 'code', code, { status: 'active', student_name: name, email, activated_at: now, expires_at: expiry });
    await dbInsert('students', { name, email, book: row.book, level: row.book.toLowerCase(), code, activated_at: now, expires_at: expiry });
    return res({ status: 'ok', expiry, book: 'QuickRebas ' + row.book, level: row.book.toLowerCase() });
  }

  // SIGNIN
  if (action === 'signin') {
    const row = await dbGet('students', 'email', body.email);
    if (!row) return res({ status: 'error', message: 'No account found' });
    if (new Date(row.expires_at) < new Date()) return res({ status: 'error', message: 'Access expired' });
    const ce = await dbGet('codes', 'code', row.code);
    if (!ce || ce.status === 'revoked') return res({ status: 'error', message: 'Access revoked' });
    return res({ status: 'ok', student: { name: row.name, email: row.email, book: row.book, level: row.level, code: row.code, expiresAt: row.expires_at } });
  }

  // LIST CODES
  if (action === 'listCodes') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const rows = await dbList('codes', 'order=created_at.desc');
    const codes = rows.map(r => ({
      code: r.code, book: r.book, status: r.status,
      student: r.student_name || '', email: r.email || '',
      activated: fmt(r.activated_at), expires: fmt(r.expires_at),
    }));
    return res({ status: 'ok', codes, total: codes.length });
  }

  // LIST STUDENTS
  if (action === 'listStudents') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const rows = await dbList('students', 'order=activated_at.desc');
    return res({ status: 'ok', students: rows });
  }

  // REVOKE
  if (action === 'revoke') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    await dbUpdate('codes', 'code', p.code, { status: 'revoked' });
    return res({ status: 'ok' });
  }

  // SAVE AUDIO
  if (action === 'saveAudio') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const existing = await dbGet('settings', 'key', 'audio_urls');
    if (existing) {
      await dbUpdate('settings', 'key', 'audio_urls', { value: JSON.stringify(body.urls || {}) });
    } else {
      await dbInsert('settings', { key: 'audio_urls', value: JSON.stringify(body.urls || {}) });
    }
    return res({ status: 'ok' });
  }

  // GET AUDIO
  if (action === 'getAudio') {
    const row = await dbGet('settings', 'key', 'audio_urls');
    const urls = row ? JSON.parse(row.value) : {};
    return res({ status: 'ok', urls });
  }

  return res({ status: 'ok', message: 'QuickRebas API v7' });
};
