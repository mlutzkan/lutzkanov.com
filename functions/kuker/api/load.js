export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  let id = url.searchParams.get('id');

  if (!id) {
    id = await env.KUKER_KV.get('current');
  }
  if (!id) {
    return Response.json({ id: null, data: null });
  }

  const raw = await env.KUKER_KV.get(`v:${id}`);
  if (!raw) {
    return Response.json({ id: null, data: null });
  }

  return Response.json(JSON.parse(raw));
}
