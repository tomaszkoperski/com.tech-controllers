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
    this.cachettl = this.homey.settings.get('cachettl');
    this.pollInterval = this.homey.settings.get('cachettl');

    if (typeof this.username === 'undefined') {
      this.log('eModul credentials are missing!');
      return;
    }

    if (this.cachettl < 60 || this.pollInterval < 60) {
      this.homey.settings.set('cachettl', 60);
      this.cachettl = 60;
      this.pollInterval = 60;
    }

    this.cache = new Cache({
      stdTTL: this.cachettl,
    });

    this.homey.settings.on('set', async key => {
      this.log('App settings updated...');
      this.username = this.homey.settings.get('username');
      this.password = this.homey.settings.get('password');
      this.cachettl = this.homey.settings.get('cachettl');
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
    this.timerID = this.homey.setTimeout(this.onPoll, 15000);

    this.log('App finished init');
  }

  async getZones() {
    const cachedZones = this.cache.get('Zones');
    if (cachedZones !== undefined) {
      this.log('Zone data is served from cache...');
      return cachedZones;
    }

    try {
      this.log('Getting all modules...');

      const modules = await this._call({
        method: 'get',
        path: `/users/${this.user_id}/modules`,
      });

      const allZones = [];

      for (const module of modules) {
        this.log(`Got module ${module.udid}. Scanning for zones...`);

        const response = await this._call({
          method: 'get',
          path: `/users/${this.user_id}/modules/${module.udid}`,
        });

        const zones = response.zones.elements;

        for (const zone of zones) {
          if (zone && zone.zone.zoneState !== 'zoneOff') {
            zone.module_udid = module.udid;
            allZones.push(zone);
            // this.log(`Got zone data from API: ${JSON.stringify(zone)}`);
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
            promises.push(device.__updateDevice());
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
            scheduleIndex: 0,
          },
        },
      });
      this.cache.del('Zones');
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

    // this.log(`API URL: ${url}`);
    // this.log(`API request: ${JSON.stringify(opts)}`);

    const maxRetries = 5;
    let attempt = 0;
    let backoffDelay = 10000; // Start with 10 seconds

    while (attempt <= maxRetries) {
      try {
        const res = await fetch(url, opts);

        if (res.ok) {
          const resJson = await res.json();
          return resJson;
        }

        const err = new Error(`API error occurred: response status is ${res.status}`);
        err.code = res.status;
        this.log(err);

        if (res.status === 401 || res.status === 403) {
          if (attempt === maxRetries) {
            throw new Error('Max retries reached. Authorization failed.');
          }

          this.log(`Attempting to refresh token... (${attempt + 1}/${maxRetries})`);
          this.token = '';
          const refreshed = await this.refreshToken();

          if (!refreshed) {
            throw new Error('Failed to refresh token.');
          }

          // Update the Authorization header with the new token
          opts.headers['Authorization'] = `Bearer ${this.token}`;

          // Wait before retrying
          await this.delay(backoffDelay);
          backoffDelay *= 2; // Exponential backoff
          attempt++;
          continue;
        } else if (res.status >= 500 && res.status < 600) {
          // Server errors, retry
          if (attempt === maxRetries) {
            throw new Error(`Max retries reached. Server error: ${res.status}`);
          }

          this.log(`Server error encountered. Retrying indefinitely. Next retry in ${backoffDelay / 1000} seconds... (${attempt + 1}/${maxRetries})`);
          await this.delay(backoffDelay);
          backoffDelay *= 2; // Exponential backoff
          continue;
        } else {
          // Other errors, do not retry
          throw err;
        }
      } catch (err) {
        this.log(`Error during API call: ${err.message}`);
        if (attempt === maxRetries) {
          throw err;
        }
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
