// QuickRebas API v6
// Passes siteID + token explicitly to @netlify/blobs

const { getStore } = require('@netlify/blobs');

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

// ── Get the store with explicit credentials ───────────────────────────────
function store() {
  const siteID = process.env.QR_SITE_ID
               || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN
               || process.env.NETLIFY_ACCESS_TOKEN
               || process.env.TOKEN;

  if (!siteID || !token) {
    throw new Error('Missing siteID or token. Set NETLIFY_TOKEN in environment variables.');
  }

  return getStore({
    name: 'quickrebas',
    siteID,
    token,
    consistency: 'strong',
  });
}

async function dbGet(key) {
  try {
    const val = await store().get(key, { type: 'json' });
    return val;
  } catch(e) {
    console.log('dbGet error:', key, e.message);
    return null;
  }
}

async function dbSet(key, val) {
  try {
    await store().setJSON(key, val);
    return true;
  } catch(e) {
    console.log('dbSet error:', key, e.message);
    return false;
  }
}

async function getIndex() {
  const idx = await dbGet('__index__');
  return idx || { codes: [], students: [] };
}
async function saveIndex(idx) {
  return dbSet('__index__', idx);
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
      await store().setJSON('__ping__', { t: Date.now() });
      const back = await store().get('__ping__', { type: 'json' });
      const idx  = await getIndex();
      return res({
        status: 'ok',
        message: 'QuickRebas API v6',
        blobsWorking: !!back,
        indexCodeCount: idx.codes.length,
        indexStudentCount: idx.students.length,
        siteID: process.env.QR_SITE_ID || process.env.NETLIFY_SITE_ID || 'NOT SET',
        hasToken: !!(process.env.NETLIFY_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || process.env.TOKEN),
      });
    } catch(e) {
      return res({
        status: 'ok',
        message: 'QuickRebas API v6',
        blobsWorking: false,
        error: e.message,
        siteID: process.env.QR_SITE_ID || process.env.NETLIFY_SITE_ID || 'NOT SET',
        hasToken: !!(process.env.NETLIFY_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || process.env.TOKEN),
      });
    }
  }

  // GENERATE
  if (action === 'generate') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const book  = (body.book || 'A0').toUpperCase();
    const qty   = Math.min(parseInt(body.qty) || 10, 500);
    const now   = new Date().toISOString();
    const codes = [];
    const idx   = await getIndex();
    for (let i = 0; i < qty; i++) {
      const code = mkCode(book);
      const ok   = await dbSet('code:' + code, { code, book, status: 'unused', createdAt: now });
      if (ok) { idx.codes.push(code); codes.push(code); }
    }
    await saveIndex(idx);
    return res({ status: 'ok', codes, count: codes.length, totalInIndex: idx.codes.length });
  }

  // VERIFY
  if (action === 'verify') {
    const code = p.code;
    if (!code) return res({ status: 'invalid' });
    const entry = await dbGet('code:' + code);
    if (!entry)                     return res({ status: 'invalid' });
    if (entry.status === 'active')  return res({ status: 'used' });
    if (entry.status === 'revoked') return res({ status: 'invalid' });
    return res({ status: 'valid', book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // ACTIVATE
  if (action === 'activate') {
    const { code, name, email } = body;
    if (!code || !name || !email) return res({ status: 'error', message: 'Missing fields' });
    const entry = await dbGet('code:' + code);
    if (!entry || entry.status !== 'unused') return res({ status: 'error', message: 'Code not valid or already used' });
    const now = new Date().toISOString(), expiry = addMonths(6);
    entry.status = 'active'; entry.studentName = name; entry.email = email;
    entry.activatedAt = now; entry.expiresAt = expiry;
    await dbSet('code:' + code, entry);
    const student = { name, email, book: entry.book, level: entry.book.toLowerCase(), code, activatedAt: now, expiresAt: expiry };
    await dbSet('student:' + email, student);
    const idx = await getIndex();
    if (!idx.students.includes(email)) { idx.students.push(email); await saveIndex(idx); }
    return res({ status: 'ok', expiry, book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // SIGNIN
  if (action === 'signin') {
    const student = await dbGet('student:' + body.email);
    if (!student) return res({ status: 'error', message: 'No account found' });
    if (new Date(student.expiresAt) < new Date()) return res({ status: 'error', message: 'Access expired' });
    const ce = await dbGet('code:' + student.code);
    if (!ce || ce.status === 'revoked') return res({ status: 'error', message: 'Access revoked' });
    return res({ status: 'ok', student });
  }

  // LIST CODES
  if (action === 'listCodes') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
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
      codes.push({ code: entry.code, book: entry.book, status: entry.status, student: entry.studentName || '', email: entry.email || '', activated: fmt(entry.activatedAt), expires: fmt(entry.expiresAt) });
    }
    return res({ status: 'ok', codes, total: codes.length });
  }

  // LIST STUDENTS
  if (action === 'listStudents') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const idx = await getIndex();
    const students = [];
    for (const email of idx.students) {
      const s = await dbGet('student:' + email);
      if (s) students.push(s);
    }
    return res({ status: 'ok', students });
  }

  // REVOKE
  if (action === 'revoke') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const entry = await dbGet('code:' + p.code);
    if (!entry) return res({ status: 'error', message: 'Code not found' });
    entry.status = 'revoked';
    await dbSet('code:' + p.code, entry);
    return res({ status: 'ok' });
  }

  // SAVE AUDIO
  if (action === 'saveAudio') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' });
    const saved = await dbSet('audio_urls', body.urls || {});
    return res({ status: saved ? 'ok' : 'error' });
  }

  // GET AUDIO
  if (action === 'getAudio') {
    const urls = await dbGet('audio_urls');
    return res({ status: 'ok', urls: urls || {} });
  }

  return res({ status: 'ok', message: 'QuickRebas API v6' });
};
