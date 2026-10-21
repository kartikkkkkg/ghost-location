import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGpx, parseGpx } from '../src/gpx.js';

test('GPX export/import round-trips the track and waypoints', () => {
  const coordinates = [[77.2, 28.61], [77.21, 28.62], [77.22, 28.63]];
  const waypoints = [{ latitude: 28.61, longitude: 77.2, label: 'Start & <End>' }, { latitude: 28.63, longitude: 77.22, label: 'Finish' }];
  const xml = buildGpx({ name: 'Morning loop', coordinates, waypoints });
  assert.match(xml, /<gpx version="1.1" creator="Roam"/);
  assert.match(xml, /Start &amp; &lt;End&gt;/);
  assert.deepEqual(parseGpx(xml), coordinates);
});

test('GPX import prefers track points, falls back to route points then waypoints', () => {
  const withRoute = `<gpx><rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte><wpt lat="9" lon="9"/><wpt lat="8" lon="8"/></gpx>`;
  assert.deepEqual(parseGpx(withRoute), [[2, 1], [4, 3]]);
  const onlyWaypoints = `<gpx><wpt lon="5" lat="6"/><wpt lat="7" lon="8"/></gpx>`;
  assert.deepEqual(parseGpx(onlyWaypoints), [[5, 6], [8, 7]]);
  assert.deepEqual(parseGpx('<gpx></gpx>'), []);
  assert.deepEqual(parseGpx('not xml at all'), []);
  assert.deepEqual(parseGpx('<gpx><trkpt lat="1" lon="2"/></gpx>'), [], 'A single point is not a route');
});
