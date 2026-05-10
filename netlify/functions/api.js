// QuickRebas API v4
// Uses Netlify Blobs HTTP API directly with auto-injected credentials

const https = require('https');

// ── CORS response ─────────────────────────────────────────────────────────
function res(data, code) {
  return {
    statusCode: code || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(data),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
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
  try { return new Date(iso).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}); }
  catch(e) { return iso; }
}
function addMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

// ── Netlify Blobs via HTTP ────────────────────────────────────────────────
// Netlify auto-injects NETLIFY_BLOBS_CONTEXT as a base64 JSON with token + url
function getBlobConfig() {
  try {
    const ctx = JSON.parse(
      Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT || '', 'base64').toString()
    );
    return { token: ctx.token, url: ctx.url, siteId: ctx.siteId };
  } catch(e) {
    return null;
  }
}

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (chunk) => data += chunk);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function blobGet(key) {
  const cfg = getBlobConfig();
  if (!cfg) return null;
  try {
    const url = new URL(cfg.url + '/quickrebas/' + encodeURIComponent(key));
    const r = await httpRequest({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + cfg.token },
    });
    if (r.status === 404) return null;
    if (r.status !== 200) return null;
    return JSON.parse(r.body);
  } catch(e) { return null; }
}

async function blobSet(key, val) {
  const cfg = getBlobConfig();
  if (!cfg) return false;
  try {
    const body = JSON.stringify(val);
    const url  = new URL(cfg.url + '/quickrebas/' + encodeURIComponent(key));
    const r = await httpRequest({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'authorization': 'Bearer ' + cfg.token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, body);
    return r.status >= 200 && r.status < 300;
  } catch(e) { return false; }
}

// Master index — one record that lists all code keys and student keys
async function getIndex() {
  const idx = await blobGet('__index__');
  return idx || { codes: [], students: [] };
}
async function saveIndex(idx) {
  return blobSet('__index__', idx);
}

// ── DEBUG: check if blobs is configured ──────────────────────────────────
async function debugInfo() {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  if (!ctx) return { blobsConfigured: false, reason: 'NETLIFY_BLOBS_CONTEXT not set' };
  try {
    const parsed = JSON.parse(Buffer.from(ctx, 'base64').toString());
    const idx = await getIndex();
    return {
      blobsConfigured: true,
      siteId: parsed.siteId,
      hasUrl: !!parsed.url,
      indexCodeCount: idx.codes.length,
      indexStudentCount: idx.students.length,
    };
  } catch(e) {
    return { blobsConfigured: false, reason: e.message };
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return res({ ok: true });

  const p      = event.queryStringParameters || {};
  const action = p.action || '';
  const PASS   = process.env.ADMIN_PASS || 'quickrebas2025';

  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  // PING
  if (action === 'ping') {
    const info = await debugInfo();
    return res({ status: 'ok', message: 'QuickRebas API v4', ...info });
  }

  // GENERATE
  if (action === 'generate') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' }, 401);

    const cfg = getBlobConfig();
    if (!cfg) return res({ status: 'error', message: 'Database not configured. Please check Netlify Blobs is enabled for your site.' });

    const book  = (body.book || 'A0').toUpperCase();
    const qty   = Math.min(parseInt(body.qty) || 10, 500);
    const now   = new Date().toISOString();
    const idx   = await getIndex();
    const codes = [];

    for (let i = 0; i < qty; i++) {
      const code  = mkCode(book);
      const entry = { code, book, status: 'unused', createdAt: now };
      const saved = await blobSet('code:' + code, entry);
      if (saved) {
        idx.codes.push(code);
        codes.push(code);
      }
    }

    await saveIndex(idx);
    return res({ status: 'ok', codes, count: codes.length, indexSize: idx.codes.length });
  }

  // VERIFY
  if (action === 'verify') {
    const code  = p.code;
    if (!code) return res({ status: 'invalid' });
    const entry = await blobGet('code:' + code);
    if (!entry)                     return res({ status: 'invalid' });
    if (entry.status === 'active')  return res({ status: 'used' });
    if (entry.status === 'revoked') return res({ status: 'invalid' });
    return res({ status: 'valid', book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // ACTIVATE
  if (action === 'activate') {
    const { code, name, email } = body;
    if (!code || !name || !email) return res({ status: 'error', message: 'Missing fields' });

    const entry = await blobGet('code:' + code);
    if (!entry || entry.status !== 'unused') return res({ status: 'error', message: 'Code not valid or already used' });

    const now    = new Date().toISOString();
    const expiry = addMonths(6);
    entry.status = 'active'; entry.studentName = name; entry.email = email;
    entry.activatedAt = now; entry.expiresAt = expiry;
    await blobSet('code:' + code, entry);

    const student = { name, email, book: entry.book, level: entry.book.toLowerCase(), code, activatedAt: now, expiresAt: expiry };
    await blobSet('student:' + email, student);

    const idx = await getIndex();
    if (!idx.students.includes(email)) { idx.students.push(email); await saveIndex(idx); }

    return res({ status: 'ok', expiry, book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // SIGNIN
  if (action === 'signin') {
    const student = await blobGet('student:' + body.email);
    if (!student) return res({ status: 'error', message: 'No account found' });
    if (new Date(student.expiresAt) < new Date()) return res({ status: 'error', message: 'Access expired' });
    const ce = await blobGet('code:' + student.code);
    if (!ce || ce.status === 'revoked') return res({ status: 'error', message: 'Access revoked' });
    return res({ status: 'ok', student });
  }

  // LIST CODES
  if (action === 'listCodes') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' }, 401);

    const idx   = await getIndex();
    const codes = [];
    const now   = new Date();

    for (const key of idx.codes) {
      const entry = await blobGet('code:' + key);
      if (!entry) continue;
      if (entry.status === 'active' && entry.expiresAt && new Date(entry.expiresAt) < now) {
        entry.status = 'expired';
        await blobSet('code:' + key, entry);
      }
      codes.push({
        code: entry.code, book: entry.book, status: entry.status,
        student: entry.studentName || '', email: entry.email || '',
        activated: fmt(entry.activatedAt), expires: fmt(entry.expiresAt),
      });
    }

    return res({ status: 'ok', codes, total: codes.length });
  }

  // LIST STUDENTS
  if (action === 'listStudents') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' }, 401);
    const idx = await getIndex();
    const students = [];
    for (const email of idx.students) {
      const s = await blobGet('student:' + email);
      if (s) students.push(s);
    }
    return res({ status: 'ok', students });
  }

  // REVOKE
  if (action === 'revoke') {
    if (p.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' }, 401);
    const entry = await blobGet('code:' + p.code);
    if (!entry) return res({ status: 'error', message: 'Code not found' });
    entry.status = 'revoked';
    await blobSet('code:' + p.code, entry);
    return res({ status: 'ok' });
  }

  // SAVE AUDIO
  if (action === 'saveAudio') {
    if (body.adminPass !== PASS) return res({ status: 'error', message: 'Wrong password' }, 401);
    await blobSet('audio_urls', body.urls || {});
    return res({ status: 'ok' });
  }

  // GET AUDIO
  if (action === 'getAudio') {
    const urls = await blobGet('audio_urls');
    return res({ status: 'ok', urls: urls || {} });
  }

  return res({ status: 'ok', message: 'QuickRebas API v4' });
};
