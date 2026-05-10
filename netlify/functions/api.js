// QuickRebas API v3
// Uses @netlify/blobs which is pre-installed on all Netlify functions — no package.json needed

const { getStore } = require('@netlify/blobs');

function cors(data, status) {
  return {
    statusCode: status || 200,
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
  return `QR-${book.toUpperCase()}-${rnd(4)}-${rnd(4)}`;
}

function fmt(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch(e) { return iso; }
}

// ── DB helpers using Netlify Blobs ──────────────────────────────────────────

async function dbGet(key) {
  try {
    const store = getStore('quickrebas');
    const val   = await store.get(key, { type: 'json' });
    return val;
  } catch(e) {
    return null;
  }
}

async function dbSet(key, val) {
  try {
    const store = getStore('quickrebas');
    await store.setJSON(key, val);
    return true;
  } catch(e) {
    console.error('dbSet error:', e.message);
    return false;
  }
}

// We keep one master index object: { codes: [...], students: [...] }
async function getIndex() {
  const idx = await dbGet('__index__');
  return idx || { codes: [], students: [] };
}

async function saveIndex(idx) {
  return await dbSet('__index__', idx);
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') return cors({ ok: true });

  const p      = event.queryStringParameters || {};
  const action = p.action || '';
  const PASS   = process.env.ADMIN_PASS || 'quickrebas2025';

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch(e) {}
  }

  // ── PING — test that the function is working ────────────────────────────
  if (action === 'ping') {
    return cors({ status: 'ok', message: 'QuickRebas API v3 is running' });
  }

  // ── GENERATE CODES ──────────────────────────────────────────────────────
  if (action === 'generate') {
    if (body.adminPass !== PASS) return cors({ status: 'error', message: 'Wrong password' }, 401);

    const book   = (body.book || 'A0').toUpperCase();
    const qty    = Math.min(parseInt(body.qty) || 10, 500);
    const now    = new Date().toISOString();
    const idx    = await getIndex();
    const codes  = [];

    for (let i = 0; i < qty; i++) {
      const code  = mkCode(book);
      const entry = { code, book, status: 'unused', createdAt: now };
      await dbSet('code:' + code, entry);
      idx.codes.push(code);
      codes.push(code);
    }

    await saveIndex(idx);
    return cors({ status: 'ok', codes, count: codes.length });
  }

  // ── VERIFY CODE ─────────────────────────────────────────────────────────
  if (action === 'verify') {
    const code  = p.code;
    if (!code) return cors({ status: 'invalid' });

    const entry = await dbGet('code:' + code);
    if (!entry)                     return cors({ status: 'invalid' });
    if (entry.status === 'active')  return cors({ status: 'used' });
    if (entry.status === 'revoked') return cors({ status: 'invalid' });

    return cors({ status: 'valid', book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // ── ACTIVATE CODE ───────────────────────────────────────────────────────
  if (action === 'activate') {
    const { code, name, email, password } = body;
    if (!code || !name || !email) return cors({ status: 'error', message: 'Missing fields' });

    const entry = await dbGet('code:' + code);
    if (!entry || entry.status !== 'unused') {
      return cors({ status: 'error', message: 'Code is not valid or already used' });
    }

    const now    = new Date().toISOString();
    const expiry = (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString(); })();

    entry.status      = 'active';
    entry.studentName = name;
    entry.email       = email;
    entry.activatedAt = now;
    entry.expiresAt   = expiry;
    await dbSet('code:' + code, entry);

    const student = { name, email, book: entry.book, level: entry.book.toLowerCase(), code, activatedAt: now, expiresAt: expiry };
    await dbSet('student:' + email, student);

    const idx = await getIndex();
    if (!idx.students.includes(email)) {
      idx.students.push(email);
      await saveIndex(idx);
    }

    return cors({ status: 'ok', expiry, book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // ── SIGN IN ─────────────────────────────────────────────────────────────
  if (action === 'signin') {
    const student = await dbGet('student:' + body.email);
    if (!student) return cors({ status: 'error', message: 'No account found for this email' });
    if (new Date(student.expiresAt) < new Date()) return cors({ status: 'error', message: 'Access expired. Please buy a new workbook.' });

    const ce = await dbGet('code:' + student.code);
    if (!ce || ce.status === 'revoked') return cors({ status: 'error', message: 'Access revoked. Contact your teacher.' });

    return cors({ status: 'ok', student });
  }

  // ── LIST CODES (admin) ──────────────────────────────────────────────────
  if (action === 'listCodes') {
    if (p.adminPass !== PASS) return cors({ status: 'error', message: 'Wrong password' }, 401);

    const idx   = await getIndex();
    const codes = [];
    const now   = new Date();

    for (const key of idx.codes) {
      const entry = await dbGet('code:' + key);
      if (!entry) continue;

      if (entry.status === 'active' && entry.expiresAt && new Date(entry.expiresAt) < now) {
        entry.status = 'expired';
        await dbSet('code:' + key, entry);
      }

      codes.push({
        code:      entry.code,
        book:      entry.book,
        status:    entry.status,
        student:   entry.studentName || '',
        email:     entry.email || '',
        activated: fmt(entry.activatedAt),
        expires:   fmt(entry.expiresAt),
      });
    }

    return cors({ status: 'ok', codes });
  }

  // ── LIST STUDENTS (admin) ───────────────────────────────────────────────
  if (action === 'listStudents') {
    if (p.adminPass !== PASS) return cors({ status: 'error', message: 'Wrong password' }, 401);

    const idx      = await getIndex();
    const students = [];

    for (const email of idx.students) {
      const s = await dbGet('student:' + email);
      if (s) students.push(s);
    }

    return cors({ status: 'ok', students });
  }

  // ── REVOKE CODE (admin) ─────────────────────────────────────────────────
  if (action === 'revoke') {
    if (p.adminPass !== PASS) return cors({ status: 'error', message: 'Wrong password' }, 401);

    const entry = await dbGet('code:' + p.code);
    if (!entry) return cors({ status: 'error', message: 'Code not found' });

    entry.status = 'revoked';
    await dbSet('code:' + p.code, entry);
    return cors({ status: 'ok' });
  }

  // ── SAVE AUDIO URLS (admin) ─────────────────────────────────────────────
  if (action === 'saveAudio') {
    if (body.adminPass !== PASS) return cors({ status: 'error', message: 'Wrong password' }, 401);
    await dbSet('audio_urls', body.urls || {});
    return cors({ status: 'ok' });
  }

  // ── GET AUDIO URLS (public) ─────────────────────────────────────────────
  if (action === 'getAudio') {
    const urls = await dbGet('audio_urls');
    return cors({ status: 'ok', urls: urls || {} });
  }

  return cors({ status: 'ok', message: 'QuickRebas API v3' });
};
