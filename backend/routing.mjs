import { randomUUID } from 'node:crypto';
import { place } from './validation.mjs';

export const ROUTE_SPEED_MPS = 45 * 1609.344 / 3600;
export const mphToMps = mph => mph * 1609.344 / 3600;
export const ROUTE_MODES = {
  drive: { label: 'Drive', verb: 'Driving', base: 'https://routing.openstreetmap.de/routed-car/route/v1/driving', defaultSpeedMph: 45, radiusMeters: 1000 },
  cycle: { label: 'Cycle', verb: 'Cycling', base: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving', defaultSpeedMph: 12, radiusMeters: 500 },
  walk: { label: 'Walk', verb: 'Walking', base: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving', defaultSpeedMph: 3, radiusMeters: 500 },
};
export function routeMode(mode) {
  const resolved = ROUTE_MODES[mode] ? mode : null;
  if (!resolved) throw new Error('Choose Drive, Cycle or Walk.');
  return resolved;
}
export function routeSpeedMph(mode, value) {
  const fallback = ROUTE_MODES[mode].defaultSpeedMph;
  if (value == null) return fallback;
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 250) throw new Error('Choose a route speed between 0.5 and 250 mph.');
  return speed;
}
const radians = degrees => degrees * Math.PI / 180;
const longitudeDelta = (from, to) => ((to - from + 540) % 360) - 180;

export function distanceBetween(a, b) {
  const dLat = radians(b[1] - a[1]), dLon = radians(longitudeDelta(a[0], b[0]));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function measurePath(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 100000) throw new Error('The routing service returned an invalid or excessively long path.');
  const cumulative = [0];
  coordinates.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error('Invalid route coordinates.');
    place({ longitude: p[0], latitude: p[1] });
    if (i) cumulative.push(cumulative[i - 1] + distanceBetween(coordinates[i - 1], p));
  });
  if (cumulative.at(-1) < 1) throw new Error('Choose two different locations at least a metre apart.');
  return { coordinates, cumulative, distanceMeters: cumulative.at(-1) };
}

export function pointAlong(path, distance) {
  const target = Math.min(path.distanceMeters, Math.max(0, distance));
  let lo = 1, hi = path.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (path.cumulative[mid] < target) lo = mid + 1; else hi = mid;
  }
  const a = path.coordinates[lo - 1], b = path.coordinates[lo];
  const length = path.cumulative[lo] - path.cumulative[lo - 1];
  const fraction = length ? (target - path.cumulative[lo - 1]) / length : 0;
  // Spherical interpolation stays on the segment, including across the dateline.
  const angle = distanceBetween(a, b) / 6371008.8;
  let latitude, longitude;
  if (angle < 1e-10) [longitude, latitude] = a;
  else {
    const x = Math.sin((1 - fraction) * angle) / Math.sin(angle), y = Math.sin(fraction * angle) / Math.sin(angle);
    const aLat = radians(a[1]), aLon = radians(a[0]), bLat = radians(b[1]), bLon = radians(b[0]);
    const vx = x * Math.cos(aLat) * Math.cos(aLon) + y * Math.cos(bLat) * Math.cos(bLon);
    const vy = x * Math.cos(aLat) * Math.sin(aLon) + y * Math.cos(bLat) * Math.sin(bLon);
    const vz = x * Math.sin(aLat) + y * Math.sin(bLat);
    latitude = Math.atan2(vz, Math.hypot(vx, vy)) * 180 / Math.PI;
    longitude = Math.atan2(vy, vx) * 180 / Math.PI;
  }
  if (target === path.distanceMeters) [longitude, latitude] = path.coordinates.at(-1);
  return { latitude, longitude };
}

function bearing(a, b) {
  const lat1 = radians(a[1]), lat2 = radians(b[1]), dLon = radians(longitudeDelta(a[0], b[0]));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

/**
 * Realistic pacing for a measured path: a target-speed factor per vertex
 * (slowing for turns) plus full stops at sharp intersections, spaced out so
 * a dense street grid does not stop every few metres. Pure geometry — the
 * controller integrates it over time. Walkers slow less and never stop.
 */
export function buildPaceProfile(path, mode = 'drive') {
  const { coordinates, cumulative, distanceMeters } = path;
  const maxReduction = mode === 'walk' ? 0.4 : 0.78;
  const stopAngle = mode === 'drive' ? 80 : mode === 'cycle' ? 100 : Infinity;
  const stopSpacing = mode === 'drive' ? 180 : 250;
  const dwellSeconds = mode === 'drive' ? 2.5 : 1.5;
  const samples = [{ at: 0, factor: 1 }];
  const stops = [];
  let lastStopAt = -Infinity;
  for (let i = 1; i < coordinates.length - 1; i++) {
    const turn = Math.abs(((bearing(coordinates[i], coordinates[i + 1]) - bearing(coordinates[i - 1], coordinates[i]) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
    const t = Math.min(1, Math.max(0, (turn - 15) / 125));
    const factor = 1 - maxReduction * (t * t * (3 - 2 * t));
    const at = cumulative[i];
    if (samples.at(-1).at === at) samples[samples.length - 1].factor = Math.min(samples.at(-1).factor, factor);
    else samples.push({ at, factor });
    if (turn >= stopAngle && at - lastStopAt >= stopSpacing && at > 60 && distanceMeters - at > 60) {
      stops.push({ at, dwellSeconds });
      lastStopAt = at;
    }
  }
  samples.push({ at: distanceMeters, factor: 1 });
  return { samples, stops };
}

export function paceFactorAt(profile, distance) {
  const samples = profile?.samples;
  if (!samples?.length) return 1;
  if (distance <= samples[0].at) return samples[0].factor;
  if (distance >= samples.at(-1).at) return samples.at(-1).factor;
  let lo = 1, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].at < distance) lo = mid + 1; else hi = mid; }
  const a = samples[lo - 1], b = samples[lo];
  const span = b.at - a.at;
  return span ? a.factor + (b.factor - a.factor) * (distance - a.at) / span : b.factor;
}

export class Router {
  constructor({ fetcher = fetch, now = Date.now } = {}) { this.fetcher = fetcher; this.now = now; this.lastRequest = -Infinity; }
  async plan(input, options = {}) {
    if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('Add between 2 and 12 route stops.');
    const waypoints = input.map(p => place(p));
    const mode = routeMode(options.mode || 'drive');
    const speedMph = routeSpeedMph(mode, options.speedMph);
    if (this.now() - this.lastRequest < 1000) throw new Error('Wait a second before planning another route.');
    this.lastRequest = this.now();
    const coordinates = waypoints.map(p => `${p.longitude},${p.latitude}`).join(';');
    const profile = ROUTE_MODES[mode];
    const url = `${profile.base}/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=${waypoints.map(() => profile.radiusMeters).join(';')}`;
    let data;
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'RoamLocation/0.2', Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Routing service returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('Route is too large. Choose a shorter path.');
      data = JSON.parse(body);
    } catch (error) { throw new Error(`Could not plan the route. Check your internet connection and try again. ${error.message}`); }
    if (data.code !== 'Ok' || data.routes?.[0]?.geometry?.type !== 'LineString') throw new Error(`No ${profile.label.toLowerCase()} route found. Move the pins closer to connected roads and try again.`);
    const path = measurePath(data.routes[0].geometry.coordinates);
    return { id: randomUUID(), waypoints, coordinates: path.coordinates, distanceMeters: path.distanceMeters, durationSeconds: path.distanceMeters / mphToMps(speedMph), speedMph, mode };
  }
}
