function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/kuker/api/list' && request.method === 'GET') {
      return handleList(env);
    }
    if (url.pathname === '/kuker/api/load' && request.method === 'GET') {
      return handleLoad(request, env);
    }
    if (url.pathname === '/kuker/api/save' && request.method === 'POST') {
      return handleSave(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
