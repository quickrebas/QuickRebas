// QuickRebas Backend — Zero external dependencies
// Uses Netlify Blobs native REST API (no npm packages needed)

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
  for (var i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function makeCode(book) {
  return 'QR-' + book.toUpperCase() + '-' + rand(4) + '-' + rand(4);
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  } catch(e) { return iso; }
}

function addMonths(n) {
  var d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

// Netlify Blobs REST API — uses env vars Netlify injects automatically
async function bGet(store, key) {
  var siteId = process.env.NETLIFY_SITE_ID;
  var token  = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteId || !token) return null;
  try {
    var r = await fetch('https://blobs.netlify.com/' + siteId + '/' + store + '/' + encodeURIComponent(key), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

async function bSet(store, key, val) {
  var siteId = process.env.NETLIFY_SITE_ID;
  var token  = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteId || !token) return false;
  try {
    var r = await fetch('https://blobs.netlify.com/' + siteId + '/' + store + '/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(val),
    });
    return r.ok;
  } catch(e) { return false; }
}

async function bList(store) {
  var siteId = process.env.NETLIFY_SITE_ID;
  var token  = process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteId || !token) return [];
  try {
    var r = await fetch('https://blobs.netlify.com/' + siteId + '/' + store + '/', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return [];
    var d = await r.json();
    return d.blobs || d.keys || [];
  } catch(e) { return []; }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });

  var params = event.queryStringParameters || {};
  var action = params.action || '';
  var body   = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var PASS = process.env.ADMIN_PASS || 'quickrebas2025';

  // GENERATE
  if (action === 'generate') {
    if (body.adminPass !== PASS) return ok({ status: 'error', message: 'Wrong password' });
    var book  = (body.book || 'A0').toUpperCase();
    var qty   = Math.min(parseInt(body.qty) || 10, 500);
    var codes = [];
    var now   = new Date().toISOString();
    for (var i = 0; i < qty; i++) {
      var code = makeCode(book);
      await bSet('codes', code, { code:code, book:book, status:'unused', createdAt:now });
      codes.push(code);
    }
    return ok({ status:'ok', codes:codes, count:codes.length });
  }

  // VERIFY
  if (action === 'verify') {
    var code  = params.code;
    if (!code) return ok({ status:'invalid' });
    var entry = await bGet('codes', code);
    if (!entry)                     return ok({ status:'invalid' });
    if (entry.status === 'active')  return ok({ status:'used' });
    if (entry.status === 'revoked') return ok({ status:'invalid' });
    return ok({ status:'valid', book:'QuickRebas '+entry.book, level:entry.book.toLowerCase() });
  }

  // ACTIVATE
  if (action === 'activate') {
    var code  = body.code;
    var name  = body.name;
    var email = body.email;
    if (!code||!name||!email) return ok({ status:'error', message:'Missing fields' });
    var entry = await bGet('codes', code);
    if (!entry || entry.status !== 'unused') return ok({ status:'error', message:'Code not valid or already used' });
    var now    = new Date().toISOString();
    var expiry = addMonths(6);
    entry.status='active'; entry.studentName=name; entry.email=email;
    entry.activatedAt=now; entry.expiresAt=expiry;
    await bSet('codes', code, entry);
    await bSet('students', email, { name:name, email:email, book:entry.book, level:entry.book.toLowerCase(), code:code, activatedAt:now, expiresAt:expiry });
    return ok({ status:'ok', expiry:expiry, book:'QuickRebas '+entry.book, level:entry.book.toLowerCase() });
  }

  // SIGNIN
  if (action === 'signin') {
    var student = await bGet('students', body.email);
    if (!student) return ok({ status:'error', message:'No account found for this email' });
    if (new Date(student.expiresAt) < new Date()) return ok({ status:'error', message:'Access expired. Please purchase a new workbook.' });
    var ce = await bGet('codes', student.code);
    if (!ce || ce.status === 'revoked') return ok({ status:'error', message:'Access revoked. Contact your teacher.' });
    return ok({ status:'ok', student:student });
  }

  // LIST CODES
  if (action === 'listCodes') {
    if (params.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });
    var blobs = await bList('codes');
    var codes = [];
    var now   = new Date();
    for (var i = 0; i < blobs.length; i++) {
      var key   = blobs[i].key || blobs[i];
      var entry = await bGet('codes', key);
      if (!entry) continue;
      if (entry.status === 'active' && entry.expiresAt && new Date(entry.expiresAt) < now) {
        entry.status = 'expired';
        await bSet('codes', key, entry);
      }
      codes.push({ code:entry.code, book:entry.book, status:entry.status, student:entry.studentName||'', email:entry.email||'', activated:entry.activatedAt?fmtDate(entry.activatedAt):'', expires:entry.expiresAt?fmtDate(entry.expiresAt):'' });
    }
    return ok({ status:'ok', codes:codes });
  }

  // LIST STUDENTS
  if (action === 'listStudents') {
    if (params.adminPass !== PASS) return ok({ status:'error', message:'Wrong password' });
    var blobs = await bList('students');
    var students = [];
    for (var i = 0; i < blobs.length; i++) {
      var s = await bGet('students', blobs[i].key || blobs[i]);
      if (s) students.push(s);
    }
    return ok({ status:'ok', students:students });
  }

  // REVOKE
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
