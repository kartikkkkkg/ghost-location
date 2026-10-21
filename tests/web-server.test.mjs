import test from 'node:test';
import assert from 'node:assert/strict';
import { WebControlServer } from '../backend/web-server.mjs';

function fakeController() {
  const calls = [];
  const state = {
    devices: [{ id: 'ios:phone', name: 'iPhone', platform: 'ios', connection: 'wifi', state: 'ready', detail: null }],
    session: null,
    route: null,
    savedPlaces: [{ id: 'p1', label: 'Home', latitude: 1, longitude: 2 }],
    recentPlaces: [],
    preferences: { geocoderUrl: 'https://example.invalid/api/' },
    busy: false,
    warning: null,
  };
  return {
    calls,
    state,
    snapshot: () => structuredClone(state),
    scanDevices: async () => structuredClone(state),
    applyLocation: async (input) => {
      calls.push(['applyLocation', input]);
      state.session = { deviceId: input.deviceId, deviceName: 'iPhone', status: 'active', latitude: input.latitude, longitude: input.longitude };
      return structuredClone(state);
    },
    stopLocation: async () => { calls.push(['stopLocation']); state.session = null; return structuredClone(state); },
    planRoute: async (waypoints) => { calls.push(['planRoute', waypoints]); return { id: 'route-1', distanceMeters: 100, durationSeconds: 60, waypoints }; },
    getRoute: () => ({ id: 'route-1', coordinates: [[2, 1], [4, 3]] }),
    startSavedRoute: async (id, deviceId) => { calls.push(['startSavedRoute', id, deviceId]); state.route = { status: 'running' }; return structuredClone(state); },
    startRoute: async (input) => { calls.push(['startRoute', input]); state.route = { status: 'running' }; return structuredClone(state); },
    pauseRoute: async () => { calls.push(['pauseRoute']); return structuredClone(state); },
    resumeRoute: async () => { calls.push(['resumeRoute']); return structuredClone(state); },
  };
}

async function startServer(t, options = {}) {
  const controller = fakeController();
  const server = new WebControlServer({ controller, port: 0, pin: '123456', search: async (q) => [{ id: 'r1', label: q, latitude: 3, longitude: 4 }], ...options });
  await server.start();
  t.after(() => server.stop());
  return { controller, server, base: `http://127.0.0.1:${server.port}` };
}

async function login(base, pin = '123456') {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  return { response, cookie };
}

test('serves the control page and vendored Leaflet without login', async (t) => {
  const { base } = await startServer(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Roam web control/);
  const leaflet = await fetch(`${base}/vendor/leaflet.js`);
  assert.equal(leaflet.status, 200);
  assert.match(leaflet.headers.get('content-type'), /javascript/);
});

test('API requires the PIN login', async (t) => {
  const { base } = await startServer(t);
  const state = await fetch(`${base}/api/state`);
  assert.equal(state.status, 401);
  const wrong = await login(base, '000000');
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.cookie.includes('ghost-control='), false);
});

test('login issues a session cookie and state hides desktop-only fields', async (t) => {
  const { base } = await startServer(t);
  const { response, cookie } = await login(base);
  assert.equal(response.status, 200);
  assert.match(cookie, /^ghost-control=[0-9a-f]{48}$/);
  const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  assert.equal(state.devices[0].name, 'iPhone');
  assert.equal(state.savedPlaces[0].label, 'Home');
  assert.equal('preferences' in state, false);
  assert.equal('runtime' in state, false);
});

test('apply and restore go through the shared controller', async (t) => {
  const { base, controller } = await startServer(t);
  const { cookie } = await login(base);
  const applied = await (await fetch(`${base}/api/apply`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'ios:phone', latitude: 12.5, longitude: -45.25, label: 'Test spot' }),
  })).json();
  assert.equal(applied.session.status, 'active');
  assert.deepEqual(controller.calls[0], ['applyLocation', { deviceId: 'ios:phone', latitude: 12.5, longitude: -45.25, label: 'Test spot' }]);
  const restored = await (await fetch(`${base}/api/restore`, { method: 'POST', headers: { cookie } })).json();
  assert.equal(restored.session, null);
  assert.deepEqual(controller.calls[1], ['stopLocation']);
});

test('route plan, start, pause and resume are exposed', async (t) => {
  const { base, controller } = await startServer(t);
  const { cookie } = await login(base);
  const waypoints = [{ latitude: 1, longitude: 2, label: 'A' }, { latitude: 3, longitude: 4, label: 'B' }];
  const planned = await (await fetch(`${base}/api/route/plan`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ waypoints }),
  })).json();
  assert.equal(planned.route.id, 'route-1');
  await fetch(`${base}/api/route/start`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'ios:phone', routeId: 'route-1' }),
  });
  await fetch(`${base}/api/route/pause`, { method: 'POST', headers: { cookie } });
  await fetch(`${base}/api/route/resume`, { method: 'POST', headers: { cookie } });
  assert.deepEqual(controller.calls.map(([name]) => name), ['planRoute', 'startRoute', 'pauseRoute', 'resumeRoute']);
});

test('saved routes start and the planned route geometry are exposed', async (t) => {
  const { base, controller } = await startServer(t);
  const { cookie } = await login(base);
  const started = await (await fetch(`${base}/api/route/saved`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'saved-1', deviceId: 'ios:phone' }),
  })).json();
  assert.equal(started.route.status, 'running');
  assert.deepEqual(controller.calls.map(([name]) => name), ['startSavedRoute']);
  const planned = await (await fetch(`${base}/api/route`, { headers: { cookie } })).json();
  assert.deepEqual(planned.route.coordinates, [[2, 1], [4, 3]]);
});

test('search delegates to the configured geocoder', async (t) => {
  const { base } = await startServer(t);
  const { cookie } = await login(base);
  const result = await (await fetch(`${base}/api/search?q=Jaipur`, { headers: { cookie } })).json();
  assert.equal(result.results[0].label, 'Jaipur');
  const empty = await (await fetch(`${base}/api/search?q=`, { headers: { cookie } })).json();
  assert.deepEqual(empty.results, []);
});

test('repeated wrong PINs are locked out', async (t) => {
  const { base } = await startServer(t);
  for (let i = 0; i < 5; i++) {
    const { response } = await login(base, '000000');
    assert.equal(response.status, 401);
  }
  const { response } = await login(base, '123456');
  assert.equal(response.status, 429);
});

test('controller errors surface as JSON errors, not crashes', async (t) => {
  const { base, controller } = await startServer(t);
  controller.applyLocation = async () => { throw new Error('That phone is no longer connected.'); };
  const { cookie } = await login(base);
  const response = await fetch(`${base}/api/apply`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'ios:phone', latitude: 1, longitude: 2, label: 'X' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'That phone is no longer connected.');
});
