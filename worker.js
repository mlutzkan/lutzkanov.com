function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
}

async function handleList(env) {
  const list = await env.KUKER_KV.list({ prefix: 'v:' });

  const records = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.KUKER_KV.get(k.name);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return { id: rec.id, savedAt: rec.savedAt, label: rec.label || '' };
    })
  );

  const items = records.filter(Boolean).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const current = await env.KUKER_KV.get('current');
  return jsonResponse({ items, current });
}

async function handleLoad(request, env) {
  const url = new URL(request.url);
  let id = url.searchParams.get('id');

  if (!id) {
    id = await env.KUKER_KV.get('current');
  }
  if (!id) {
    return jsonResponse({ id: null, data: null });
  }

  const raw = await env.KUKER_KV.get(`v:${id}`);
  if (!raw) {
    return jsonResponse({ id: null, data: null });
  }

  return jsonResponse(JSON.parse(raw));
}

async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid json' }, 400);
  }

  const { mode, data, label } = body;
  if (!data || (mode !== 'overwrite' && mode !== 'new')) {
    return jsonResponse({ error: 'invalid payload' }, 400);
  }

  const now = new Date().toISOString();
  let id = null;

  if (mode === 'overwrite') {
    id = body.id || await env.KUKER_KV.get('current');
  }
  if (!id) {
    id = 'v_' + Date.now();
  }

  const record = { id, savedAt: now, label: label || '', data };
  await env.KUKER_KV.put(`v:${id}`, JSON.stringify(record));
  await env.KUKER_KV.put('current', id);

  return jsonResponse({ id, savedAt: now });
}

async function handleDelete(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return jsonResponse({ error: 'missing id' }, 400);
  }

  await env.KUKER_KV.delete(`v:${id}`);

  const current = await env.KUKER_KV.get('current');
  if (current === id) {
    const list = await env.KUKER_KV.list({ prefix: 'v:' });
    let newest = null;
    for (const k of list.keys) {
      const raw = await env.KUKER_KV.get(k.name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      if (!newest || rec.savedAt > newest.savedAt) newest = rec;
    }
    if (newest) {
      await env.KUKER_KV.put('current', newest.id);
    } else {
      await env.KUKER_KV.delete('current');
    }
  }

  return jsonResponse({ deleted: id });
}

// ---- Closing-shift checklist (/kuker/zatvaryane): one record per date, admin writes need a password ----

const PHOTO_PREFIX = 'zphoto:';
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const COOKIE_NAME = 'zadmin';
const SESSION_SECONDS = 30 * 24 * 3600;
const enc = new TextEncoder();

const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
const validPhotoItem = (item) => /^c\d{1,3}$/.test(item || '');
const validPhotoId = (id) => /^\d{4}-\d{2}-\d{2}:c\d{1,3}:\d{10,}-[a-z0-9]{4,}$/.test(id || '');

async function readJson(env, key, fallback) {
  const raw = await env.KUKER_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

// --- auth: ADMIN_PASSWORD is a Cloudflare secret; a signed, HttpOnly cookie proves a successful login ---

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !Number.isFinite(Number(exp)) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmacHex(env.ADMIN_PASSWORD, 'zadmin:' + exp));
}

const unauthorized = () => jsonResponse({ error: 'unauthorized' }, 401);

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'not configured' }, 503);
  }
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid json' }, 400); }

  const ok = typeof body.password === 'string' && await safeEqual(body.password, env.ADMIN_PASSWORD);
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return jsonResponse({ error: 'wrong password' }, 401);
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sig = await hmacHex(env.ADMIN_PASSWORD, 'zadmin:' + exp);
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=${exp}.${sig}; Path=/kuker; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function handleLogout() {
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/kuker; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  });
}

// --- records: one per date, published when the admin presses "Запази" ---

const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

async function handleDates(env) {
  return jsonResponse({ dates: await readJson(env, 'zdates', []) });
}

async function handleRecordGet(request, env) {
  const date = new URL(request.url).searchParams.get('date');
  if (!validDate(date)) {
    return jsonResponse({ error: 'invalid date' }, 400);
  }
  const record = await readJson(env, `zrec:${date}`, null);
  const photos = await readJson(env, `zphotos:${date}`, {});
  return jsonResponse({ record, photos });
}

