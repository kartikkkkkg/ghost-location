import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, measurePath, pointAlong, distanceBetween, ROUTE_SPEED_MPS, mphToMps, buildPaceProfile, paceFactorAt } from '../backend/routing.mjs';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';

const close = (a, b, epsilon = 0.001) => assert.ok(Math.abs(a - b) < epsilon, `${a} differs from ${b}`);
const path = measurePath([[0, 0], [0.001, 0], [0.001, 0.001]]);
const plan = { id: 'road', coordinates: path.coordinates, distanceMeters: path.distanceMeters, durationSeconds: path.distanceMeters / ROUTE_SPEED_MPS, waypoints: [{latitude: 0, longitude: 0, label: 'Start'}, {latitude: 0.001, longitude: 0.001, label: 'End'}] };

test('45 mph advances 20.1168 metres each second along segments, including corners', () => {
  close(ROUTE_SPEED_MPS, 20.1168, 1e-12);
  const before = pointAlong(path, ROUTE_SPEED_MPS * 5);
  assert.equal(before.latitude, 0);
  close(distanceBetween([0, 0], [before.longitude, before.latitude]), 100.584);
  const after = pointAlong(path, ROUTE_SPEED_MPS * 6);
  close(after.longitude, 0.001, 1e-9);
  close(path.cumulative[1] + distanceBetween([0.001, 0], [after.longitude, after.latitude]), 120.7008);
  assert.deepEqual(pointAlong(path, 10000), {latitude: 0.001, longitude: 0.001});
});
test('duplicate points, start clamp, and dateline crossing do not create jumps', () => {
  const repeated = measurePath([[0, 0], [0, 0], [0.001, 0]]);
  assert.deepEqual(pointAlong(repeated, -100), {latitude: 0, longitude: 0});
  close(pointAlong(repeated, repeated.distanceMeters / 2).longitude, 0.0005, 1e-9);
  const dateline = measurePath([[179.999, 0], [-179.999, 0]]);
  close(Math.abs(pointAlong(dateline, dateline.distanceMeters / 2).longitude), 180, 1e-9);
  assert.throws(() => measurePath([[0, 0], [0, 0]]), /different/);
  for (const coordinates of [[], [[0, 0], [181, 0]], [[0, 0], [0, NaN]], [[0, 0], ['1', 0]]]) assert.throws(() => measurePath(coordinates));
});
test('OSRM requests ordered driving stops and full geometry only on explicit planning', async () => {
  const calls = [];
  const router = new Router({now: () => 1000, fetcher: async (...args) => { calls.push(args); return new Response(JSON.stringify({code: 'Ok', routes: [{geometry: {type: 'LineString', coordinates: path.coordinates}}]})); }});
  const result = await router.plan(plan.waypoints);
  const url = new URL(calls[0][0]);
  assert.match(url.pathname, /driving\/0,0;0.001,0.001/);
  assert.equal(url.searchParams.get('overview'), 'full');
  assert.equal(url.searchParams.get('geometries'), 'geojson');
  assert.equal(result.distanceMeters, path.distanceMeters);
  close(result.durationSeconds, path.distanceMeters / ROUTE_SPEED_MPS);
  await assert.rejects(router.plan(plan.waypoints), /Wait a second/);
  assert.equal(calls.length, 1);
});
test('no-route, HTTP, malformed response and invalid stops fail without a straight-line fallback', async () => {
  for (const response of [new Response('', {status: 503}), new Response('{'), new Response(JSON.stringify({code: 'NoRoute'})), new Response(JSON.stringify({code: 'Ok', routes: [{geometry: {type: 'LineString', coordinates: [[0, 0], [0, 91]]}}]}))]) {
    await assert.rejects(new Router({fetcher: async () => response}).plan(plan.waypoints));
  }
  const router = new Router({fetcher: () => assert.fail('Invalid stops reached the network')});
  for (const stops of [null, [], [plan.waypoints[0]], Array(13).fill(plan.waypoints[0]), [{latitude: 91, longitude: 0}, plan.waypoints[1]]]) await assert.rejects(router.plan(stops));
});

