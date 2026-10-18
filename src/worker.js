// Cloudflare Worker: JSON API for saved routes (KV) + static assets.
//
// Public:   GET /api/config, GET /api/routes/:id   (share links work without a login)
// Editor:   GET /api/routes, POST /api/routes, PUT/DELETE /api/routes/:id
//           require the X-Edit-Token header to match the EDIT_TOKEN secret.
//           If EDIT_TOKEN is not configured, all writes are refused (fail closed).

import { validateRoute } from '../public/lib.js';

const ID_RE = /^[a-f0-9]{16}$/;
const MAX_BODY_CHARS = 20_000;
const KEY_PREFIX = 'route:';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

// Compare SHA-256 digests so timing does not reveal how much of a guess matched.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Returns a Response to send back if the caller is not allowed, otherwise null.
async function requireEditor(request, env) {
  if (!env.EDIT_TOKEN) {
    return json({ error: 'Editing is disabled: EDIT_TOKEN is not configured.' }, 503);
  }
  const supplied = request.headers.get('x-edit-token') || '';
  if (!(await safeEqual(supplied, env.EDIT_TOKEN))) return json({ error: 'Unauthorized' }, 401);
  return null;
}

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    return { error: json({ error: 'Content-Type must be application/json.' }, 415) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return { error: json({ error: 'Body too large.' }, 413) };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'Invalid JSON.' }, 400) };
  }
}

async function saveRoute(env, route) {
  await env.ROUTES.put(KEY_PREFIX + route.id, JSON.stringify(route), {
    metadata: {
      name: route.name,
      updatedAt: route.updatedAt,
      points: route.points.length,
    },
  });
}

async function handleApi(request, env, url) {
  // /api/<resource>/<id>/<extra>
  const [, resource, id, extra] = url.pathname.split('/').filter(Boolean);
  const method = request.method;

  if (extra !== undefined) return json({ error: 'Not found' }, 404);

  if (resource === 'config' && id === undefined) {
    if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return json({
      mapsKey: env.GOOGLE_MAPS_API_KEY || null,
      mapId: env.MAP_ID || 'DEMO_MAP_ID',
      editingEnabled: Boolean(env.EDIT_TOKEN),
    });
  }

  if (resource !== 'routes') return json({ error: 'Not found' }, 404);

  // /api/routes
  if (id === undefined) {
    if (method === 'GET') {
      const denied = await requireEditor(request, env);
      if (denied) return denied;
      const { keys } = await env.ROUTES.list({ prefix: KEY_PREFIX, limit: 1000 });
      const routes = keys
        .map((k) => ({ id: k.name.slice(KEY_PREFIX.length), ...(k.metadata || {}) }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return json({ routes });
    }
    if (method === 'POST') {
      const denied = await requireEditor(request, env);
      if (denied) return denied;
      const body = await readJson(request);
      if (body.error) return body.error;
      const v = validateRoute(body.data);
      if (!v.ok) return json({ error: v.errors.join(' ') }, 400);
      const now = new Date().toISOString();
      const route = { id: newId(), ...v.value, createdAt: now, updatedAt: now };
      await saveRoute(env, route);
      return json(route, 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  // /api/routes/:id
  if (!ID_RE.test(id)) return json({ error: 'Not found' }, 404);
  const key = KEY_PREFIX + id;

  if (method === 'GET') {
    const stored = await env.ROUTES.get(key);
    if (!stored) return json({ error: 'Not found' }, 404);
    return new Response(stored, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (method === 'PUT' || method === 'DELETE') {
    const denied = await requireEditor(request, env);
    if (denied) return denied;
    const stored = await env.ROUTES.get(key);
    if (!stored) return json({ error: 'Not found' }, 404);

    if (method === 'DELETE') {
      await env.ROUTES.delete(key);
      return json({ ok: true });
    }

    const body = await readJson(request);
    if (body.error) return body.error;
    const v = validateRoute(body.data);
    if (!v.ok) return json({ error: v.errors.join(' ') }, 400);
    const existing = JSON.parse(stored);
    const route = {
      id,
      ...v.value,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await saveRoute(env, route);
    return json(route);
  }

  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },
};
