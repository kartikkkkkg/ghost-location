import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { place, text, geocoderUrl } from './validation.mjs';
import { Router, measurePath, pointAlong, mphToMps, buildPaceProfile, paceFactorAt, routeMode, routeSpeedMph } from './routing.mjs';

const REPLACEABLE_SESSION_STATUSES = new Set(['unknown', 'waiting', 'error']);
const USABLE_REPLACEMENT_STATES = new Set(['ready', 'setup-required']);

export class Controller extends EventEmitter {
  constructor({ adapters, store, now = Date.now, router = new Router(), clock = () => performance.now(), network = async () => ({wifi: false}) }) {
    super(); this.adapters = adapters; this.store = store;
    this.state = { devices: [], runtime: {}, session: null, savedPlaces: [], recentPlaces: [], savedRoutes: [], routeHistory: [], preferences: {}, busy: false, warning: null };
    this.scanning = null;
    this.now = now; this.network = network; this.networkCheckedAt = -Infinity;
    this.resumeSessionId = null;
    this.retryAt = 0;
    this.retryAttempts = 0;
    this.suspended = false;
    this.closing = false;
    this.recoveryPromise = null;
    this.deviceMisses = new Map();
    this.router = router; this.clock = clock;
    this.plannedRoute = null; this.routePath = null;
    this.state.route = null; this.routeTimer = null; this.routeUpdate = null;
  }
  async init() {
    const saved = await this.store.load();
    Object.assign(this.state, saved, { warning: this.store.warning });
    for (const adapter of Object.values(this.adapters)) adapter.connection = this.state.preferences.connection === 'wifi' ? 'wifi' : 'usb';
    if (this.state.session) {
      this.state.session.status = 'unknown';
      this.state.session.id ||= randomUUID();
      this.state.session.autoReconnect = false;
      this.state.session.message = 'Previous session found. Connect this phone, then choose Retry location or Restore.';
      await this.persist();
    }
    return this.scanDevices();
  }
  snapshot() { return structuredClone(this.state); }
  notify() { this.emit('state', this.snapshot()); }
  async persist() {
    const { savedPlaces, recentPlaces, savedRoutes, routeHistory, session, preferences } = this.state;
    await this.store.save({ schemaVersion: 1, savedPlaces, recentPlaces, savedRoutes, routeHistory, session, preferences });
  }
  async exclusive(fn) {
    if (this.state.busy) throw new Error('Wait for the current device operation to finish.');
    // Wait for any scan before making device state decisions, then prevent another scan.
    this.state.busy = true; this.notify();
    try { if (this.scanning) await this.scanning; if (this.routeUpdate) await this.routeUpdate; await fn(); }
    finally { this.state.busy = false; this.notify(); }
    return this.snapshot();
  }
  async scanDevices() {
    if (this.closing) return this.snapshot();
    if (this.scanning) return this.scanning;
    if (this.state.busy) return this.snapshot();
    this.scanning = this.scan();
    try { await this.scanning; } finally { this.scanning = null; }
    await this.reconnectIfNeeded();
    return this.snapshot();
  }
  async scan() {
    const previousDevices = this.state.devices;
    if (this.now() - this.networkCheckedAt >= 15000) {
      this.networkCheckedAt = this.now();
      this.state.network = await this.network().catch(() => ({wifi: false}));
    }
    const results = await Promise.all(Object.entries(this.adapters).map(async ([platform, adapter]) => {
      try {
        const status = await adapter.status();
        const devices = status.available ? await adapter.list() : [];
        return { platform, status, devices };
      } catch (error) { return { platform, status: { available: false, message: error.message }, devices: [] }; }
    }));
    this.state.devices = results.flatMap(r => r.devices);
    this.state.runtime = Object.fromEntries(results.map(r => [r.platform, r.status]));
    const active = this.state.session;
    const connected = active && this.state.devices.some(d => d.id === active.deviceId && d.state !== 'offline' && d.state !== 'unauthorized');
    if (connected) this.deviceMisses.delete(active.deviceId);
    if (active && active.status === 'active' && !connected) {
      const misses = (this.deviceMisses.get(active.deviceId) || 0) + 1;
      this.deviceMisses.set(active.deviceId, misses);
      const lastConfirmation = Date.parse(active.lastRefreshAt || '');
      const graceMs = Math.max(6000, (active.refreshIntervalMs || 1000) * 3);
      const refreshStillAlive = active.platform === 'ios' && Number.isFinite(lastConfirmation) && this.now() - lastConfirmation <= graceMs;
      // usbmux/ADB enumeration can briefly omit a connected phone. An active
      // iPhone DVT acknowledgement is stronger evidence than a discovery miss.
      if (refreshStillAlive || misses < 2) {
        // Do not make the selected phone card and controls flash disconnected
        // during a discovery result that we have deliberately classified as a
        // transient miss. The next scan or a transport-loss event resolves it.
        const previousDevice = previousDevices.find(device => device.id === active.deviceId);
        if (previousDevice && !this.state.devices.some(device => device.id === active.deviceId)) {
          this.state.devices.push({ ...previousDevice });
        }
        this.notify(); return this.snapshot();
      }
      active.status = this.canResume(active) ? 'waiting' : 'unknown';
      this.pauseRouteMotion('Phone disconnected. The route resumes on its own when this phone reconnects.', { autoResume: true });
      active.autoReconnect = this.canResume(active);
      active.message = active.autoReconnect ? 'Phone disconnected. Waiting to reconnect this phone and resume the selected location.' : 'Phone disconnected. Connect this phone, then retry the location or restore it.';
      this.retryAt = 0;
      await this.persist();
    }
    await this.discardUnresolvedSessionForDifferentPhone();
    this.notify(); return this.snapshot();
  }
  async discardUnresolvedSessionForDifferentPhone() {
    const previous = this.state.session;
    if (!previous || !REPLACEABLE_SESSION_STATUSES.has(previous.status)) return false;
    const replacement = this.state.devices.find(device => device.id !== previous.deviceId &&
      (previous.platform === 'ios' || (previous.connection || 'usb') === 'usb' || previous.hardwareId) && ['usb', 'wifi'].includes(device.connection) && USABLE_REPLACEMENT_STATES.has(device.state));
    if (!replacement) return false;

    // A recovery record from another phone must not lock the newly connected
    // phone out of Set/Prepare. Persist its removal before dropping transport
    // bookkeeping so a disk failure still leaves an honest recoverable record.
    const recovery = {
      resumeSessionId: this.resumeSessionId,
      retryAt: this.retryAt,
      retryAttempts: this.retryAttempts,
    };
    this.state.session = null;
    this.resumeSessionId = null;
    this.retryAt = 0;
    this.retryAttempts = 0;
    try {
      await this.persist();
    } catch (error) {
      this.state.session = previous;
      Object.assign(this, recovery);
      this.state.warning = `Could not clear the previous phone record: ${error.message}`;
      return false;
    }

    this.deviceMisses.delete(previous.deviceId);
    this.pauseRouteMotion(); this.state.route = null;
    const oldId = typeof previous.deviceId === 'string' ? previous.deviceId : null;
    const oldSerial = typeof previous.serial === 'string' ? previous.serial : oldId?.replace(/^[^:]+:/, '');
    if (oldId && oldSerial && typeof previous.platform === 'string') {
      const oldDevice = {
        id: oldId,
        serial: oldSerial,
        name: previous.deviceName || 'Previous phone',
        platform: previous.platform,
        connection: previous.connection || 'usb',
        ...(previous.hardwareId ? {hardwareId: previous.hardwareId} : {}),
        state: 'offline',
      };
      try {
        await this.adapters[previous.platform]?.reset?.(oldDevice);
      } catch (error) {
        this.state.warning = `The previous phone record was cleared, but its old transport could not be closed: ${error.message}`;
      }
    }
    return true;
  }
  device(id) {
    if (typeof id !== 'string') throw new Error('Select a connected phone.');
    const device = this.state.devices.find(d => d.id === id && d.connection === (this.state.preferences.connection || 'usb'));
    if (!device) throw new Error('That phone is no longer connected. Reconnect it and refresh.');
    if (['unauthorized', 'offline'].includes(device.state)) throw new Error(device.detail || 'Unlock your phone and trust this computer.');
    return device;
  }
  async setConnection(connection) {
    if (!['usb', 'wifi'].includes(connection)) throw new Error('Choose USB or Wi-Fi.');
    if (connection === (this.state.preferences.connection || 'usb')) return this.snapshot();
    if (connection === 'wifi' && this.state.session?.status === 'active' && (this.state.session.connection || 'usb') === 'usb') return this.switchToWifi(this.state.session.deviceId);
    return this.exclusive(async () => {
      if (this.state.session) throw new Error('Restore the current location before changing connections.');
      const previous = this.state.preferences.connection;
      this.state.preferences.connection = connection;
      try { await this.persist(); } catch (error) { this.state.preferences.connection = previous; throw error; }
      for (const adapter of Object.values(this.adapters)) adapter.connection = connection;
      this.state.devices = [];
      await this.scan();
    });
  }
  async switchToWifi(id) {
    return this.exclusive(async () => {
      const usb = this.device(id), current = this.state.session, adapter = this.adapters[usb.platform];
      if (usb.connection !== 'usb' || usb.state !== 'ready') throw new Error('Connect and prepare your phone over USB first.');
      if (current && (current.deviceId !== id || current.status !== 'active')) throw new Error('Retry or restore this phone’s session before switching.');
      const wasRunning = this.state.route?.status === 'running';
      this.pauseRouteMotion('Checking Wi-Fi. Holding the current route location.');
      const resumeMotion = () => {
        if (wasRunning && this.state.route?.status === 'paused' && this.state.session?.status === 'active' && !this.closing && !this.suspended) {
          this.state.route.status = 'running';
          this.state.route.message = this.routeMessage(this.state.route);
          this.routeStepAt = this.clock(); this.scheduleRouteTick();
        }
      };
      let touched = false, transport = usb;
      const chooseTransport = device => {
        for (const item of Object.values(this.adapters)) item.connection = device.connection;
        this.state.preferences.connection = device.connection;
        this.state.devices = [device];
        if (current) {
          Object.assign(current, {id: randomUUID(), serial: device.serial, connection: device.connection,
            ...(device.hardwareId ? {hardwareId: device.hardwareId} : {}),
            status: 'reconnecting', lastRefreshAt: null, refreshCount: 0, message: `Connecting over ${device.connection === 'wifi' ? 'Wi-Fi' : 'USB'}…`});
          this.resumeSessionId = current.id;
        }
      };
      try {
        this.notify();
        // Keep the USB location stream until the same trusted phone answers over Wi-Fi.
        const wireless = await adapter.prepareWifi(usb);
        if (wireless?.id !== usb.id || wireless.platform !== usb.platform || wireless.connection !== 'wifi' || wireless.state !== 'ready') throw new Error('The same phone is not ready on Wi-Fi. Keep the USB cable connected.');
        if (this.closing || this.suspended || (current && (this.state.session !== current || current.status !== 'active'))) throw new Error('The phone connection changed while checking Wi-Fi.');
        if (current) {
          current.status = 'reconnecting'; current.message = 'Switching this location to Wi-Fi…';
          try { await this.persist(); } catch (error) { current.status = 'active'; throw error; }
          touched = true; this.notify();
          await adapter.reset(usb); // Close the transport without sending a real-location restore.
        }
        chooseTransport(wireless); transport = wireless;
        await this.persist(); this.notify();
        if (current) {
          const result = await adapter.set(wireless, {latitude: current.latitude, longitude: current.longitude, sessionId: current.id, reconnecting: true});
          if (this.closing || this.suspended || current.status !== 'reconnecting') throw new Error('The Wi-Fi connection was interrupted.');
          this.confirmActive(current, result);
          current.message = 'Connected over Wi-Fi. You can unplug the USB cable.';
          await this.persist();
        }
        resumeMotion();
      } catch (error) {
        if (touched && current && !this.closing && !this.suspended) {
          try {
            await adapter.reset(transport);
            chooseTransport(usb); transport = usb;
            await this.persist();
            const result = await adapter.set(usb, {latitude: current.latitude, longitude: current.longitude, sessionId: current.id, reconnecting: true});
            if (this.closing || this.suspended || current.status !== 'reconnecting') throw new Error('USB recovery was interrupted.');
            this.confirmActive(current, result); await this.persist(); resumeMotion();
          } catch (recoveryError) {
            current.status = 'unknown'; current.autoReconnect = false; this.resumeSessionId = null;
            current.message = `Connection needs attention: ${recoveryError.message}. Reconnect this phone and Retry or Restore.`;
            await this.persist();
          }
        } else {
          if (!current && this.state.preferences.connection === 'wifi') {
            chooseTransport(usb); await this.persist();
          }
          resumeMotion();
        }
        throw new Error(`${error.message}${current?.status === 'active' ? ' Your location is still running over USB.' : ''}`);
      }
    });
  }
  async connectWifi(input) {
    return this.exclusive(async () => {
      const recoveringAndroid = input?.platform === 'android' && this.state.session?.platform === 'android' && this.state.session?.connection === 'wifi' && REPLACEABLE_SESSION_STATUSES.has(this.state.session?.status);
      if (this.state.session && !recoveringAndroid) throw new Error('Restore the current location before pairing a phone.');
      if (input?.platform === 'ios') {
        const device = this.device(input.deviceId);
        if (device.platform !== 'ios' || device.connection !== 'usb') throw new Error('Connect and select the iPhone by USB first.');
        await this.adapters.ios.enableWifi(device);
      } else if (input?.platform === 'android') {
        await this.adapters.android.connectWifi(input);
      } else throw new Error('Choose iPhone or Android.');
      await this.scan();
    });
  }
  async prepareDevice(id) {
    return this.exclusive(async () => {
      const device = this.device(id);
      const current = this.state.session;
      if (current && (current.deviceId !== device.id || current.status === 'active')) throw new Error('Restore the current session before preparing a phone.');
      if (current) {
        this.resumeSessionId = null; current.autoReconnect = false;
        await this.persist();
        await this.adapters[device.platform].reset?.(device);
      }
      await this.adapters[device.platform].prepare(device);
      await this.scan(); return this.snapshot();
    });
  }
  async applyLocation(input, route = null) {
    const point = place(input);
    return this.exclusive(async () => {
      const device = this.device(input.deviceId);
      const previous = this.state.session;
      if (previous && previous.deviceId !== device.id) {
        throw new Error('Restore the previous phone session before setting another location.');
      }
      this.pauseRouteMotion();
      const recovering = previous && previous.status !== 'active';
      const wasLive = previous && this.canResume(previous);
      const current = { id: randomUUID(), deviceId: device.id, platform: device.platform, deviceName: device.name, serial: device.serial, connection: device.connection, ...(device.hardwareId ? {hardwareId: device.hardwareId} : {}), ...point, status: 'applying', autoReconnect: Boolean(wasLive), refreshCount: 0, lastRefreshAt: null, message: recovering ? 'Reconnecting this phone and sending the new location…' : 'Sending the selected location to your phone…', startedAt: new Date(this.now()).toISOString() };
      this.state.session = current;
      // Journal before device mutation, so a crash cannot discard an unresolved session.
      try { await this.persist(); }
      catch (error) { this.state.session = previous; throw error; }
      const previousRoute = this.state.route;
      if (previousRoute && previousRoute.status !== 'completed' && (previousRoute.traveledMeters || 0) > 0) await this.recordRouteHistory(previousRoute, false);
      this.state.route = route ? { id: route.id, deviceId: device.id, status: 'starting', mode: route.mode || 'drive', speedMph: route.speedMph ?? 45, pacing: route.pacing !== false, loop: Boolean(route.loop), loops: 0, imported: Boolean(route.imported), waypoints: route.waypoints || [], startedAt: new Date(this.now()).toISOString(), distanceMeters: route.distanceMeters, traveledMeters: 0, remainingSeconds: route.durationSeconds, point, message: 'Sending the route start to your phone…' } : null;
      this.notify();
      this.resumeSessionId = wasLive ? current.id : null;
      this.retryAt = 0; this.retryAttempts = 0;
      try {
        if (recovering) await this.adapters[device.platform].reset?.(device);
        const result = await this.adapters[device.platform].set(device, { ...point, sessionId: current.id, reconnecting: Boolean(recovering) });
        if (this.closing) throw new Error('Roam is closing; this session must be checked when it reopens.');
        if (['unknown', 'waiting'].includes(current.status)) throw new Error(current.message);
        this.confirmActive(current, result);
        this.state.recentPlaces = [{ id: randomUUID(), ...point, usedAt: new Date().toISOString() }, ...this.state.recentPlaces.filter(p => p.latitude !== point.latitude || p.longitude !== point.longitude)].slice(0, 12);
        await this.persist(); return this.snapshot();
      } catch (error) {
        this.pauseRouteMotion('Could not start the route. Reconnect this phone, then resume.');
        current.status = 'unknown';
        current.message = `Could not confirm the location: ${error.message} You can retry on this phone or use Restore.`;
        this.scheduleRetry(current);
        await this.persist(); throw error;
      }
    });
  }
  async stopLocation() {
    // Cancel automatic recovery even when the cable is absent. A failed clear
    // must never cause the next device scan to resume something the user stopped.
    const recovering = this.recoveryPromise;
    if (this.state.busy && !recovering) throw new Error('Wait for the current device operation to finish.');
    this.pauseRouteMotion();
    this.resumeSessionId = null;
    if (this.state.session) this.state.session.autoReconnect = false;
    if (recovering) await recovering.catch(() => {});
    return this.exclusive(async () => {
      const session = this.state.session;
      if (!session) return this.snapshot();
      const recovering = session.status !== 'active';
      let device;
      try { device = this.device(session.deviceId); }
      catch (error) {
        session.status = 'unknown'; session.message = 'Automatic reconnect is paused. Connect this phone to stop its location simulation.';
        await this.persist(); throw error;
      }
      session.status = 'stopping'; session.message = 'Asking the phone to resume real location…';
      await this.persist(); this.notify();
      try {
        if (recovering) await this.adapters[device.platform].reset?.(device);
        await this.adapters[device.platform].clear(device);
        const finishedRoute = this.state.route;
        this.state.session = null; await this.persist(); this.state.route = null;
        if (finishedRoute && finishedRoute.status !== 'completed' && (finishedRoute.traveledMeters || 0) > 0) await this.recordRouteHistory(finishedRoute, false);
        return this.snapshot();
      } catch (error) {
        this.state.session = session;
        session.status = 'unknown'; session.message = `Restoration could not be confirmed: ${error.message}`;
        await this.persist(); throw error;
      }
    });
  }
  async sessionEnded({ deviceId, sessionId, error, retry = true }) {
    const current = this.state.session;
    if (current?.deviceId !== deviceId || (sessionId && sessionId !== current.id) || current.status === 'stopping') return;
    this.pauseRouteMotion('Connection interrupted. The route resumes on its own when this phone reconnects.', { autoResume: true });
    if (!retry) this.resumeSessionId = null;
    current.autoReconnect = this.canResume(current);
    current.status = current.autoReconnect ? 'waiting' : 'unknown';
    current.message = error || 'The device connection ended.';
    if (current.autoReconnect) current.message += ' Roam will reconnect this phone and resume the selected location.';
    this.retryAt = 0;
    try { await this.persist(); } catch { this.state.warning = 'Could not save session recovery state.'; }
    this.notify();
  }
  canResume(session = this.state.session) {
    return Boolean(session && this.resumeSessionId === session.id && !this.closing);
  }
  confirmActive(current, result = {}) {
    current.status = 'active'; current.autoReconnect = true;
    current.message = current.platform === 'ios' ? 'Sending the selected location every second while the phone stays connected.' : 'The phone helper sends the selected location every two seconds.';
    current.lastRefreshAt = result?.refreshedAt || new Date(this.now()).toISOString();
    current.refreshCount = Math.max(current.refreshCount || 0, result?.refreshCount || 1);
    current.refreshSource = current.platform === 'ios' ? 'command-ack' : 'helper-readback';
    current.refreshIntervalMs = current.platform === 'ios' ? 1000 : 2000;
    this.resumeSessionId = current.id;
    this.deviceMisses.delete(current.deviceId);
    this.retryAt = 0; this.retryAttempts = 0;
  }
  locationRefreshed({ deviceId, sessionId, latitude, longitude, refreshedAt, refreshCount, refreshIntervalMs, source }) {
    const current = this.state.session;
    const tolerance = source === 'helper-readback' ? 0.00000015 : 0;
    if (!current || current.status !== 'active' || current.deviceId !== deviceId || current.id !== sessionId ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(current.latitude - latitude) > tolerance ||
      Math.abs(current.longitude - longitude) > tolerance || !Number.isFinite(Date.parse(refreshedAt))) return;
    current.lastRefreshAt = refreshedAt;
    current.refreshCount = Number.isInteger(refreshCount) ? Math.max(current.refreshCount || 0, refreshCount) : (current.refreshCount || 0) + 1;
    current.refreshSource = source || (current.platform === 'ios' ? 'command-ack' : 'helper-readback');
    current.refreshIntervalMs = refreshIntervalMs || current.refreshIntervalMs;
    this.deviceMisses.delete(current.deviceId);
    // Keep one-second acknowledgements in memory; journal only intent/state transitions.
    this.notify();
  }
  scheduleRetry(current) {
    current.autoReconnect = this.canResume(current);
    if (current.autoReconnect) {
      this.retryAttempts++;
      this.retryAt = this.now() + Math.min(15000, 2000 * 2 ** Math.min(this.retryAttempts - 1, 3));
    }
  }
  async reconnectIfNeeded() {
    const current = this.state.session;
    if (!this.canResume(current) || this.suspended || this.state.busy || this.now() < this.retryAt ||
      !['waiting', 'unknown'].includes(current.status)) return;
    const device = this.state.devices.find(d => d.id === current.deviceId && d.connection === (current.connection || 'usb') && d.state === 'ready');
    if (!device) return;
    const operation = this.exclusive(async () => {
      if (this.state.session !== current || !this.canResume(current)) return;
      current.id = randomUUID(); this.resumeSessionId = current.id;
      current.status = 'reconnecting'; current.message = 'Reconnecting this phone and resuming the selected location…';
      try {
        await this.persist(); this.notify();
        await this.adapters[device.platform].reset?.(device);
        if (!this.canResume(current)) { current.status = 'unknown'; return; }
        const result = await this.adapters[device.platform].set(device, { latitude: current.latitude, longitude: current.longitude, label: current.label, sessionId: current.id, reconnecting: true });
        if (!this.canResume(current)) {
          current.status = 'unknown'; current.autoReconnect = false;
          current.message = 'Automatic reconnect was cancelled. Stop the simulation or retry manually.';
          await this.persist(); return;
        }
        if (['unknown', 'waiting'].includes(current.status)) throw new Error(current.message);
        this.confirmActive(current, result);
        await this.persist();
        const route = this.state.route;
        if (route?.status === 'paused' && route.resumeOnReconnect && route.deviceId === current.deviceId && !this.closing && !this.suspended) {
          route.resumeOnReconnect = false;
          route.status = 'running';
          route.message = `Reconnected and resumed. ${this.routeMessage(route)}`;
          this.routeStepAt = this.clock();
          this.scheduleRouteTick();
          this.notify();
        }
      } catch (error) {
        current.status = 'waiting'; current.message = `Reconnect failed: ${error.message} Roam will retry while this phone is available.`;
        this.scheduleRetry(current);
        await this.persist();
      }
    });
    this.recoveryPromise = operation;
    try { await operation; } finally { if (this.recoveryPromise === operation) this.recoveryPromise = null; }
  }
  async suspend() {
    this.suspended = true;
    if (this.state.session) await this.sessionEnded({ deviceId: this.state.session.deviceId, error: 'Computer sleep interrupted the connection.' });
  }
  async resume() { this.suspended = false; return this.scanDevices(); }
  getRoute() { return this.plannedRoute ? structuredClone(this.plannedRoute) : null; }
  routeMessage(route) {
    const verb = { walk: 'Walking', cycle: 'Cycling', drive: 'Driving' }[route?.mode] || 'Driving';
    return `${verb} at ${route?.speedMph ?? 45} mph. Sending a location every second.`;
  }
  async planRoute(input) {
    if (this.state.busy || (this.state.route && this.state.session)) throw new Error('Finish the current operation and restore real location before changing the route.');
    const { waypoints, mode, speedMph, pacing, loop } = Array.isArray(input) ? { waypoints: input } : (input || {});
    const route = await this.router.plan(waypoints, { mode, speedMph });
    if (this.state.busy || (this.state.route && this.state.session)) throw new Error('Finish the current operation and restore real location before changing the route.');
    route.mode = routeMode(route.mode || mode || 'drive');
    route.speedMph = routeSpeedMph(route.mode, speedMph ?? route.speedMph);
    route.pacing = pacing !== false;
    route.loop = Boolean(loop);
    this.plannedRoute = route;
    this.routePath = measurePath(route.coordinates);
    this.paceProfile = route.pacing ? buildPaceProfile(this.routePath, route.mode) : null;
    return this.getRoute();
  }
  async importRoute(input) {
    if (this.state.busy || (this.state.route && this.state.session)) throw new Error('Finish the current operation and restore real location before changing the route.');
    if (!input || !Array.isArray(input.coordinates)) throw new Error('Choose a GPX file with a track or route.');
    const mode = routeMode(input.mode || 'drive');
    const speedMph = routeSpeedMph(mode, input.speedMph);
    const measured = measurePath(input.coordinates.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('The GPX file contains an invalid point.');
      return [Number(pair[0]), Number(pair[1])];
    }));
    const label = typeof input.label === 'string' && input.label.trim() ? text(input.label).slice(0, 120) : 'Imported route';
    const first = measured.coordinates[0], last = measured.coordinates.at(-1);
    const route = {
      id: randomUUID(), imported: true, mode, speedMph,
      pacing: input.pacing !== false, loop: Boolean(input.loop),
      waypoints: [
        { latitude: first[1], longitude: first[0], label },
        { latitude: last[1], longitude: last[0], label: 'Route end' },
      ],
      coordinates: measured.coordinates,
      distanceMeters: measured.distanceMeters,
      durationSeconds: measured.distanceMeters / mphToMps(speedMph),
    };
    this.plannedRoute = route;
    this.routePath = measured;
    this.paceProfile = route.pacing ? buildPaceProfile(measured, mode) : null;
    return this.getRoute();
  }
  async saveRoute(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid route.');
    const name = text(input.name || '').slice(0, 80);
    if (!name) throw new Error('Name the route first.');
    const mode = routeMode(input.mode || 'drive');
    const record = {
      id: typeof input.id === 'string' && this.state.savedRoutes.some(r => r.id === input.id) ? input.id : randomUUID(),
      name, mode, speedMph: routeSpeedMph(mode, input.speedMph),
      pacing: input.pacing !== false, loop: Boolean(input.loop),
      waypoints: Array.isArray(input.waypoints) ? input.waypoints.map(p => place(p)) : [],
    };
    if (input.coordinates) {
      const measured = measurePath(input.coordinates.map(pair => [Number(pair?.[0]), Number(pair?.[1])]));
      record.coordinates = measured.coordinates;
      if (record.waypoints.length < 2) {
        record.waypoints = [
          { latitude: measured.coordinates[0][1], longitude: measured.coordinates[0][0], label: name },
          { latitude: measured.coordinates.at(-1)[1], longitude: measured.coordinates.at(-1)[0], label: 'Route end' },
        ];
      }
    }
    if (record.waypoints.length < 2 || record.waypoints.length > 12) throw new Error('A saved route needs between 2 and 12 stops.');
    if (input.id == null && this.state.savedRoutes.length >= 50) throw new Error('You can save up to 50 routes.');
    this.state.savedRoutes = [record, ...this.state.savedRoutes.filter(r => r.id !== record.id)];
    await this.persist(); this.notify(); return this.snapshot();
  }
  async deleteRoute(id) {
    this.state.savedRoutes = this.state.savedRoutes.filter(r => r.id !== id);
    await this.persist(); this.notify(); return this.snapshot();
  }
  async startSavedRoute(id, deviceId) {
    const saved = this.state.savedRoutes.find(r => r.id === id);
    if (!saved) throw new Error('That saved route no longer exists.');
    if (saved.coordinates) await this.importRoute({ coordinates: saved.coordinates, label: saved.name, mode: saved.mode, speedMph: saved.speedMph, pacing: saved.pacing, loop: saved.loop });
    else await this.planRoute({ waypoints: saved.waypoints, mode: saved.mode, speedMph: saved.speedMph, pacing: saved.pacing, loop: saved.loop });
    return this.startRoute({ deviceId, routeId: this.plannedRoute.id });
  }
  async replayRoute(id) {
    const entry = this.state.routeHistory.find(r => r.id === id);
    if (!entry) throw new Error('That route is no longer in the history.');
    if (entry.coordinates) return this.importRoute({ coordinates: entry.coordinates, label: entry.label, mode: entry.mode, speedMph: entry.speedMph, pacing: entry.pacing, loop: entry.loop });
    return this.planRoute({ waypoints: entry.waypoints, mode: entry.mode, speedMph: entry.speedMph, pacing: entry.pacing, loop: entry.loop });
  }
  async recordRouteHistory(route, completed) {
    if (!route?.waypoints?.length || !(route.distanceMeters > 0)) return;
    const entry = {
      id: randomUUID(),
      label: `${route.waypoints[0].label || 'Start'} → ${route.waypoints.at(-1).label || 'End'}`,
      mode: route.mode || 'drive', speedMph: route.speedMph ?? 45,
      pacing: route.pacing !== false, loop: Boolean(route.loop),
      waypoints: route.waypoints,
      ...(route.imported && this.plannedRoute?.id === route.id ? { coordinates: this.plannedRoute.coordinates } : {}),
      distanceMeters: route.distanceMeters,
      traveledMeters: route.traveledMeters || 0,
      completed: Boolean(completed),
      startedAt: route.startedAt || new Date(this.now()).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
    };
    this.state.routeHistory = [entry, ...this.state.routeHistory].slice(0, 20);
    await this.persist();
  }
  async startRoute({ deviceId, routeId, speedMph, pacing, loop } = {}) {
    const route = this.plannedRoute;
    if (!route || route.id !== routeId) throw new Error('Plan the route before starting.');
    if (this.state.route && this.state.session) throw new Error('Restore real location before starting another route.');
    // Speed/pacing/loop can be adjusted on the start button without
    // replanning the geometry.
    if (speedMph != null) route.speedMph = routeSpeedMph(route.mode || 'drive', speedMph);
    if (pacing != null) route.pacing = Boolean(pacing);
    if (loop != null) route.loop = Boolean(loop);
    route.durationSeconds = route.distanceMeters / mphToMps(route.speedMph ?? 45);
    this.paceProfile = route.pacing ? (this.paceProfile || buildPaceProfile(this.routePath, route.mode || 'drive')) : null;
    await this.applyLocation({ deviceId, ...pointAlong(this.routePath, 0), label: `Route to ${route.waypoints.at(-1).label}` }, route);
    if (this.closing || this.suspended || this.state.session?.status !== 'active' || this.state.route?.status !== 'starting') return this.snapshot();
    this.state.route.status = 'running';
    this.state.route.message = this.routeMessage(this.state.route);
    this.routeStepAt = this.clock();
    this.scheduleRouteTick(); this.notify(); return this.snapshot();
  }
  pauseRouteMotion(message = 'Paused. Your phone holds the last route location.', { autoResume = false } = {}) {
    clearTimeout(this.routeTimer); this.routeTimer = null;
    if (this.state.route && ['running', 'starting'].includes(this.state.route.status)) {
      this.state.route.status = 'paused'; this.state.route.message = message;
      if (autoResume) this.state.route.resumeOnReconnect = true;
      this.state.route.speedNow = 0; this.state.route.dwellMs = 0;
    }
  }
  async pauseRoute() {
    this.pauseRouteMotion();
    if (this.state.route) this.state.route.resumeOnReconnect = false;
    this.notify();
    if (this.routeUpdate) await this.routeUpdate;
    await this.persist(); this.notify(); return this.snapshot();
  }
  async resumeRoute() {
    return this.exclusive(async () => {
      const route = this.state.route, current = this.state.session;
      if (!route || route.status !== 'paused') throw new Error('There is no paused route to resume.');
      if (this.closing || this.suspended || !current || current.deviceId !== route.deviceId) throw new Error('Reconnect the original phone before resuming.');
      const device = this.device(current.deviceId);
      if (current.status !== 'active') {
        current.id = randomUUID(); current.status = 'reconnecting';
        try {
          await this.persist(); this.notify();
          await this.adapters[device.platform].reset?.(device);
          const result = await this.adapters[device.platform].set(device, { latitude: current.latitude, longitude: current.longitude, sessionId: current.id, reconnecting: true });
          if (this.closing || this.suspended || current.status !== 'reconnecting') throw new Error('The connection was interrupted.');
          this.confirmActive(current, result); await this.persist();
        } catch (error) {
          await this.sessionEnded({ deviceId: current.deviceId, sessionId: current.id, error: error.message }); throw error;
        }
      }
      route.status = 'running'; route.message = this.routeMessage(route); route.resumeOnReconnect = false;
      this.routeStepAt = this.clock(); this.scheduleRouteTick();
    });
  }
  scheduleRouteTick(delay = 1000) {
    clearTimeout(this.routeTimer);
    if (this.state.route?.status !== 'running' || this.closing) return;
    this.routeTimer = setTimeout(() => { this.routeTimer = null; this.tickRoute().catch(error => {
      this.pauseRouteMotion(error.message); this.state.warning = error.message; this.notify();
    }); }, delay);
    this.routeTimer.unref?.();
  }
  advanceRoute(route, elapsedMs) {
    const cruise = mphToMps(route.speedMph ?? 45);
    const from = route.traveledMeters;
    if (!route.pacing || !this.paceProfile) return Math.min(route.distanceMeters, from + cruise * elapsedMs / 1000);
    if (route.dwellMs > 0) {
      route.dwellMs = Math.max(0, route.dwellMs - elapsedMs);
      route.speedNow = 0;
      return from;
    }
    const dt = elapsedMs / 1000;
    const accel = route.mode === 'walk' ? 0.9 : route.mode === 'cycle' ? 1.6 : 2.4;
    const target = cruise * paceFactorAt(this.paceProfile, from);
    let speed = route.speedNow ?? 0;
    const delta = target - speed;
    const maxDelta = accel * dt;
    speed += Math.abs(delta) <= maxDelta ? delta : Math.sign(delta) * maxDelta;
    route.speedNow = speed;
    let to = from + speed * dt;
    const stop = this.paceProfile.stops.find(s => s.at > from + 0.01 && s.at <= to);
    if (stop) { to = stop.at; route.dwellMs = stop.dwellSeconds * 1000; route.speedNow = 0; }
    return Math.min(route.distanceMeters, to);
  }
  async tickRoute() {
    const route = this.state.route, current = this.state.session;
    if (this.routeUpdate || route?.status !== 'running') return;
    if (this.state.busy) { this.scheduleRouteTick(100); return; }
    if (this.suspended || this.closing || current?.status !== 'active' || current.deviceId !== route.deviceId) {
      this.pauseRouteMotion('Connection interrupted. The route resumes on its own when this phone reconnects.', { autoResume: true }); this.notify(); return;
    }
    const started = this.clock(), elapsed = started - this.routeStepAt;
    if (elapsed < 1000) { this.scheduleRouteTick(1000 - elapsed); return; }
    // Slow ticks never kill the route. A transport that needs more than a
    // second per update is normal on Wi-Fi: points simply go out at the
    // rate the phone accepts, while the position stays true to wall-clock
    // time. Travel per tick is capped so a scheduling stall cannot
    // teleport the phone, and the clock resyncs here instead of pausing.
    const advanceMs = Math.min(elapsed, 10000);
    this.routeStepAt = started;
    const operation = async () => {
      try {
        const device = this.device(current.deviceId);
        let distance = this.advanceRoute(route, advanceMs);
        if (route.loop && distance >= route.distanceMeters) {
          route.loops = (route.loops || 0) + 1;
          route.traveledMeters = 0; route.speedNow = 0; route.dwellMs = 0;
          distance = 0;
          route.message = `Looping · lap ${route.loops + 1}. ${this.routeMessage(route)}`;
        }
        const point = pointAlong(this.routePath, distance);
        // Record the attempted point before sending. Recovery holds this point;
        // it never advances the route while transport state is uncertain.
        Object.assign(current, point);
        Object.assign(route, { point, traveledMeters: distance, remainingSeconds: (route.distanceMeters - distance) / mphToMps(route.speedMph ?? 45) });
        const adapter = this.adapters[device.platform];
        const result = await (adapter.update ? adapter.update(device, { ...point, sessionId: current.id }) : adapter.set(device, { ...point, sessionId: current.id }));
        if (this.state.session !== current || current.status !== 'active' || this.closing) return;
        current.lastRefreshAt = result?.refreshedAt || new Date(this.now()).toISOString();
        current.refreshCount = (current.refreshCount || 0) + 1;
        current.refreshIntervalMs = 1000; current.refreshSource = 'command-ack';
        if (distance >= route.distanceMeters) {
          route.status = 'completed'; route.message = 'Arrived. Your phone holds the destination until you restore real location.';
          await this.recordRouteHistory(route, true);
        } else {
          // A slow update is information, not a fault: note it and keep
          // driving. The note clears when updates are fast again.
          const duration = this.clock() - started;
          if (duration >= 1000 && !route.slowTransport && distance > 0) {
            route.slowTransport = true;
            route.message = 'Connection is slow, so points go out as fast as the phone accepts them. The route keeps its pace.';
          } else if (duration < 1000 && route.slowTransport) {
            route.slowTransport = false;
            if (route.message.startsWith('Connection is slow')) route.message = this.routeMessage(route);
          }
        }
        this.notify();
      } catch (error) {
        await this.sessionEnded({ deviceId: current.deviceId, sessionId: current.id, error: `Route paused: ${error.message}` });
      }
    };
    this.routeUpdate = operation();
    try { await this.routeUpdate; } finally { this.routeUpdate = null; }
    this.scheduleRouteTick(Math.max(1, 1000 - (this.clock() - started)));
  }
  async savePlace(input) {
    const point = place(input);
    if (input.id != null && (typeof input.id !== 'string' || !this.state.savedPlaces.some(p => p.id === input.id))) throw new Error('Saved place no longer exists.');
    const record = { id: input.id || randomUUID(), ...point };
    if (!input.id && this.state.savedPlaces.length >= 100) throw new Error('You can save up to 100 places.');
    this.state.savedPlaces = [record, ...this.state.savedPlaces.filter(p => p.id !== record.id)];
    await this.persist(); this.notify(); return this.snapshot();
  }
  async deletePlace(id) {
    this.state.savedPlaces = this.state.savedPlaces.filter(p => p.id !== id);
    await this.persist(); this.notify(); return this.snapshot();
  }
  async updatePreferences(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid preferences.');
    if (input.restoreOnQuit != null) {
      if (typeof input.restoreOnQuit !== 'boolean') throw new Error('Invalid quit preference.');
      this.state.preferences.restoreOnQuit = input.restoreOnQuit;
    }
    if (input.geocoderUrl != null) this.state.preferences.geocoderUrl = geocoderUrl(text(input.geocoderUrl));
    if (input.onboardingComplete != null) {
      if (typeof input.onboardingComplete !== 'boolean') throw new Error('Invalid onboarding preference.');
      this.state.preferences.onboardingComplete = input.onboardingComplete;
    }
    if (input.hostPlatform != null) {
      if (!['mac', 'windows'].includes(input.hostPlatform)) throw new Error('Invalid computer platform.');
      this.state.preferences.hostPlatform = input.hostPlatform;
    }
    if (input.phonePlatform != null) {
      if (!['ios', 'android'].includes(input.phonePlatform)) throw new Error('Invalid phone platform.');
      this.state.preferences.phonePlatform = input.phonePlatform;
    }
    await this.persist(); this.notify(); return this.snapshot();
  }
  async dispose(options) {
    this.closing = true; this.resumeSessionId = null;
    this.pauseRouteMotion();
    if (this.routeUpdate) await this.routeUpdate.catch(() => {});
    if (this.scanning) await this.scanning.catch(() => {});
    await Promise.allSettled(Object.values(this.adapters).map(adapter => adapter.dispose(options)));
  }
}
