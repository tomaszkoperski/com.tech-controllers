'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const Cache = require('node-cache');
const consolere = require('console-remote-client');

class TechApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('App is starting init');

    this.username = this.homey.settings.get('username');
    this.password = this.homey.settings.get('password');
    this.cachettl = Number(this.homey.settings.get('cachettl')) || 60;
    this.pollInterval = this.cachettl + 1;

    if (typeof this.username === 'undefined') {
      this.log('eModul credentials are missing!');
      return;
    }

    // Enforce minimum 1s (recommended: 30s+)
    if (this.cachettl < 1) {
      this.cachettl = 1;
      this.pollInterval = 2;
    }

    this.cache = new Cache({
      stdTTL: this.cachettl,
    });

    // Write queue: per-module serialized writes
    // Key: module_udid, Value: { pending: Map<zone_id, writeRequest>, processing: boolean }
    this._writeQueues = {};
    this._lastZonesData = null;
    this._moduleOnline = {}; // Track module connectivity: module_udid -> boolean

    // API backoff state (shared across all calls)
    this._currentBackoff = 10000; // 10s initial

    // console.re remote logging
    this._initConsoleRe();

    this.homey.settings.on('set', async key => {
      this.log(`App setting changed: ${key}`);

      if (key === 'username' || key === 'password') {
        this.username = this.homey.settings.get('username');
        this.password = this.homey.settings.get('password');
        await this.refreshToken();
        await this.getZones(true);
      }

      if (key === 'cachettl') {
        const newTTL = Math.max(1, Number(this.homey.settings.get('cachettl')) || 60);
        this.cachettl = newTTL;
        this.pollInterval = newTTL + 1;
        this.cache.options.stdTTL = newTTL;
        this.log(`Polling interval updated to ${this.pollInterval}s (TTL: ${newTTL}s)`);
        this._restartPolling();
      }

      if (key === 'consolere_enabled' || key === 'consolere_channel') {
        this._initConsoleRe();
      }
    });

    // Let's make sure we have a fresh token.
    await this.refreshToken();

    // Wait for devices to be ready
    await this.waitForDevicesReady();

    // Get zone data into cache, so when individual devices are refreshing we won't spam the API with requests.
    await this.getZones(true); // Force initial fetch

    this.onPoll = this.onPoll.bind(this);
    this.timerID = this.homey.setTimeout(this.onPoll, 10000);

    this.log('App finished init');
    this.rlog('App initialized. Polling interval:', this.pollInterval, 's');
  }

  // ──────────────────────────────────────────────────────────────
  // console.re remote logging
  // ──────────────────────────────────────────────────────────────

  _initConsoleRe() {
    const enabled = this.homey.settings.get('consolere_enabled') === true;
    const channel = this.homey.settings.get('consolere_channel');

    if (enabled && channel) {
      consolere.connect({
        channel: channel,
        server: 'https://console.re',
      });
      this._consoleReEnabled = true;
      this.log(`[ConsoleRe] Connected to channel: ${channel}`);
    } else {
      this._consoleReEnabled = false;
    }
  }

  /**
   * Send a log message to console.re (if enabled).
   * Call this alongside this.log() for important events.
   */
  rlog(...args) {
    if (this._consoleReEnabled) {
      try {
        console.re.log('[TechApp]', ...args);
      } catch (e) {
        // Silently ignore console.re errors
      }
    }
  }

  /**
   * Send an error message to console.re (if enabled).
   */
  rerror(...args) {
    if (this._consoleReEnabled) {
      try {
        console.re.error('[TechApp]', ...args);
      } catch (e) {
        // Silently ignore console.re errors
      }
    }
  }

  _restartPolling() {
    if (this.timerID) {
      this.homey.clearTimeout(this.timerID);
    }
    this.log(`Restarting polling with interval ${this.pollInterval}s`);
    this.timerID = this.homey.setTimeout(this.onPoll, 1000);
  }

  // ──────────────────────────────────────────────────────────────
  // Write Queue — serialized per-module, deduplicating by zone
  // ──────────────────────────────────────────────────────────────

  /**
   * Returns the write queue for a module, creating it if needed.
   */
  _getWriteQueue(module_udid) {
    if (!this._writeQueues[module_udid]) {
      this._writeQueues[module_udid] = {
        pending: new Map(), // zone_id -> { module_udid, mode_id, mode_parent_id, target_temperature, timestamp }
        processing: false,
      };
    }
    return this._writeQueues[module_udid];
  }

  /**
   * Check if any module has pending or in-progress writes.
   */
  _isAnyWriteInProgress() {
    for (const q of Object.values(this._writeQueues)) {
      if (q.processing || q.pending.size > 0) return true;
    }
    return false;
  }

  /**
   * Check if a specific zone has duringChange=true in cached data.
   */
  _isZoneChanging(module_udid, zone_id) {
    const zones = this._lastZonesData;
    if (!zones) return false;
    const zone = zones.find(z => z.zone.id === zone_id && z.module_udid === module_udid);
    return zone?.zone?.duringChange === true;
  }

  /**
   * Enqueue a zone write. Replaces any previous pending write for the same zone.
   * The queue processor will send only the latest value.
   */
  enqueueWrite({ module_udid, mode_id, mode_parent_id, target_temperature }) {
    const queue = this._getWriteQueue(module_udid);

    // Always replace — latest value wins
    queue.pending.set(mode_parent_id, {
      module_udid,
      mode_id,
      mode_parent_id,
      target_temperature,
      timestamp: Date.now(),
    });

    this.log(`[WriteQueue] Enqueued zone ${mode_parent_id} → ${target_temperature}° (module ${module_udid.substring(0, 8)}…, queue size: ${queue.pending.size})`);
    this.rlog(`📝 Enqueued zone ${mode_parent_id} → ${target_temperature}° (queue: ${queue.pending.size})`);

    // Update cache immediately so Homey UI reflects the change
    this._updateCachedTemperature(module_udid, mode_parent_id, target_temperature);

    // Kick off processing if not already running
    if (!queue.processing) {
      this._processWriteQueue(module_udid);
    }
  }

  /**
   * Process the write queue for a module. Sends one write at a time.
   * Waits for duringChange to clear before sending the next one.
   */
  async _processWriteQueue(module_udid) {
    const queue = this._getWriteQueue(module_udid);
    if (queue.processing) return;
    queue.processing = true;

    this.log(`[WriteQueue] Processing started for module ${module_udid.substring(0, 8)}…`);

    try {
      while (queue.pending.size > 0) {
        // Check if module is known to be offline
        if (this._moduleOnline[module_udid] === false) {
          this.log(`[WriteQueue] Module ${module_udid.substring(0, 8)}… is offline. Waiting for recovery before writing...`);
          // Wait up to 5 minutes, checking every 30s
          const offlineDeadline = Date.now() + 5 * 60 * 1000;
          let recovered = false;
          while (Date.now() < offlineDeadline && queue.pending.size > 0) {
            await this.delay(30000);
            // Try a lightweight check — just GET the module
            try {
              await this._call({
                method: 'get',
                path: `/users/${this.user_id}/modules/${module_udid}`,
                maxRetries: 1,
              });
              this._moduleOnline[module_udid] = true;
              recovered = true;
              this.log(`[WriteQueue] Module ${module_udid.substring(0, 8)}… is back online!`);
              this.rlog(`🟢 Module ${module_udid.substring(0, 8)}… is back online!`);
              break;
            } catch (err) {
              this.log(`[WriteQueue] Module still offline: ${err.message}`);
            }
          }
          if (!recovered) {
            this.log(`[WriteQueue] Module ${module_udid.substring(0, 8)}… still offline after 5 min. Writes remain queued for next poll cycle.`);
            break; // Exit loop, writes stay in queue
          }
        }

        // Pick the next write (oldest first, but since we dedup by zone, order is just insertion)
        const [zone_id, writeReq] = queue.pending.entries().next().value;

        // Wait for duringChange to clear (max 60s)
        let changingWait = 0;
        while (this._isZoneChanging(module_udid, zone_id) && changingWait < 60000) {
          this.log(`[WriteQueue] Zone ${zone_id} has duringChange=true. Waiting...`);
          await this.delay(5000);
          changingWait += 5000;
          // Refresh zone data to check again
          await this.getZones(true);
        }

        if (this._isZoneChanging(module_udid, zone_id)) {
          this.log(`[WriteQueue] Zone ${zone_id} still changing after 60s. Proceeding anyway.`);
        }

        // Check if this write was superseded while we waited
        const currentWrite = queue.pending.get(zone_id);
        if (!currentWrite || currentWrite.timestamp !== writeReq.timestamp) {
          this.log(`[WriteQueue] Zone ${zone_id} write was superseded. Skipping stale value.`);
          continue;
        }

        // Remove from pending before attempting (we'll re-queue on failure)
        queue.pending.delete(zone_id);

        // Get current scheduleIndex from cache
        let currentScheduleIndex = 0;
        const cachedZones = this.cache.get('Zones') || this._lastZonesData;
        if (cachedZones) {
          const zoneData = cachedZones.find(
            z => z.module_udid === module_udid && z.zone.id === zone_id
          );
          if (zoneData?.mode?.scheduleIndex !== undefined) {
            currentScheduleIndex = zoneData.mode.scheduleIndex;
          }
        }

        // Attempt the write — single attempt, no infinite retry in _call
        try {
          this.log(`[WriteQueue] Writing zone ${zone_id} → ${writeReq.target_temperature}°`);
          await this._call({
            method: 'post',
            path: `/users/${this.user_id}/modules/${module_udid}/zones`,
            json: {
              mode: {
                id: writeReq.mode_id,
                parentId: writeReq.mode_parent_id,
                mode: 'constantTemp',
                constTempTime: 0,
                setTemperature: writeReq.target_temperature * 10,
                scheduleIndex: currentScheduleIndex,
              },
            },
            maxRetries: 3, // Limited retries per write attempt
          });

          this.log(`[WriteQueue] ✓ Zone ${zone_id} set to ${writeReq.target_temperature}°`);
          this.rlog(`✅ Zone ${zone_id} set to ${writeReq.target_temperature}°`);
          this._moduleOnline[module_udid] = true;

          // Small delay between writes to the same module
          await this.delay(2000);
        } catch (err) {
          this.error(`[WriteQueue] ✗ Failed zone ${zone_id}: ${err.message}`);
          this.rerror(`❌ Failed zone ${zone_id}: ${err.message}`);

          // If module is offline (503), mark it and stop processing
          if (err.moduleOffline) {
            this._moduleOnline[module_udid] = false;
            // Re-queue this write
            queue.pending.set(zone_id, writeReq);
            this.log(`[WriteQueue] Module offline. Re-queued zone ${zone_id}. Will retry on next poll.`);
            this.rerror(`🔌 Module ${module_udid.substring(0, 8)}… offline. Queued writes paused.`);
            break;
          }

          // For other errors, re-queue if within 15 min of original request
          if (Date.now() - writeReq.timestamp < 15 * 60 * 1000) {
            queue.pending.set(zone_id, writeReq);
            this.log(`[WriteQueue] Re-queued zone ${zone_id} for retry.`);
            await this.delay(10000);
          } else {
            this.error(`[WriteQueue] Giving up on zone ${zone_id} → ${writeReq.target_temperature}° (15 min timeout)`);
          }
        }
      }
    } finally {
      queue.processing = false;
      this.log(`[WriteQueue] Processing ended for module ${module_udid.substring(0, 8)}… (${queue.pending.size} pending)`);
    }
  }

  /**
   * Retry pending writes for all modules. Called after successful polls.
   */
  retryPendingWrites() {
    for (const [module_udid, queue] of Object.entries(this._writeQueues)) {
      if (queue.pending.size > 0 && !queue.processing && this._moduleOnline[module_udid] !== false) {
        this.log(`[WriteQueue] Retrying ${queue.pending.size} pending writes for module ${module_udid.substring(0, 8)}…`);
        this._processWriteQueue(module_udid);
      }
    }
  }

  /**
   * Update the cached temperature for a zone (for immediate UI feedback).
   */
  _updateCachedTemperature(module_udid, zone_id, target_temperature) {
    const cachedZones = this.cache.get('Zones') || this._lastZonesData;
    if (!cachedZones) return;

    const zoneData = cachedZones.find(
      z => z.module_udid === module_udid && z.zone.id === zone_id
    );
    if (zoneData) {
      zoneData.zone.setTemperature = target_temperature * 10;
      zoneData.mode.setTemperature = target_temperature * 10;
      this.cache.set('Zones', cachedZones);
      this._lastZonesData = cachedZones;
      this.log(`Updated cached temperature for zone ${zone_id} (${zoneData.description?.name || 'unknown'}) to ${target_temperature}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Zone fetching
  // ──────────────────────────────────────────────────────────────

  async getZones(forceRefresh = false) {
    const cachedZones = this.cache.get('Zones');
    if (cachedZones !== undefined && !forceRefresh) {
      return cachedZones;
    }

    try {
      const modules = await this._call({
        method: 'get',
        path: `/users/${this.user_id}/modules`,
        maxRetries: 3,
      });

      const allZones = [];
      const fallbackZones = this._lastZonesData || cachedZones;

      for (const module of modules) {
        this.log(`Got module ${module.udid} (${module.name}). Scanning for zone changes...`);

        const response = await this._call({
          method: 'get',
          path: `/users/${this.user_id}/modules/${module.udid}`,
          maxRetries: 3,
        });

        // Module responded — mark as online
        this._moduleOnline[module.udid] = true;

        const zones = response.zones.elements;

        for (const zone of zones) {
          if (zone && zone.zone.zoneState !== 'zoneOff') {
            zone.module_udid = module.udid;

            if (zone.zone.duringChange) {
              // Zone is currently applying a change — use fallback data to avoid
              // overwriting Homey's UI with stale mid-transition values
              const fallbackZone = fallbackZones?.find(
                cached => cached.zone.id === zone.zone.id &&
                         cached.module_udid === module.udid
              );
              if (fallbackZone) {
                allZones.push(fallbackZone);
                this.log(`Zone ${zone.zone.id} has duringChange=true. Using cached data.`);
                this.rlog(`⏳ Zone ${zone.zone.id} duringChange=true, using cache`);
              } else {
                allZones.push(zone);
                this.log(`Zone ${zone.zone.id} has duringChange=true but no fallback. Using API data.`);
              }
            } else {
              allZones.push(zone);
            }
          }
        }
      }

      this.cache.set('Zones', allZones);
      this._lastZonesData = allZones;

      return allZones;
    } catch (err) {
      this.log(`Got error when scanning for zones: ${err.message}`);
      if (err.moduleOffline) {
        // Extract module_udid from error if available
        this.log('A module appears to be offline.');
      }
      if (this._lastZonesData) {
        this.log('Returning last known zones data after error');
        return this._lastZonesData;
      }
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Polling
  // ──────────────────────────────────────────────────────────────

  async onPoll() {
    this.timerProcessing = true;
    this.log('!!! Polling started...');

    try {
      const zones = await this.getZones(true);

      if (!zones) {
        this.log('!!! Polling aborted - no zones data');
        return;
      }

      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        const devices = driver.getDevices();
        for (const device of devices) {
          if (device.__updateDeviceFromCache) {
            await device.__updateDeviceFromCache(zones);
          } else if (device.__updateDevice) {
            await device.__updateDevice();
          }
        }
      }
      this.log('!!! Polling ended.');

      // After a successful poll, retry any pending writes
      // (modules may have come back online)
      this.retryPendingWrites();
    } catch (err) {
      this.log(`Polling error: ${err.message}`);
    }

    const nextPoll = Number(this.pollInterval * 1000);
    this.log(`Next poll in ${this.pollInterval} seconds`);
    this.timerID = this.homey.setTimeout(this.onPoll, nextPoll);
    this.timerProcessing = false;
  }

  // ──────────────────────────────────────────────────────────────
  // setZone — now delegates to write queue
  // ──────────────────────────────────────────────────────────────

  async setZone({ module_udid, mode_id, mode_parent_id, target_temperature }) {
    this.enqueueWrite({ module_udid, mode_id, mode_parent_id, target_temperature });
    // Return immediately — the queue processes asynchronously.
    // The caller (device.js) doesn't need to wait for the API call.
    return true;
  }

  // ──────────────────────────────────────────────────────────────
  // Device readiness
  // ──────────────────────────────────────────────────────────────

  async waitForDevicesReady() {
    this.log('Waiting for drivers and devices to be ready...');
    const maxRetries = 10;
    let retryCount = 0;
    let allReady = false;

    while (!allReady && retryCount < maxRetries) {
      allReady = true;
      const drivers = this.homey.drivers.getDrivers();
      const readinessPromises = [];

      for (const driver of Object.values(drivers)) {
        readinessPromises.push(driver.read());
        const devices = driver.getDevices();
        for (const device of devices) {
          readinessPromises.push(device.ready());
        }
      }

      try {
        await Promise.all(readinessPromises);
      } catch (err) {
        this.log(`Error waiting for drivers or devices: ${err.message}`);
        allReady = false;
      }

      if (!allReady) {
        this.log(`Drivers or devices not ready, retrying... (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        retryCount++;
      }
    }

    if (!allReady) {
      this.log('Warning: Some drivers or devices may not be ready.');
    } else {
      this.log('All drivers and devices are ready.');
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Auth
  // ──────────────────────────────────────────────────────────────

  async refreshToken() {
    try {
      this.log('Refreshing eModul API token and user_id');
      const response = await this._call({
        method: 'post',
        path: '/authentication',
        json: {
          username: this.username,
          password: this.password,
        },
        maxRetries: 5,
      });

      this.token = response.token;
      this.user_id = response.user_id;
      this.log(`Got token! user_id: ${this.user_id}`);
      return true;
    } catch (err) {
      this.log(`Got error while refreshing token: ${err.message}`);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // API client — bounded retries, no infinite loops
  // ──────────────────────────────────────────────────────────────

  /**
   * API helper method with bounded retry logic.
   *
   * @param {Object} params
   * @param {string} params.method - HTTP method
   * @param {string} params.path - API endpoint path
   * @param {Object} [params.json] - Request body as JSON
   * @param {Object} [params.body] - Request body as string
   * @param {number} [params.maxRetries=3] - Max retry attempts
   * @returns {Object} JSON response
   * @throws {Error} with .moduleOffline=true if 503 "No module connection"
   */
  async _call({ method = 'get', path = '/', body, json, maxRetries = 3 }) {
    const url = `https://emodul.eu/api/v1${path}`;
    const opts = {
      method: method.toUpperCase(),
      headers: {},
      timeout: 15000,
    };

    if (this.token) {
      opts.headers['Authorization'] = `Bearer ${this.token}`;
    }

    if (body) {
      opts.body = body;
    }

    if (json) {
      opts.body = JSON.stringify(json);
      opts.headers['Content-Type'] = 'application/json';
    }

    const initialBackoff = 5000;   // 5s
    const maxBackoff = 60000;      // 1 min cap
    let backoff = initialBackoff;
    let attempt = 0;
    let authRetries = 0;
    const maxAuthRetries = 3;

    while (attempt <= maxRetries) {
      try {
        this.log(`[API] → ${method.toUpperCase()} ${path}`);
        const startTime = Date.now();
        const res = await fetch(url, opts);
        const elapsed = Date.now() - startTime;

        if (res.ok) {
          this.log(`[API] ← ${res.status} OK (${elapsed}ms)`);
          return await res.json();
        }

        // Read error response
        let responseBody = '';
        try {
          responseBody = await res.text();
        } catch (e) {
          responseBody = '(unable to read response body)';
        }

        this.error(`[API] ← ${res.status} on ${method.toUpperCase()} ${path} (${elapsed}ms)`);
        this.error(`[API] Response: ${responseBody.substring(0, 500)}`);

        // 503 with "No module connection" — don't retry, signal to caller
        if (res.status === 503 && responseBody.includes('No module connection')) {
          const err = new Error(`Module offline (503): ${responseBody.substring(0, 200)}`);
          err.code = 503;
          err.moduleOffline = true;
          this.rerror(`🔌 503 Module offline: ${method.toUpperCase()} ${path}`);
          throw err;
        }

        // Auth errors — try refreshing token
        if ((res.status === 401 || res.status === 403) && authRetries < maxAuthRetries) {
          authRetries++;
          this.log(`Auth error. Refreshing token... (${authRetries}/${maxAuthRetries})`);
          this.token = '';
          const refreshed = await this.refreshToken();
          if (refreshed) {
            opts.headers['Authorization'] = `Bearer ${this.token}`;
            continue; // Don't count as regular retry
          }
        }

        // Server errors (5xx) — retry with backoff
        if (res.status >= 500 && res.status < 600) {
          attempt++;
          if (attempt <= maxRetries) {
            this.log(`Server error ${res.status}. Retry ${attempt}/${maxRetries} in ${backoff / 1000}s...`);
            await this.delay(backoff);
            backoff = Math.min(backoff * 2, maxBackoff);
            continue;
          }
        }

        // Client errors or max retries exceeded
        const err = new Error(`API error: ${res.status} on ${method.toUpperCase()} ${path}`);
        err.code = res.status;
        throw err;

      } catch (err) {
        // Re-throw known errors (module offline, client errors)
        if (err.moduleOffline || (err.code && err.code >= 400 && err.code < 500)) {
          throw err;
        }

        // Network/timeout errors
        attempt++;
        if (attempt <= maxRetries) {
          if (err.type === 'request-timeout' || err.name === 'AbortError') {
            this.error(`[API] Timeout on ${method.toUpperCase()} ${path}`);
          }
          this.log(`[API] Network error: ${err.message}. Retry ${attempt}/${maxRetries} in ${backoff / 1000}s...`);
          await this.delay(backoff);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }

        throw err;
      }
    }

    throw new Error(`Max retries (${maxRetries}) exceeded for ${method.toUpperCase()} ${path}`);
  }

  /**
   * Delay helper method.
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}

module.exports = TechApp;
