import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const SESSION_COOKIE = 'ghost-control';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_FILES = new Map([
  ['/vendor/leaflet.js', ['vendor/leaflet.js', 'text/javascript; charset=utf-8']],
  ['/vendor/leaflet.css', ['vendor/leaflet.css', 'text/css; charset=utf-8']],
  ['/vendor/images/layers.png', ['vendor/images/layers.png', 'image/png']],
  ['/vendor/images/layers-2x.png', ['vendor/images/layers-2x.png', 'image/png']],
  ['/vendor/images/marker-icon.png', ['vendor/images/marker-icon.png', 'image/png']],
  ['/vendor/images/marker-icon-2x.png', ['vendor/images/marker-icon-2x.png', 'image/png']],
  ['/vendor/images/marker-shadow.png', ['vendor/images/marker-shadow.png', 'image/png']],
]);

function lanAddress() {
  const interfaces = networkInterfaces();
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) candidates.push({ name, address: entry.address });
    }
  }
  // Prefer physical LAN interfaces over virtual/VPN ones.
  const preferred = candidates.find(({ name }) => /^(en|eth|wlan|wi-?fi)/i.test(name));
  return (preferred || candidates[0])?.address || '127.0.0.1';
}

function publicState(snapshot) {
  return {
    devices: (snapshot.devices || []).map(({ id, name, platform, connection, state, detail }) => ({ id, name, platform, connection, state, detail })),
    session: snapshot.session,
    route: snapshot.route,
    savedPlaces: snapshot.savedPlaces || [],
    recentPlaces: snapshot.recentPlaces || [],
    busy: Boolean(snapshot.busy),
    warning: snapshot.warning || null,
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request was not valid JSON.'); }
}

/**
 * LAN web control for Roam. Serves a phone-friendly control page and a small
 * JSON API over the same Controller the desktop UI uses. Access requires the
 * PIN shown in the desktop app; the PIN is regenerated on every start and web
 * sessions expire after 12 hours. The server only makes sense on a trusted
 * local network — it binds all interfaces so a phone on the same Wi-Fi can
 * reach it, and every API route except login requires a session cookie.
 */
export class WebControlServer {
  constructor({ controller, search = async () => [], port = 8420, pin = null } = {}) {
    if (!controller) throw new Error('A controller is required.');
    this.controller = controller;
    this.search = search;
    this.port = port;
    this.pin = pin || String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.sessions = new Map();
    this.loginFailures = new Map();
    this.server = null;
    this.startError = null;
    this.page = null;
  }

  info() {
    return {
      running: Boolean(this.server?.listening),
      url: `http://${lanAddress()}:${this.port}`,
      port: this.port,
      pin: this.pin,
      error: this.startError,
    };
  }

  async start() {
    if (this.server) return this.info();
    this.page = await readFile(path.join(webRoot, 'control.html'));
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message || 'Web control failed.' });
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      const onError = error => { this.startError = error.message; reject(error); };
      this.server.once('error', onError);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.removeListener('error', onError);
        this.port = this.server.address().port;
        this.startError = null;
        resolve();
      });
    });
    return this.info();
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.sessions.clear();
    await new Promise(resolve => server.close(resolve));
  }

  sessionToken(request) {
    const header = request.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return null;
  }

  authenticated(request) {
    const token = this.sessionToken(request);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires < Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  loginLocked(ip) {
    const failures = (this.loginFailures.get(ip) || []).filter(at => Date.now() - at < LOGIN_WINDOW_MS);
    this.loginFailures.set(ip, failures);
    return failures.length >= LOGIN_MAX_FAILURES;
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname;

    if (request.method === 'GET' && route === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(this.page);
      return;
    }
    const staticFile = request.method === 'GET' && STATIC_FILES.get(route);
    if (staticFile) {
      const [relative, type] = staticFile;
      const body = await readFile(path.join(webRoot, relative));
      response.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
      response.end(body);
      return;
    }

    if (request.method === 'POST' && route === '/api/login') {
      const ip = request.socket.remoteAddress || 'unknown';
      if (this.loginLocked(ip)) { sendJson(response, 429, { error: 'Too many incorrect PINs. Wait a minute and try again.' }); return; }
      const { pin } = await readJson(request);
      const given = Buffer.from(typeof pin === 'string' ? pin : '');
      const expected = Buffer.from(this.pin);
      const ok = given.length === expected.length && timingSafeEqual(given, expected);
      if (!ok) {
        const failures = this.loginFailures.get(ip) || [];
        failures.push(Date.now());
        this.loginFailures.set(ip, failures);
        sendJson(response, 401, { error: 'Incorrect PIN.' });
        return;
      }
      this.loginFailures.delete(ip);
      const token = randomBytes(24).toString('hex');
      this.sessions.set(token, Date.now() + SESSION_TTL_MS);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!route.startsWith('/api/')) { sendJson(response, 404, { error: 'Not found.' }); return; }
    if (!this.authenticated(request)) { sendJson(response, 401, { error: 'Enter the PIN from the Roam app first.' }); return; }

    try {
      if (request.method === 'GET' && route === '/api/state') {
        sendJson(response, 200, publicState(this.controller.snapshot()));
      } else if (request.method === 'POST' && route === '/api/logout') {
        const token = this.sessionToken(request);
        if (token) this.sessions.delete(token);
        sendJson(response, 200, { ok: true });
      } else if (request.method === 'POST' && route === '/api/scan') {
        sendJson(response, 200, publicState(await this.controller.scanDevices()));
      } else if (request.method === 'GET' && route === '/api/search') {
        const query = url.searchParams.get('q') || '';
        sendJson(response, 200, { results: query.trim() ? await this.search(query) : [] });
      } else if (request.method === 'POST' && route === '/api/apply') {
        const body = await readJson(request);
        sendJson(response, 200, publicState(await this.controller.applyLocation(body)));
      } else if (request.method === 'POST' && route === '/api/restore') {
        sendJson(response, 200, publicState(await this.controller.stopLocation()));
      } else if (request.method === 'POST' && route === '/api/route/plan') {
        const body = await readJson(request);
        sendJson(response, 200, { route: await this.controller.planRoute(body.waypoints) });
      } else if (request.method === 'POST' && route === '/api/route/start') {
        const body = await readJson(request);
        sendJson(response, 200, publicState(await this.controller.startRoute(body)));
      } else if (request.method === 'POST' && route === '/api/route/pause') {
        sendJson(response, 200, publicState(await this.controller.pauseRoute()));
      } else if (request.method === 'POST' && route === '/api/route/resume') {
        sendJson(response, 200, publicState(await this.controller.resumeRoute()));
      } else {
        sendJson(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      sendJson(response, 400, { error: error.message || 'Operation failed.' });
    }
  }
}
