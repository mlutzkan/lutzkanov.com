export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }

  const { mode, data, label } = body;
  if (!data || (mode !== 'overwrite' && mode !== 'new')) {
    return new Response(JSON.stringify({ error: 'invalid payload' }), { status: 400 });
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

  return Response.json({ id, savedAt: now });
}
