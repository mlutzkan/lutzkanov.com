export async function onRequestGet({ env }) {
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

  return Response.json({ items, current });
}