async function fixture(t, platform = 'ios', connection = 'usb') {
  const phone = { id: `${platform}:USB123`, serial: 'USB123', platform, name: 'Test phone', connection, state: 'ready' };
  let timestamp = 0, devices = [phone];
  const calls = [], data = defaults(); data.preferences.connection = connection;
  const store = {load: async () => structuredClone(data), save: async value => { calls.push(['persist']); Object.assign(data, structuredClone(value)); }};
  const adapter = {status: async () => ({available: true}), list: async () => devices,
    set: async (device, point) => { calls.push(['set', device.id, {...point}]); return {}; },
    update: async (device, point) => { calls.push(['update', device.id, {...point}]); return {}; },
    clear: async () => calls.push(['clear']), reset: async () => calls.push(['reset']), dispose: async () => {}};
  const c = new Controller({adapters: {[platform]: adapter}, store, router: {plan: async () => structuredClone(plan)}, clock: () => timestamp, now: () => Date.parse('2026-09-13T12:00:00Z') + timestamp});
  await c.init(); await c.planRoute({waypoints: plan.waypoints, pacing: false});
  t.after(() => c.dispose({restore: false}));
  const start = () => c.startRoute({deviceId: phone.id, routeId: plan.id});
  return {c, phone, adapter, calls, data, start, advance: ms => { timestamp += ms; }, disconnect: () => {devices = [];}, reconnect: () => {devices = [phone];}, replace: () => {devices = [{...phone, id: `${platform}:SECOND`, serial: 'SECOND'}];}};
}