async function handleRecordSave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid json' }, 400); }
  if (!validDate(body.date) || !body.checks || typeof body.checks !== 'object') {
    return jsonResponse({ error: 'invalid payload' }, 400);
  }

  const checks = {};
  for (const [k, v] of Object.entries(body.checks)) {
    if (/^c\d{1,3}$/.test(k)) checks[k] = v === true;
  }
  const record = {
    date: body.date,
    name: clip(body.name, 100),
    start: clip(body.start, 10),
    end: clip(body.end, 10),
    notes: clip(body.notes, 3000),
    checks,
    savedAt: new Date().toISOString(),
  };
  await env.KUKER_KV.put(`zrec:${body.date}`, JSON.stringify(record));

  const dates = await readJson(env, 'zdates', []);
  if (!dates.includes(body.date)) {
    dates.push(body.date);
    dates.sort().reverse();
    await env.KUKER_KV.put('zdates', JSON.stringify(dates));
  }
  return jsonResponse({ ok: true, savedAt: record.savedAt });
}

// --- photos: stored per date and checklist item; the per-date index record lists their ids ---

async function handlePhotoList(request, env) {
  const date = new URL(request.url).searchParams.get('date');
  if (!validDate(date)) {
    return jsonResponse({ error: 'invalid date' }, 400);
  }
  return jsonResponse({ photos: await readJson(env, `zphotos:${date}`, {}) });
}

async function handlePhotoUpload(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const item = url.searchParams.get('item');
  if (!validDate(date) || !validPhotoItem(item)) {
    return jsonResponse({ error: 'invalid date or item' }, 400);
  }
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('image/')) {
    return jsonResponse({ error: 'invalid type' }, 400);
  }
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_PHOTO_BYTES) {
    return jsonResponse({ error: 'invalid size' }, 413);
  }

  const id = `${date}:${item}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.KUKER_KV.put(PHOTO_PREFIX + id, buf, { metadata: { type } });
  const photos = await readJson(env, `zphotos:${date}`, {});
  (photos[item] = photos[item] || []).push(id);
  await env.KUKER_KV.put(`zphotos:${date}`, JSON.stringify(photos));
  return jsonResponse({ id });
}

async function handlePhotoGet(request, env) {
  const id = new URL(request.url).searchParams.get('id');
  if (!validPhotoId(id)) {
    return jsonResponse({ error: 'invalid id' }, 400);
  }
  const { value, metadata } = await env.KUKER_KV.getWithMetadata(PHOTO_PREFIX + id, 'arrayBuffer');
  if (!value) {
    return jsonResponse({ error: 'not found' }, 404);
  }
  return new Response(value, {
    headers: {
      'Content-Type': (metadata && metadata.type) || 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

async function handlePhotoDelete(request, env) {
  const id = new URL(request.url).searchParams.get('id');
  if (!validPhotoId(id)) {
    return jsonResponse({ error: 'invalid id' }, 400);
  }
  await env.KUKER_KV.delete(PHOTO_PREFIX + id);
  const [date, item] = id.split(':');
  const photos = await readJson(env, `zphotos:${date}`, {});
  if (photos[item]) {
    photos[item] = photos[item].filter((x) => x !== id);
    if (!photos[item].length) delete photos[item];
    await env.KUKER_KV.put(`zphotos:${date}`, JSON.stringify(photos));
  }
  return jsonResponse({ deleted: id });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/kuker/api/list' && method === 'GET') {
      return handleList(env);
    }
    if (pathname === '/kuker/api/load' && method === 'GET') {
      return handleLoad(request, env);
    }
    if (pathname === '/kuker/api/save' && method === 'POST') {
      return handleSave(request, env);
    }
    if (pathname === '/kuker/api/delete' && method === 'DELETE') {
      return handleDelete(request, env);
    }

    // closing-shift checklist
    if (pathname === '/kuker/api/zauth') {
      if (method === 'POST') return handleLogin(request, env);
      if (method === 'GET') return jsonResponse({ ok: await isAdmin(request, env), configured: !!env.ADMIN_PASSWORD });
    }
    if (pathname === '/kuker/api/zlogout' && method === 'POST') {
      return handleLogout();
    }
    if (pathname === '/kuker/api/zdates' && method === 'GET') {
      return handleDates(env);
    }
    if (pathname === '/kuker/api/zrec') {
      if (method === 'GET') return handleRecordGet(request, env);
      if (method === 'POST') return (await isAdmin(request, env)) ? handleRecordSave(request, env) : unauthorized();
    }
    if (pathname === '/kuker/api/zphotos' && method === 'GET') {
      return handlePhotoList(request, env);
    }
    if (pathname === '/kuker/api/zphoto') {
      if (method === 'GET') return handlePhotoGet(request, env);
      if (method === 'POST') return (await isAdmin(request, env)) ? handlePhotoUpload(request, env) : unauthorized();
      if (method === 'DELETE') return (await isAdmin(request, env)) ? handlePhotoDelete(request, env) : unauthorized();
    }

    return env.ASSETS.fetch(request);
  },
};
