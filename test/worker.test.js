import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(k) {
    return this.map.get(k)?.value ?? null;
  }
  async put(k, value, opts = {}) {
    this.map.set(k, { value, metadata: opts.metadata });
  }
  async delete(k) {
    this.map.delete(k);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.map.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([name, v]) => ({ name, metadata: v.metadata }));
    return { keys };
  }
}

const makeEnv = (over = {}) => ({
  ROUTES: new FakeKV(),
  GOOGLE_MAPS_API_KEY: 'test-key',
  EDIT_TOKEN: 'secret-token',
  ASSETS: { fetch: async () => new Response('asset') },
  ...over,
});

const call = (env, path, { method = 'GET', body, token, type = 'application/json' } = {}) => {
  const headers = {};
  if (token) headers['x-edit-token'] = token;
  if (body !== undefined) headers['content-type'] = type;
  return worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
};

const route = {
  name: 'Home to school',
  notes: 'Stay right',
  points: [
    { lat: 35.1, lng: -78.1, label: 'Home' },
    { lat: 35.2, lng: -78.2, label: 'School' },
  ],
  avoid: { highways: true },
};

test('config exposes the key, map id, and whether editing is enabled', async () => {
  const res = await call(makeEnv(), '/api/config');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mapsKey, 'test-key');
  assert.equal(data.mapId, 'DEMO_MAP_ID');
  assert.equal(data.editingEnabled, true);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('non-API paths fall through to static assets', async () => {
  const res = await call(makeEnv(), '/index.html');
  assert.equal(await res.text(), 'asset');
});

test('writes fail closed when EDIT_TOKEN is not configured', async () => {
  const env = makeEnv({ EDIT_TOKEN: undefined });
  const res = await call(env, '/api/routes', { method: 'POST', body: route, token: 'anything' });
  assert.equal(res.status, 503);
  assert.equal((await call(env, '/api/config').then((r) => r.json())).editingEnabled, false);
});

test('writes and listing need the right token', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/routes', { method: 'POST', body: route })).status, 401);
  assert.equal(
    (await call(env, '/api/routes', { method: 'POST', body: route, token: 'wrong' })).status,
    401,
  );
  assert.equal((await call(env, '/api/routes')).status, 401);
  assert.equal((await call(env, '/api/routes', { token: 'secret-token' })).status, 200);
});

test('create, read publicly, update, list, delete', async () => {
  const env = makeEnv();
  const created = await call(env, '/api/routes', { method: 'POST', body: route, token: 'secret-token' });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.match(saved.id, /^[a-f0-9]{16}$/);
  assert.equal(saved.avoid.highways, true);
  assert.equal(saved.avoid.tolls, false);

  // Share links work without a token.
  const read = await call(env, `/api/routes/${saved.id}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).name, 'Home to school');

  const updated = await call(env, `/api/routes/${saved.id}`, {
    method: 'PUT',
    token: 'secret-token',
    body: { ...route, name: 'Renamed', points: [...route.points].reverse() },
  });
  assert.equal(updated.status, 200);
  const u = await updated.json();
  assert.equal(u.name, 'Renamed');
  assert.equal(u.createdAt, saved.createdAt);
  assert.equal(u.points[0].label, 'School');

  const list = await (await call(env, '/api/routes', { token: 'secret-token' })).json();
  assert.equal(list.routes.length, 1);
  assert.equal(list.routes[0].name, 'Renamed');
  assert.equal(list.routes[0].points, 2);

  assert.equal(
    (await call(env, `/api/routes/${saved.id}`, { method: 'DELETE' })).status,
    401,
  );
  assert.equal(
    (await call(env, `/api/routes/${saved.id}`, { method: 'DELETE', token: 'secret-token' })).status,
    200,
  );
  assert.equal((await call(env, `/api/routes/${saved.id}`)).status, 404);
});

test('validation errors return 400; bad content type 415; bad JSON 400; oversize 413', async () => {
  const env = makeEnv();
  const t = 'secret-token';
  const badRoute = await call(env, '/api/routes', { method: 'POST', token: t, body: { name: '', points: [] } });
  assert.equal(badRoute.status, 400);
  assert.match((await badRoute.json()).error, /Name is required/);
  assert.equal(
    (await call(env, '/api/routes', { method: 'POST', token: t, body: 'x', type: 'text/plain' })).status,
    415,
  );
  assert.equal((await call(env, '/api/routes', { method: 'POST', token: t, body: '{nope' })).status, 400);
  assert.equal(
    (await call(env, '/api/routes', { method: 'POST', token: t, body: 'a'.repeat(30000) })).status,
    413,
  );
});

test('malformed ids and unknown paths are 404; wrong methods are 405', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/routes/not-an-id')).status, 404);
  assert.equal((await call(env, '/api/routes/0123456789abcdef')).status, 404);
  assert.equal((await call(env, '/api/nope')).status, 404);
  assert.equal((await call(env, '/api/routes/0123456789abcdef/extra')).status, 404);
  assert.equal((await call(env, '/api/config', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(env, '/api/routes', { method: 'DELETE', token: 'secret-token' })).status, 405);
});
