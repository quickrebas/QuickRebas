// QuickRebas Backend v4 — uses index pattern, no blob listing needed

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(data),
  };
}

function rand(n) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function makeCode(book) {
  return 'QR-' + book.toUpperCase() + '-' + rand(4) + '-' + rand(4);
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }
  catch(e) { return iso; }
}

function addMonths(n) {
  var d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

// ── Netlify Blobs via @netlify/blobs (auto-available in Netlify functions) ──
const { getStore } = require('@netlify/blobs');

async function bGet(store, key) {
  try {
    var s = getStore(store);
    var v = await s.get(key, { type: 'json' });
    return v;
  } catch(e) { return null; }
}

async function bSet(store, key, val) {
  try {
    var s = getStore(store);
    await s.setJSON(key, val);
    return true;
  } catch(e) { return false; }
}

// Index helpers — maintain a flat list of all keys in a store
async function indexGet(name) {
  var idx = await bGet('indexes', name);
  return idx ? idx : [];
}

async function indexAdd(name, key) {
  var idx = await indexGet(name);
  if (!idx.includes(key)) {
    idx.push(key);
    await bSet('indexes', name, idx);
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });

  var params = event.queryStringParameters || {};
  var action = params.action || '';
  var body   = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var PASS = process.env.ADMIN_PASS || 'quickrebas2025';

  // ── GENERATE ────────────────────────────────────────────────────────────────
  if (action === 'generate') {
    if (body.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });

    var book  = (body.book || 'A0').toUpperCase();
    var qty   = Math.min(parseInt(body.qty) || 10, 500);
    var codes = [];
    var now   = new Date().toISOString();

    for (var i = 0; i < qty; i++) {
      var code = makeCode(book);
      var entry = { code:code, book:book, status:'unused', createdAt:now };
      await bSet('codes', code, entry);
      await indexAdd('codes', code);
      codes.push(code);
    }

    return ok({ status:'ok', codes:codes, count:codes.length });
  }

  // ── VERIFY ──────────────────────────────────────────────────────────────────
  if (action === 'verify') {
    var code = params.code;
    if (!code) return ok({ status:'invalid' });
    var entry = await bGet('codes', code);
    if (!entry)                     return ok({ status:'invalid' });
    if (entry.status === 'active')  return ok({ status:'used' });
    if (entry.status === 'revoked') return ok({ status:'invalid' });
    return ok({ status:'valid', book:'QuickRebas '+entry.book, level:entry.book.toLowerCase() });
  }

  // ── ACTIVATE ────────────────────────────────────────────────────────────────
  if (action === 'activate') {
    var code  = body.code;
    var name  = body.name;
    var email = body.email;
    if (!code || !name || !email) return ok({ status:'error', message:'Missing fields' });

    var entry = await bGet('codes', code);
    if (!entry || entry.status !== 'unused') return ok({ status:'error', message:'Code not valid or already used' });

    var now    = new Date().toISOString();
    var expiry = addMonths(6);
    entry.status='active'; entry.studentName=name; entry.email=email;
    entry.activatedAt=now; entry.expiresAt=expiry;
    await bSet('codes', code, entry);

    var student = { name:name, email:email, book:entry.book, level:entry.book.toLowerCase(), code:code, activatedAt:now, expiresAt:expiry };
    await bSet('students', email, student);
    await indexAdd('students', email);

    return ok({ status:'ok', expiry:expiry, book:'QuickRebas '+entry.book, level:entry.book.toLowerCase() });
  }

  // ── SIGNIN ──────────────────────────────────────────────────────────────────
  if (action === 'signin') {
    var student = await bGet('students', body.email);
    if (!student) return ok({ status:'error', message:'No account found for this email' });
    if (new Date(student.expiresAt) < new Date()) return ok({ status:'error', message:'Access expired. Please purchase a new workbook.' });
    var ce = await bGet('codes', student.code);
    if (!ce || ce.status === 'revoked') return ok({ status:'error', message:'Access revoked. Contact your teacher.' });
    return ok({ status:'ok', student:student });
  }

  // ── LIST CODES ──────────────────────────────────────────────────────────────
  if (action === 'listCodes') {
    if (params.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });

    var keys  = await indexGet('codes');
    var codes = [];
    var now   = new Date();

    for (var i = 0; i < keys.length; i++) {
      var entry = await bGet('codes', keys[i]);
      if (!entry) continue;

      if (entry.status === 'active' && entry.expiresAt && new Date(entry.expiresAt) < now) {
        entry.status = 'expired';
        await bSet('codes', keys[i], entry);
      }

      codes.push({
        code:      entry.code,
        book:      entry.book,
        status:    entry.status,
        student:   entry.studentName || '',
        email:     entry.email || '',
        activated: entry.activatedAt ? fmtDate(entry.activatedAt) : '',
        expires:   entry.expiresAt   ? fmtDate(entry.expiresAt)   : '',
      });
    }

    return ok({ status:'ok', codes:codes });
  }

  // ── LIST STUDENTS ────────────────────────────────────────────────────────────
  if (action === 'listStudents') {
    if (params.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });

    var keys     = await indexGet('students');
    var students = [];

    for (var i = 0; i < keys.length; i++) {
      var s = await bGet('students', keys[i]);
      if (s) students.push(s);
    }

    return ok({ status:'ok', students:students });
  }

  // ── REVOKE ──────────────────────────────────────────────────────────────────
  if (action === 'revoke') {
    if (params.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });

    var entry = await bGet('codes', params.code);
    if (!entry) return ok({ status:'error', message:'Code not found' });
    entry.status = 'revoked';
    await bSet('codes', params.code, entry);
    return ok({ status:'ok' });
  }

  return ok({ status:'ok', message:'QuickRebas API running' });
};
