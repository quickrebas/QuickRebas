// netlify/functions/api.js
// QuickRebas backend — runs on Netlify's servers, no Google needed
// Uses Netlify Blobs as the database (built-in, free)

const { getStore } = require('@netlify/blobs');

// ── helpers ──────────────────────────────────────────────────────────────────

function resp(data, status) {
  return {
    statusCode: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(data),
  };
}

function randChars(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function makeCode(book) {
  return `QR-${book.toUpperCase()}-${randChars(4)}-${randChars(4)}`;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

// ── main handler ─────────────────────────────────────────────────────────────

exports.handler = async function(event) {

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return resp({ ok: true });
  }

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const action = params.action || '';

  // Parse body for POST requests
  let body = {};
  if (method === 'POST' && event.body) {
    try { body = JSON.parse(event.body); } catch(e) {}
  }

  // ── database stores ──
  const codesStore    = getStore('codes');
  const studentsStore = getStore('students');

  // ════════════════════════════════════════════════════════
  //  GENERATE CODES
  //  POST /api?action=generate
  //  body: { book, qty, adminPass }
  // ════════════════════════════════════════════════════════
  if (action === 'generate') {
    const adminPass = await codesStore.get('__admin_pass') || 'quickrebas2025';
    if (body.adminPass !== adminPass) {
      return resp({ status: 'error', message: 'Wrong admin password' }, 401);
    }

    const book = (body.book || 'A0').toUpperCase();
    const qty  = Math.min(parseInt(body.qty) || 10, 500);
    const now  = new Date().toISOString();
    const generated = [];

    for (let i = 0; i < qty; i++) {
      const code = makeCode(book);
      const entry = { code, book, status: 'unused', createdAt: now };
      await codesStore.setJSON(code, entry);
      generated.push(code);
    }

    return resp({ status: 'ok', codes: generated, count: generated.length });
  }

  // ════════════════════════════════════════════════════════
  //  VERIFY CODE
  //  GET /api?action=verify&code=QR-A0-XXXX-XXXX
  // ════════════════════════════════════════════════════════
  if (action === 'verify') {
    const code = params.code;
    if (!code) return resp({ status: 'invalid' });

    const entry = await codesStore.get(code, { type: 'json' });
    if (!entry)                        return resp({ status: 'invalid' });
    if (entry.status === 'active')     return resp({ status: 'used' });
    if (entry.status === 'revoked')    return resp({ status: 'invalid' });

    return resp({
      status: 'valid',
      book:   'QuickRebas ' + entry.book,
      level:  entry.book.toLowerCase(),
    });
  }

  // ════════════════════════════════════════════════════════
  //  ACTIVATE CODE
  //  POST /api?action=activate
  //  body: { code, name, email, password }
  // ════════════════════════════════════════════════════════
  if (action === 'activate') {
    const { code, name, email, password } = body;
    if (!code || !name || !email || !password) {
      return resp({ status: 'error', message: 'Missing fields' });
    }

    const entry = await codesStore.get(code, { type: 'json' });
    if (!entry || entry.status !== 'unused') {
      return resp({ status: 'error', message: 'Code is not valid or already used' });
    }

    const now    = new Date().toISOString();
    const expiry = addMonths(now, 6);

    // Update code entry
    entry.status      = 'active';
    entry.studentName = name;
    entry.email       = email;
    entry.activatedAt = now;
    entry.expiresAt   = expiry;
    await codesStore.setJSON(code, entry);

    // Save student record (keyed by email)
    const student = { name, email, book: entry.book, level: entry.book.toLowerCase(), code, activatedAt: now, expiresAt: expiry };
    await studentsStore.setJSON(email, student);

    return resp({ status: 'ok', expiry, book: 'QuickRebas ' + entry.book, level: entry.book.toLowerCase() });
  }

  // ════════════════════════════════════════════════════════
  //  SIGN IN (student login)
  //  POST /api?action=signin
  //  body: { email, password }
  // ════════════════════════════════════════════════════════
  if (action === 'signin') {
    const { email, password } = body;
    const student = await studentsStore.get(email, { type: 'json' });
    if (!student) return resp({ status: 'error', message: 'No account found for this email' });

    // Check expiry
    if (new Date(student.expiresAt) < new Date()) {
      return resp({ status: 'error', message: 'Your access has expired. Please purchase a new workbook.' });
    }

    // Re-verify code still active
    const codeEntry = await codesStore.get(student.code, { type: 'json' });
    if (!codeEntry || codeEntry.status === 'revoked') {
      return resp({ status: 'error', message: 'Access has been revoked. Please contact your teacher.' });
    }

    return resp({ status: 'ok', student });
  }

  // ════════════════════════════════════════════════════════
  //  LIST CODES (admin)
  //  GET /api?action=listCodes&adminPass=xxx
  // ════════════════════════════════════════════════════════
  if (action === 'listCodes') {
    const adminPass = await codesStore.get('__admin_pass') || 'quickrebas2025';
    if (params.adminPass !== adminPass) {
      return resp({ status: 'error', message: 'Wrong admin password' }, 401);
    }

    const { blobs } = await codesStore.list();
    const codes = [];
    const now   = new Date();

    for (const blob of blobs) {
      if (blob.key.startsWith('__')) continue; // skip internal keys
      const entry = await codesStore.get(blob.key, { type: 'json' });
      if (!entry) continue;

      // Auto-expire
      if (entry.status === 'active' && entry.expiresAt && new Date(entry.expiresAt) < now) {
        entry.status = 'expired';
        await codesStore.setJSON(blob.key, entry);
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

    return resp({ status: 'ok', codes });
  }

  // ════════════════════════════════════════════════════════
  //  LIST STUDENTS (admin)
  //  GET /api?action=listStudents&adminPass=xxx
  // ════════════════════════════════════════════════════════
  if (action === 'listStudents') {
    const adminPass = await codesStore.get('__admin_pass') || 'quickrebas2025';
    if (params.adminPass !== adminPass) {
      return resp({ status: 'error', message: 'Wrong admin password' }, 401);
    }

    const { blobs } = await studentsStore.list();
    const students = [];
    for (const blob of blobs) {
      const s = await studentsStore.get(blob.key, { type: 'json' });
      if (s) students.push(s);
    }
    return resp({ status: 'ok', students });
  }

  // ════════════════════════════════════════════════════════
  //  REVOKE CODE (admin)
  //  GET /api?action=revoke&code=xxx&adminPass=xxx
  // ════════════════════════════════════════════════════════
  if (action === 'revoke') {
    const adminPass = await codesStore.get('__admin_pass') || 'quickrebas2025';
    if (params.adminPass !== adminPass) {
      return resp({ status: 'error', message: 'Wrong admin password' }, 401);
    }

    const code  = params.code;
    const entry = await codesStore.get(code, { type: 'json' });
    if (!entry) return resp({ status: 'error', message: 'Code not found' });

    entry.status = 'revoked';
    await codesStore.setJSON(code, entry);
    return resp({ status: 'ok' });
  }

  // ════════════════════════════════════════════════════════
  //  CHANGE ADMIN PASSWORD
  //  POST /api?action=changePass
  //  body: { oldPass, newPass }
  // ════════════════════════════════════════════════════════
  if (action === 'changePass') {
    const stored = await codesStore.get('__admin_pass') || 'quickrebas2025';
    if (body.oldPass !== stored) {
      return resp({ status: 'error', message: 'Old password is incorrect' });
    }
    await codesStore.set('__admin_pass', body.newPass);
    return resp({ status: 'ok' });
  }

  return resp({ status: 'ok', message: 'QuickRebas API' });
};
