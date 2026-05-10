// QuickRebas API v7 — Supabase database

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

// ── Supabase REST ─────────────────────────────────────────────────────────────
function supaReq(method, path, body) {
  const url  = (process.env.SUPABASE_URL || '').replace('https://', '').replace(/\/$/, '');
  const key  = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_KEY not set');

  const bodyStr = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url,
      path: '/rest/v1/' + path,
      method,
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': path.includes('on_conflict') ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: data ? JSON.parse(data) : null, raw: data }); }
        catch(e) { resolve({ status: r.statusCode, data: null, raw: data }); }
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
  return { ok: r.status === 201 || r.status === 200, status: r.status, error: r.raw };
}

async function dbUpdate(table, col, val, updates) {
  const r = await supaReq('PATCH', table + '?' + col + '=eq.' + encodeURIComponent(val), updates);
  return r.status === 200 || r.status === 204;
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

  // PING + DEBUG
  if (action === 'ping') {
    try {
      // Try to read the codes table
      const r = await supaReq('GET', 'codes?limit=1', null);
      // Try a test insert
      const testCode = 'TEST-' + Date.now();
      const ins = await dbInsert('codes', {
        code: testCode, book: 'TEST', status: 'unused',
        created_at: new Date().toISOString()
      });
      // Clean up test
      await supaReq('DELETE', 'codes?code=eq.' + testCode, null);

      return res({
        status: 'ok',
        message: 'QuickRebas API v7',
        tableReadStatus: r.status,
        tableReadWorks: r.status === 200,
        insertWorks: ins.ok,
        insertStatus: ins.status,
        insertError: ins.ok ? null : ins.error,
      });
    } catch(e) {
      return res({ status: 'error', error: e.message });
    }
  }

  // GENERATE
  if (action === 'generate') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });

    const book   = (body.book || 'A0').toUpperCase();
    const qty    = Math.min(parseInt(body.qty) || 10, 200);
    const now    = new Date().toISOString();
    const codes  = [];
    const errors = [];

    for (let i = 0; i < qty; i++) {
      const code = mkCode(book);
      const r    = await dbInsert('codes', {
        code, book, status: 'unused', created_at: now
      });
      if (r.ok) {
        codes.push(code);
      } else {
        errors.push({ code, status: r.status, error: r.error });
        if (errors.length === 1) break; // stop early — show first error
      }
    }

    if (errors.length > 0) {
      return res({
        status: 'error',
        message: 'Database insert failed',
        firstError: errors[0],
        saved: codes.length,
      });
    }

    return res({ status: 'ok', codes, count: codes.length });
  }

  // VERIFY
  if (action === 'verify') {
    const code = p.code;
    if (!code) return res({ status: 'invalid' });
    const row = await dbGet('codes', 'code', code);
    if (!row)                     return res({ status: 'invalid' });
    if (row.status === 'active')  return res({ status: 'used' });
    if (row.status === 'revoked') return res({ status: 'invalid' });
    return res({ status: 'valid', book: 'QuickRebas ' + row.book, level: row.book.toLowerCase() });
  }

  // ACTIVATE
  if (action === 'activate') {
    const { code, name, email, password } = body;
    if (!code || !name || !email || !password) return res({ status: 'error', message: 'Missing fields' });
    const row = await dbGet('codes', 'code', code);
    if (!row || row.status !== 'unused') return res({ status: 'error', message: 'Code not valid or already used' });
    const now = new Date().toISOString(), expiry = addMonths(6);
    await dbUpdate('codes', 'code', code, {
      status: 'active', student_name: name, email,
      activated_at: now, expires_at: expiry
    });
    await dbInsert('students', {
      name, email, password, book: row.book,
      level: row.book.toLowerCase(), code,
      activated_at: now, expires_at: expiry
    });
    return res({ status: 'ok', expiry, book: 'QuickRebas ' + row.book, level: row.book.toLowerCase() });
  }

  // SIGNIN
  if (action === 'signin') {
    const { email, password } = body;
    if (!email || !password) return res({ status: 'error', message: 'Missing email or password' });
    const row = await dbGet('students', 'email', email);
    if (!row) return res({ status: 'error', message: 'No account found for this email. Please check your email or activate your code first.' });
    if (row.password !== password) return res({ status: 'error', message: 'Wrong password. Please try again.' });
    if (new Date(row.expires_at) < new Date()) return res({ status: 'error', message: 'Your access has expired. Please purchase a new workbook.' });
    const ce = await dbGet('codes', 'code', row.code);
    if (!ce || ce.status === 'revoked') return res({ status: 'error', message: 'Your access has been revoked. Please contact your teacher.' });
    return res({ status: 'ok', student: {
      name: row.name, email: row.email, book: row.book,
      level: row.level, code: row.code, expiresAt: row.expires_at
    }});
  }

  // LIST CODES
  if (action === 'listCodes') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const rows  = await dbList('codes', 'order=created_at.desc');
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
    // Use upsert — inserts if not exists, updates if exists
    const r = await supaReq('POST', 'settings?on_conflict=key', {
      key: 'audio_urls',
      value: JSON.stringify(body.urls || {})
    });
    const ok = r.status === 200 || r.status === 201;
    return res({ status: ok ? 'ok' : 'error', httpStatus: r.status, detail: ok ? null : r.raw });
  }

  // GET AUDIO
  if (action === 'getAudio') {
    const r = await supaReq('GET', 'settings?key=eq.audio_urls&limit=1', null);
    if (r.status !== 200 || !r.data || !r.data.length) {
      return res({ status: 'ok', urls: {} });
    }
    try {
      const urls = JSON.parse(r.data[0].value);
      return res({ status: 'ok', urls });
    } catch(e) {
      return res({ status: 'ok', urls: {} });
    }
  }

  return res({ status: 'ok', message: 'QuickRebas API v7' });
};
