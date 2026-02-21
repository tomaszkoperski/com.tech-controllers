'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const Cache = require('node-cache');

class TechApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('App is starting init');

    this.username = this.homey.settings.get('username');
    this.password = this.homey.settings.get('password');
    this.cachettl = Number(this.homey.settings.get('cachettl'));
    this.pollInterval = Number(this.homey.settings.get('cachettl')) + 1;

    if (typeof this.username === 'undefined') {
      this.log('eModul credentials are missing!');
      return;
    }

    if (this.cachettl < 60 || this.pollInterval < 61) {
      this.homey.settings.set('cachettl', 60);
      this.cachettl = 60;
      this.pollInterval = 61;
    }

    this.cache = new Cache({
      stdTTL: this.cachettl,
    });

    this.homey.settings.on('set', async key => {
      this.log('App settings updated...');
      this.username = this.homey.settings.get('username');
      this.password = this.homey.settings.get('password');
      this.cachettl = Number(this.homey.settings.get('cachettl'));
      this.cache.stdTTL = this.cachettl;
      await this.refreshToken();
      await this.getZones();
    });

    // Let's make sure we have a fresh token.
    await this.refreshToken();

    // Wait for devices to be ready
    await this.waitForDevicesReady();

    // Get zone data into cache, so when individual devices are refreshing we won't spam the API with requests.
    await this.getZones();

    this.onPoll = this.onPoll.bind(this);
    this.timerID = this.homey.setTimeout(this.onPoll, 10000);

    this.log('App finished init');
  }

  async getZones() {
    const cachedZones = this.cache.get('Zones');
    if (cachedZones !== undefined) {
      return cachedZones;
    }

    try {
      const modules = await this._call({
        method: 'get',
        path: `/users/${this.user_id}/modules`,
      });

      const allZones = [];

      for (const module of modules) {
        this.log(`Got module ${module.udid} (${module.name}). Scanning for zone changes...`);

        const response = await this._call({
          method: 'get',
          path: `/users/${this.user_id}/modules/${module.udid}`,
        });

        const zones = response.zones.elements;

        for (const zone of zones) {
          if (zone && zone.zone.zoneState !== 'zoneOff') {
            // Skip updating cache if zone is currently changing
            if (!zone.zone.duringChange) {
              zone.module_udid = module.udid;
              allZones.push(zone);
              // this.log(`Got zone data from API: ${JSON.stringify(zone.zone)}`);
            } else {
              // If zone is changing, use cached data if available
              const cachedZone = cachedZones?.find(
                cached => cached.zone.id === zone.zone.id && 
                         cached.module_udid === module.udid
              );
              if (cachedZone) {
                allZones.push(cachedZone);
                this.log(`Using cached data for changing zone: ${zone.zone.id}`);
              } else {
                // If no cached data available, use current (API) data
                zone.module_udid = module.udid;
                allZones.push(zone);
                this.log(`No cached data for changing zone: ${zone.zone.id}`);
              }
            }
          }
        }
      }

      this.cache.set('Zones', allZones);
      // this.log(`Got zone data from API: ${JSON.stringify(allZones)}`);

      return allZones;
    } catch (err) {
      this.log(`Got error when scanning for zones: ${err.message}`);
      return null;
    }
  }

  async onPoll() {
    this.timerProcessing = true;
    this.log('!!! Polling started...');
    const promises = [];

    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        const devices = driver.getDevices();
        for (const device of devices) {
          if (device.__updateDevice) {
            promises.push(await device.__updateDevice());
          }
        }
      }
      await Promise.all(promises);
      this.log('!!! Polling ended.');
    } catch (err) {
      this.log(`Polling error: ${err.message}`);
    }

    const nextPoll = Number(this.pollInterval * 1000);
    this.log(`Next poll in ${this.pollInterval} seconds`);
    this.timerID = this.homey.setTimeout(this.onPoll, nextPoll);
    this.timerProcessing = false;
  }

  async setZone({
    module_udid,
    mode_id,
    mode_parent_id,
    target_temperature,
  }) {
    try {
      const cachedZones = this.cache.get('Zones');
      let currentScheduleIndex = 0;

      if (cachedZones) {
        const zoneToUpdate = cachedZones.find(
          zone => zone.module_udid === module_udid && zone.zone.id === mode_parent_id
        );
        if (zoneToUpdate) {
          if (typeof zoneToUpdate.mode.scheduleIndex !== 'undefined') {
            currentScheduleIndex = zoneToUpdate.mode.scheduleIndex;
          }
          zoneToUpdate.zone.setTemperature = target_temperature * 10;
          zoneToUpdate.mode.setTemperature = target_temperature * 10;
          this.cache.set('Zones', cachedZones);
          this.log(`Updated cached temperature for zone ${mode_parent_id} (${zoneToUpdate.description.name}) to ${target_temperature}`);
        }
      }

      const success = await this._call({
        method: 'post',
        path: `/users/${this.user_id}/modules/${module_udid}/zones`,
        json: {
          mode: {
            id: mode_id,
            parentId: mode_parent_id,
            mode: 'constantTemp',
            constTempTime: 0,
            setTemperature: target_temperature * 10,
            scheduleIndex: currentScheduleIndex,
          },
        },
      });
      // No delay — cache is already updated, next poll will reconcile
      return success;
    } catch (err) {
      this.log(`Got error when modifying zone: ${err.message}`);
      return null;
    }
  }

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
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds before retrying
        retryCount++;
      }
    }

    if (!allReady) {
      this.log('Warning: Some drivers or devices may not be ready.');
    } else {
      this.log('All drivers and devices are ready.');
    }
  }

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

  /**
   * API helper method to make HTTP requests with retry and backoff logic.
   * @param {Object} params - The request parameters.
   * @param {string} params.method - HTTP method (e.g., 'get', 'post').
   * @param {string} params.path - API endpoint path.
   * @param {Object} [params.body] - Request body as a string.
   * @param {Object} [params.json] - Request body as a JSON object.
   * @returns {Object} - The JSON response from the API.
   */
  async _call({ method = 'get', path = '/', body, json }) {
    const url = `https://emodul.eu/api/v1${path}`;
    const opts = {
      method: method.toUpperCase(),
      headers: {},
      timeout: 15000, // 15 second timeout for node-fetch
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

    const maxRetries = 3;
    let attempt = 0;
    let backoffDelay = 5000; // Start with 5 seconds
    const maxBackoff = 30000; // Cap at 30 seconds

    while (attempt <= maxRetries) {
      try {
        this.log(`[API] → ${opts.method} ${path} (attempt ${attempt + 1}/${maxRetries + 1})`);
        const startTime = Date.now();
        const res = await fetch(url, opts);
        const elapsed = Date.now() - startTime;

        if (res.ok) {
          this.log(`[API] ← ${res.status} OK (${elapsed}ms)`);
          const resJson = await res.json();
          return resJson;
        }

        // Log error details
        let responseBody = '';
        try {
          responseBody = await res.text();
        } catch (e) {
          responseBody = '(unreadable)';
        }
        this.error(`[API] ← ${res.status} on ${opts.method} ${path} (${elapsed}ms): ${responseBody.substring(0, 200)}`);

        if (res.status === 401 || res.status === 403) {
          if (attempt >= maxRetries) {
            throw new Error(`Authorization failed after ${maxRetries + 1} attempts`);
          }

          this.log(`[API] Refreshing token... (attempt ${attempt + 1}/${maxRetries + 1})`);
          this.token = '';
          const refreshed = await this.refreshToken();

          if (!refreshed) {
            throw new Error('Failed to refresh token');
          }

          opts.headers['Authorization'] = `Bearer ${this.token}`;
          await this.delay(backoffDelay);
          backoffDelay = Math.min(backoffDelay * 2, maxBackoff);
          attempt++;
          continue;
        } else if (res.status >= 500 && res.status < 600) {
          if (attempt >= maxRetries) {
            throw new Error(`Server error ${res.status} after ${maxRetries + 1} attempts`);
          }

          this.log(`[API] Server error ${res.status}. Retrying in ${backoffDelay / 1000}s...`);
          await this.delay(backoffDelay);
          backoffDelay = Math.min(backoffDelay * 2, maxBackoff);
          attempt++;
          continue;
        } else {
          throw new Error(`API error: HTTP ${res.status}`);
        }
      } catch (err) {
        if (err.type === 'request-timeout' || err.name === 'AbortError') {
          this.error(`[API] Timeout on ${opts.method} ${path}`);
        }
        if (attempt >= maxRetries) {
          throw err;
        }
        this.log(`[API] Error: ${err.message}. Retrying in ${backoffDelay / 1000}s...`);
        await this.delay(backoffDelay);
        backoffDelay = Math.min(backoffDelay * 2, maxBackoff);
        attempt++;
      }
    }
  }

  /**
   * Delay helper method.
   * @param {number} ms - Milliseconds to delay.
   * @returns {Promise} - Resolves after the specified delay.
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}

module.exports = TechApp;
