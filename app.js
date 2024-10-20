'use strict';

const {
  throws
} = require('assert');
const Homey = require('homey');
const fetch = require('node-fetch');
const cache = require('node-cache');

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

    this.cache = new cache({
      stdTTL: this.cachettl
    });

    this.homey.settings.on('set', async key => {
      this.log('App settings updated...')
      this.username = this.homey.settings.get('username');
      this.password = this.homey.settings.get('password');
      this.cachettl = this.homey.settings.get('cachettl');
      this.cache.stdTTL = this.cachettl;
      await this.refreshToken();
      await this.getZones();
    });

    // Let's make sure we have a fresh token.
    await this.refreshToken();

    // Get zone data into cache, so when individual devices are refreshing we won't spam the API with requests.
    await this.getZones();

    this.onPoll = this.onPoll.bind(this);
    this.timerID = this.homey.setTimeout(this.onPoll, 15000);

    this.log('App finished init');
  }

  async getZones() {
    let cached_zones = this.cache.get("Zones");
    if (cached_zones !== undefined) {
      this.log("Zone data is served from cache...")
      return cached_zones;
    }

    try {
      this.log('Getting all modules...');

      const modules = await this._call({
        method: 'get',
        path: `/users/${this.user_id}/modules`
      });

      let all_zones = [];

      for (const module of modules) {
        this.log(`Got module ${module.udid}. Scanning for zones...`);

        const response = await this._call({
          method: 'get',
          path: `/users/${this.user_id}/modules/${module.udid}`
        });

        const zones = response.zones.elements;

        for (const zone of zones) {
          // TODO: list only enabled zones
          if (zone && zone.zone.zoneState !== 'zoneOff') {
            zone.module_udid = module.udid;
            all_zones.push(zone);
          }
        }
      }

      this.cache.set("Zones", all_zones);

      return all_zones;
    } catch (err) {
      this.log(`Got error when scanning for zones: ${err.message}`);
      return null;
    }

  }

  async onPoll() {
    this.timerProcessing = true;
    this.log("!!! Polling started...");
    const promises = [];

    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver in drivers) {
        let devices = this.homey.drivers.getDriver(driver).getDevices();
        for (const device of devices) {
          if (device.__updateDevice) {
            promises.push(device.__updateDevice());
          }
        }
      }
      await Promise.all(promises);
      this.log("!!! Polling ended.");
    } catch (err) {
      this.log(`Polling error: ${err.message}`)
    }

    var nextPoll = Number(this.pollInterval * 1000);
    this.log(`Next poll in ${this.pollInterval} seconds`);
    this.timerID = this.homey.setTimeout(this.onPoll, nextPoll);
    this.timerProcessing = false;
  }


  async setZone({
    module_udid,
    mode_id,
    mode_parent_id,
    target_temperature
  }) {
    try {
      let success = this._call({
        method: 'post',
        path: `/users/${this.user_id}/modules/${module_udid}/zones`,
        json: {
          mode: {
            id: mode_id,
            parentId: mode_parent_id,
            mode: "constantTemp",
            constTempTime: 0,
            setTemperature: target_temperature * 10,
            scheduleIndex: 0
          }
        }
      })
      this.cache.del("Zones");
    } catch (err) {
      this.log(`Got error when modifying zone: ${err.message}`);
      return null;
    }
  }

  async refreshToken() {
    try {
      this.log('Refreshing eModul API token and user_id');
      await this._call({
        method: 'post',
        path: '/authentication',
        json: {
          username: this.username,
          password: this.password
        }
      }).then(response => {
        this.token = response.token
        this.user_id = response.user_id
        this.log(`Got token: ${this.token}, user_id: ${this.user_id}`);
      });
    } catch (err) {
      this.log(`Got error while refreshing token: ${err.message}`);
      return null;
    }
  }

  /*
   * API helper
   */

  async _call({
    method = 'get',
    path = '/',
    body,
    json
  }) {

    const url = `https://emodul.eu/api/v1${path}`;
    const opts = {
      method,
      headers: {}
    };

    if (this.token) {
      opts.headers['Authorization'] = `Bearer ${this.token}`;
    }

    if (body) {
      opts.body = body;
    }

    if (json) {
      opts.body = JSON.stringify(json);
      opts.headers['Content-type'] = 'application/json';
    }

    let res = await fetch(url, opts);

    if (!res.ok) {
      const err = new Error(`API error occured: response status is ${res.status}`);
      err.code = res.status;
      this.log(err);
      let authRetryCount = 1;
      while (res.status === 401 && authRetryCount <= 5) {
        this.log(`Trying to authorize again... ${authRetryCount}/5`)
        authRetryCount++;
        this.token = '';
        await this.refreshToken();
        let res = await fetch(url, opts);
      }
    }

    const resJson = await res.json();
    //this.log(url, opts);
    //this.log(resJson);

    return resJson;
  }

}

module.exports = TechApp;
