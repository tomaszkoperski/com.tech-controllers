'use strict';

const {
  throws,
} = require('assert');
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

    // Mutex for preventing race conditions between setZone and polling
    this._isWriting = false;
    this._writeQueue = [];
    this._lastZonesData = null; // Backup of last known zones data for duringChange fallback

    this.homey.settings.on('set', async key => {
      this.log('App settings updated...');
      this.username = this.homey.settings.get('username');
      this.password = this.homey.settings.get('password');
      this.cachettl = Number(this.homey.settings.get('cachettl'));
      this.cache.stdTTL = this.cachettl;
      await this.refreshToken();
      await this.getZones(true); // Force refresh
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
  }

  async getZones(forceRefresh = false) {
    // If a write operation is in progress, return cached data to avoid race conditions
    if (this._isWriting && !forceRefresh) {
      const cachedZones = this.cache.get('Zones');
      if (cachedZones) {
        this.log('Write in progress, returning cached zones');
        return cachedZones;
      }
      // If no cache but write in progress, return last known data
      if (this._lastZonesData) {
        this.log('Write in progress, no cache, returning last known zones');
        return this._lastZonesData;
      }
    }

    const cachedZones = this.cache.get('Zones');
    if (cachedZones !== undefined && !forceRefresh) {
      return cachedZones;
    }

    try {
      const modules = await this._call({
        method: 'get',
        path: `/users/${this.user_id}/modules`,
      });

      const allZones = [];
      // Use last known data for duringChange fallback (not current cache which might be empty)
      const fallbackZones = this._lastZonesData || cachedZones;

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
            } else {
              // If zone is changing, use fallback data if available
              const fallbackZone = fallbackZones?.find(
                cached => cached.zone.id === zone.zone.id && 
                         cached.module_udid === module.udid
              );
              if (fallbackZone) {
                allZones.push(fallbackZone);
                this.log(`Using fallback data for changing zone: ${zone.zone.id}`);
              } else {
                // If no fallback data available, use current (API) data
                zone.module_udid = module.udid;
                allZones.push(zone);
                this.log(`No fallback data for changing zone: ${zone.zone.id}`);
              }
            }
          }
        }
      }

      this.cache.set('Zones', allZones);
      this._lastZonesData = allZones; // Keep backup for duringChange fallback

      return allZones;
    } catch (err) {
      this.log(`Got error when scanning for zones: ${err.message}`);
      // Return last known data on error instead of null
      if (this._lastZonesData) {
        this.log('Returning last known zones data after error');
        return this._lastZonesData;
      }
      return null;
    }
  }

  async onPoll() {
    // Skip polling if a write operation is in progress
    if (this._isWriting) {
      this.log('!!! Polling skipped - write operation in progress');
      const nextPoll = Number(this.pollInterval * 1000);
      this.timerID = this.homey.setTimeout(this.onPoll, nextPoll);
      return;
    }

    this.timerProcessing = true;
    this.log('!!! Polling started...');

    try {
      // Force refresh zones from API once at the start of polling
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
            // Use new method that reads from cache only (no API calls)
            await device.__updateDeviceFromCache(zones);
          } else if (device.__updateDevice) {
            // Fallback to old method
            await device.__updateDevice();
          }
        }
      }
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
    // Set write lock to prevent race conditions with polling
    this._isWriting = true;
    
    try {
      const cachedZones = this.cache.get('Zones') || this._lastZonesData;
      let currentScheduleIndex = 0;

      if (cachedZones) {
        const zoneToUpdate = cachedZones.find(
          zone => zone.module_udid === module_udid && zone.zone.id === mode_parent_id
        );
        if (zoneToUpdate) {
          if (typeof zoneToUpdate.mode.scheduleIndex !== 'undefined') {
            currentScheduleIndex = zoneToUpdate.mode.scheduleIndex;
          }
          // Update both cache and backup
          zoneToUpdate.zone.setTemperature = target_temperature * 10;
          zoneToUpdate.mode.setTemperature = target_temperature * 10;
          this.cache.set('Zones', cachedZones);
          this._lastZonesData = cachedZones;
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

      // Reduced delay - just enough for API to process
      await this.delay(1000);

      // Don't force refresh here - trust our cache update
      // The next poll cycle will pick up any discrepancies
      
      return success;
    } catch (err) {
      this.log(`Got error when modifying zone: ${err.message}`);
      return null;
    } finally {
      // Always release the write lock
      this._isWriting = false;
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
   * 
   * Retry behavior:
   * - Auth errors (401/403): Limited retries (5), then fail
   * - Server errors (5xx): Unlimited retries with capped backoff
   * - Network errors: Unlimited retries with capped backoff
   * - Client errors (4xx): No retry, fail immediately
   * 
   * Backoff: Starts at 10s, doubles each retry, caps at 5 minutes.
   * Resets to initial value on success.
   * 
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

    const maxAuthRetries = 5;          // Limited retries for auth errors
    const initialBackoff = 10000;      // 10 seconds
    const maxBackoff = 300000;         // 5 minutes cap
    
    let authAttempt = 0;
    
    // Use instance-level backoff so it persists across calls during outage
    // but resets on success
    if (!this._currentBackoff) {
      this._currentBackoff = initialBackoff;
    }

    while (true) {
      try {
        const res = await fetch(url, opts);

        if (res.ok) {
          // Success! Reset backoff for future calls
          this._currentBackoff = initialBackoff;
          const resJson = await res.json();
          return resJson;
        }

        // Log error response for debugging
        let responseBody = '';
        try {
          responseBody = await res.text();
        } catch (e) {
          responseBody = '(unable to read response body)';
        }
        
        const err = new Error(`API error occurred: response status is ${res.status}`);
        err.code = res.status;
        this.error(`API error ${res.status} on ${method.toUpperCase()} ${path}`);
        this.error(`Response body: ${responseBody.substring(0, 500)}`);

        if (res.status === 401 || res.status === 403) {
          // Auth errors - limited retries
          if (authAttempt >= maxAuthRetries) {
            throw new Error('Max retries reached. Authorization failed.');
          }

          this.log(`Attempting to refresh token... (${authAttempt + 1}/${maxAuthRetries})`);
          this.token = '';
          const refreshed = await this.refreshToken();

          if (!refreshed) {
            throw new Error('Failed to refresh token.');
          }

          opts.headers['Authorization'] = `Bearer ${this.token}`;
          authAttempt++;
          
          await this.delay(this._currentBackoff);
          this._currentBackoff = Math.min(this._currentBackoff * 2, maxBackoff);
          continue;
          
        } else if (res.status >= 500 && res.status < 600) {
          // Server errors - unlimited retries with capped backoff
          this.log(`Server error ${res.status}. Retrying in ${this._currentBackoff / 1000}s...`);
          
          await this.delay(this._currentBackoff);
          this._currentBackoff = Math.min(this._currentBackoff * 2, maxBackoff);
          continue;
          
        } else {
          // Client errors (4xx other than auth) - do not retry
          throw err;
        }
      } catch (err) {
        // Network errors - unlimited retries with capped backoff
        if (err.code && err.code >= 400 && err.code < 500) {
          // Re-throw client errors (already handled above, but just in case)
          throw err;
        }
        
        this.log(`Network error: ${err.message}. Retrying in ${this._currentBackoff / 1000}s...`);
        
        await this.delay(this._currentBackoff);
        this._currentBackoff = Math.min(this._currentBackoff * 2, maxBackoff);
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