for (const connection of ['usb', 'wifi']) for (const platform of ['ios', 'android']) test(`${platform} ${connection} route sends one point per second, preserves session, and holds exact endpoint`, async t => {
  const f = await fixture(t, platform, connection); await f.start();
  const id = f.c.state.session.id; f.calls.length = 0;
  for (let second = 1; second <= 12; second++) { f.advance(1000); await f.c.tickRoute(); }
  assert.equal(f.c.state.route.status, 'completed');
  const updates = f.calls.filter(c => c[0] === 'update');
  assert.equal(updates.length, 12);
  assert.ok(updates.every(c => c[1] === f.phone.id && c[2].sessionId === id));
  close(distanceBetween([0, 0], [updates[0][2].longitude, updates[0][2].latitude]), ROUTE_SPEED_MPS);
  assert.equal(f.c.state.session.latitude, 0.001); assert.equal(f.c.state.session.longitude, 0.001);
  assert.equal(f.c.state.busy, false); assert.equal(f.c.state.session.status, 'active');
  assert.equal(f.calls.filter(c => c[0] === 'persist').length, 1, 'Only arrival journals, not every tick');
  await f.c.tickRoute(); assert.equal(f.calls.filter(c => c[0] === 'update').length, 12);
  await f.c.stopLocation(); assert.equal(f.c.state.route, null); assert.equal(f.c.state.session, null);
});
test('backend timer sends updates independently of renderer events', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture(t); await f.start();
  for (let i = 0; i < 6; i++) { f.advance(1000); t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.calls.filter(c => c[0] === 'update').length, 6);
});
test('pause holds location and resume excludes paused time from speed', async t => {
  const f = await fixture(t); await f.start();
  f.advance(1000); await f.c.tickRoute();
  await f.c.pauseRoute(); const point = {...f.c.state.route.point};
  f.advance(60000); await f.c.tickRoute(); assert.deepEqual(f.c.state.route.point, point);
  await f.c.resumeRoute(); f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS * 2);
});
test('disconnect and sleep pause progress; reconnect auto-resumes from the held point', async t => {
  const f = await fixture(t); await f.start(); f.advance(1000); await f.c.tickRoute();
  await f.c.sessionEnded({deviceId: f.phone.id, error: 'Cable removed'});
  f.disconnect(); f.advance(30000); await f.c.scanDevices(); await f.c.tickRoute();
  assert.equal(f.c.state.route.status, 'paused'); close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  f.reconnect(); await f.c.scanDevices();
  assert.equal(f.c.state.session.status, 'active');
  assert.equal(f.c.state.route.status, 'running', 'Route must auto-resume after reconnect, without advancing during the outage');
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  f.advance(1000); await f.c.tickRoute(); close(f.c.state.route.traveledMeters, 2 * ROUTE_SPEED_MPS);
  await f.c.suspend(); f.advance(30000); await f.c.resume(); await f.c.scanDevices();
  assert.equal(f.c.state.route.status, 'running', 'Route must auto-resume after sleep too');
  close(f.c.state.route.traveledMeters, 2 * ROUTE_SPEED_MPS);
  await f.c.pauseRoute();
  await f.c.sessionEnded({deviceId: f.phone.id, error: 'Cable removed again'});
  f.disconnect(); await f.c.scanDevices(); f.reconnect(); await f.c.scanDevices();
  assert.equal(f.c.state.route.status, 'paused', 'A route the user paused by hand must stay paused across reconnects');
});
test('failed initial route can resume through manual reconnect, without getting stuck', async t => {
  const f = await fixture(t); const set = f.adapter.set;
  f.adapter.set = async () => {throw new Error('USB lost');};
  await assert.rejects(f.start()); assert.equal(f.c.state.route.status, 'paused');
  f.adapter.set = set; await f.c.resumeRoute(); assert.equal(f.c.state.route.status, 'running');
});
test('slow transport and long scheduling stalls never pause or teleport the route', async t => {
  const f = await fixture(t); await f.start();
  let finish; f.adapter.update = () => new Promise(resolve => {finish = resolve;});
  f.advance(1000); const tick = f.c.tickRoute();
  await f.c.tickRoute(); // No concurrent write.
  f.advance(1500); finish({}); await tick;
  assert.equal(f.c.state.route.status, 'running', 'An update taking 2.5s must not pause the route');
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS);
  assert.equal(f.c.state.route.slowTransport, true, 'Slow transport is surfaced as information');
  f.adapter.update = async (device, point) => { f.calls.push(['update', device.id, {...point}]); return {}; };
  f.advance(60000); await f.c.tickRoute();
  assert.equal(f.c.state.route.status, 'running', 'A 60s scheduling stall must not pause the route');
  close(f.c.state.route.traveledMeters, ROUTE_SPEED_MPS * 11, 0.01); // 1s + travel capped at 10s
  assert.equal(f.c.state.route.slowTransport, false, 'Fast updates clear the slow note');
});
test('Restore waits for an in-flight update, then clears without a late restart', async t => {
  const f = await fixture(t); await f.start(); let finish;
  f.adapter.update = () => new Promise(resolve => {finish = resolve;});
  f.advance(1000); const tick = f.c.tickRoute(); const stop = f.c.stopLocation();
  assert.ok(!f.calls.some(c => c[0] === 'clear')); finish({});
  await Promise.all([tick, stop]);
  assert.equal(f.c.state.session, null); assert.equal(f.c.state.route, null); assert.equal(f.c.routeTimer, null);
});
test('failed update or late acknowledgement cannot hide transport loss, and a new phone never receives the route', async t => {
  const f = await fixture(t); await f.start();
  f.adapter.update = async () => {await f.c.sessionEnded({deviceId: f.phone.id, error: 'Lost USB'}); return {};};
  f.advance(1000); await f.c.tickRoute();
  assert.equal(f.c.state.session.status, 'waiting'); assert.equal(f.c.state.route.status, 'paused');
  f.replace(); await f.c.scanDevices();
  assert.equal(f.c.state.route, null); assert.equal(f.c.state.session, null);
  assert.equal(f.calls.filter(c => c[0] === 'set').length, 1);
});
test('unplanned routes and changed endpoints cannot bypass route planning', async t => {
  const f = await fixture(t);
  await assert.rejects(f.c.startRoute({deviceId: f.phone.id, routeId: 'other'}), /Plan the route/);
  await f.start(); await assert.rejects(f.c.planRoute(plan.waypoints), /restore real location/);
  await assert.rejects(f.start(), /Restore real location/);
});
test('transport modes choose their routing service and default pace; custom speed overrides', async () => {
  const urls = [];
  const fetcher = async url => { urls.push(url); return new Response(JSON.stringify({code: 'Ok', routes: [{geometry: {type: 'LineString', coordinates: path.coordinates}}]})); };
  const walk = await new Router({fetcher, now: () => 5000}).plan(plan.waypoints, {mode: 'walk'});
  assert.match(urls[0], /routed-foot/); assert.equal(walk.mode, 'walk'); assert.equal(walk.speedMph, 3);
  close(walk.durationSeconds, walk.distanceMeters / mphToMps(3), 1e-9);
  const cycle = await new Router({fetcher, now: () => 5000}).plan(plan.waypoints, {mode: 'cycle', speedMph: 20});
  assert.match(urls[1], /routed-bike/); assert.equal(cycle.speedMph, 20);
  close(cycle.durationSeconds, cycle.distanceMeters / mphToMps(20), 1e-9);
  const drive = await new Router({fetcher, now: () => 5000}).plan(plan.waypoints);
  assert.match(urls[2], /routed-car/); assert.equal(drive.speedMph, 45);
  await assert.rejects(new Router({fetcher}).plan(plan.waypoints, {mode: 'fly'}), /Drive, Cycle or Walk/);
  await assert.rejects(new Router({fetcher}).plan(plan.waypoints, {speedMph: 0}), /between 0.5 and 250/);
});
test('pace profile slows for the corner and stops there only when driving', () => {
  const drive = buildPaceProfile(path, 'drive');
  const corner = path.cumulative[1];
  assert.ok(paceFactorAt(drive, corner) < 0.6, `corner factor ${paceFactorAt(drive, corner)}`);
  assert.equal(paceFactorAt(drive, 0), 1);
  assert.ok(paceFactorAt(drive, 10) < 1 && paceFactorAt(drive, 10) > paceFactorAt(drive, corner), 'Factor eases down toward the corner');
  assert.equal(drive.stops.length, 1); close(drive.stops[0].at, corner, 1e-9); assert.equal(drive.stops[0].dwellSeconds, 2.5);
  const walk = buildPaceProfile(path, 'walk');
  assert.equal(walk.stops.length, 0);
  assert.ok(paceFactorAt(walk, corner) > paceFactorAt(drive, corner));
});
test('pacing accelerates from rest, dwells at the corner stop, then completes', async t => {
  const f = await fixture(t);
  await f.c.planRoute({waypoints: plan.waypoints, pacing: true});
  await f.start();
  f.advance(1000); await f.c.tickRoute();
  assert.ok(f.c.state.route.traveledMeters > 0 && f.c.state.route.traveledMeters < ROUTE_SPEED_MPS, 'First second must accelerate, not jump to cruise');
  let held = null;
  for (let i = 0; i < 40 && f.c.state.route.status === 'running'; i++) {
    const before = f.c.state.route.traveledMeters;
    f.advance(1000); await f.c.tickRoute();
    if (held == null && f.c.state.route.status === 'running' && f.c.state.route.traveledMeters === before && before > 0) held = before;
  }
  assert.equal(f.c.state.route.status, 'completed');
  assert.ok(held != null, 'Route must dwell at the pacing stop for a tick');
  close(held, path.cumulative[1], 0.01);
});
test('custom speed drives the tick rate', async t => {
  const f = await fixture(t);
  await f.c.planRoute({waypoints: plan.waypoints, pacing: false, speedMph: 90});
  await f.start();
  f.advance(1000); await f.c.tickRoute();
  close(f.c.state.route.traveledMeters, mphToMps(90));
  assert.equal(f.c.state.route.speedMph, 90);
});
test('looping routes wrap to the start and keep running', async t => {
  const f = await fixture(t);
  await f.c.planRoute({waypoints: plan.waypoints, pacing: false, loop: true});
  await f.start();
  for (let i = 0; i < 12; i++) { f.advance(1000); await f.c.tickRoute(); }
  assert.equal(f.c.state.route.status, 'running');
  assert.equal(f.c.state.route.loops, 1);
  assert.ok(f.c.state.route.traveledMeters < ROUTE_SPEED_MPS * 2);
});
test('saved routes persist, start in one call, and history records and replays runs', async t => {
  const f = await fixture(t);
  await f.c.saveRoute({name: 'Home → Office', waypoints: plan.waypoints, mode: 'cycle', speedMph: 14, pacing: false});
  assert.equal(f.data.savedRoutes.length, 1);
  assert.equal(f.data.savedRoutes[0].mode, 'cycle');
  const savedId = f.c.state.savedRoutes[0].id;
  const started = await f.c.startSavedRoute(savedId, f.phone.id);
  assert.equal(started.route.status, 'running');
  assert.equal(started.route.mode, 'cycle'); assert.equal(started.route.speedMph, 14);
  for (let i = 0; i < 60 && f.c.state.route.status === 'running'; i++) { f.advance(1000); await f.c.tickRoute(); }
  assert.equal(f.c.state.route.status, 'completed');
  assert.equal(f.c.state.routeHistory.length, 1);
  assert.equal(f.c.state.routeHistory[0].completed, true);
  await f.c.stopLocation();
  const replayed = await f.c.replayRoute(f.c.state.routeHistory[0].id);
  assert.equal(replayed.waypoints.length, 2);
  await f.c.deleteRoute(savedId);
  assert.equal(f.c.state.savedRoutes.length, 0);
  await assert.rejects(f.c.saveRoute({name: '  ', waypoints: plan.waypoints}), /Name the route/);
});
test('GPX-imported tracks plan without the routing service and can be saved', async t => {
  const f = await fixture(t);
  const imported = await f.c.importRoute({coordinates: path.coordinates, label: 'Morning loop', mode: 'walk', speedMph: 3});
  assert.equal(imported.imported, true);
  close(imported.distanceMeters, path.distanceMeters, 1e-9);
  await f.c.saveRoute({name: 'Morning loop', waypoints: imported.waypoints, coordinates: path.coordinates, mode: 'walk', speedMph: 3});
  assert.equal(f.c.state.savedRoutes[0].coordinates.length, 3);
  const started = await f.c.startSavedRoute(f.c.state.savedRoutes[0].id, f.phone.id);
  assert.equal(started.route.status, 'running'); assert.equal(started.route.mode, 'walk');
  await f.c.stopLocation();
  await assert.rejects(f.c.importRoute({coordinates: [[0, 0]]}), /different|Invalid|invalid/);
});
