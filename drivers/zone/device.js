'use strict';

const {
  Device,
} = require('homey');

class Zone extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.zone_id = this.getData().zone_id;
    this.mode_id = this.getData().mode_id;
    this.zone_parent_id = this.getData().zone_parent_id;
    this.module_udid = this.getData().module_udid;

    // Track consecutive failures for availability management
    this._failureCount = 0;
    this._maxFailures = 3;

    this.registerCapabilityListener('target_temperature', async value => {
      this.log(`→ Set ${value}°`);

      // Delegate to the app's write queue — returns immediately.
      await this.homey.app.setZone({
        module_udid: this.module_udid,
        mode_id: this.mode_id,
        mode_parent_id: this.zone_id,
        target_temperature: value,
      });
    });

    await this.__updateDevice();
    this.log('Ready');
  }

  async onAdded() {
    this.log('Added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed');
    await this.__updateDevice();
  }

  async onRenamed(name) {
    this.log(`Renamed to ${name}`);
    await this.__updateDevice();
  }

  async onDeleted() {
    this.log('Deleted');
  }

  /**
   * Update device from pre-fetched zones data (no API call).
   */
  async __updateDeviceFromCache(zones) {
    try {
      if (!zones) {
        throw new Error('No zones data');
      }

      const zone = zones.find(z => z.zone.id === this.zone_id && z.module_udid === this.module_udid);

      if (!zone) {
        throw new Error(`Zone ${this.zone_id} not found`);
      }

      this._failureCount = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Back online');
      }

      const newTarget = zone.zone.setTemperature / 10;
      const newCurrent = zone.zone.currentTemperature / 10;
      const oldTarget = await this.getCapabilityValue('target_temperature');
      const oldCurrent = await this.getCapabilityValue('measure_temperature');

      if (oldTarget !== newTarget || oldCurrent !== newCurrent) {
        this.log(`${newCurrent}° (target: ${newTarget}°)${oldTarget !== newTarget ? ` [was ${oldTarget}°]` : ''}`);
        this.homey.app.rlog(
          `🌡️ ${this.getName()}: ${newCurrent}° (target: ${newTarget}°)` +
          (oldTarget !== newTarget ? ` [was ${oldTarget}°]` : '')
        );
      }

      await this._setIfChanged('target_temperature', newTarget);
      await this._setIfChanged('measure_temperature', newCurrent);
      await this._setIfChanged('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this._failureCount++;
      if (this._failureCount >= this._maxFailures) {
        if (this.getAvailable()) {
          await this.setUnavailable('Connection lost');
          this.error(`Unavailable: ${err.message}`);
        }
      }
    }
  }

  /**
   * Update device by fetching zones from API.
   */
  async __updateDevice() {
    try {
      const zones = await this.homey.app.getZones();

      if (!zones) {
        throw new Error('API returned null');
      }

      const zone = zones.find(z => z.zone.id === this.zone_id && z.module_udid === this.module_udid);

      if (!zone) {
        throw new Error(`Zone ${this.zone_id} not found`);
      }

      this._failureCount = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Back online');
      }

      await this._setIfChanged('target_temperature', zone.zone.setTemperature / 10);
      await this._setIfChanged('measure_temperature', zone.zone.currentTemperature / 10);
      await this._setIfChanged('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this._failureCount++;
      if (this._failureCount >= this._maxFailures) {
        if (this.getAvailable()) {
          await this.setUnavailable('Connection lost');
          this.error(`Unavailable: ${err.message}`);
        }
      }
    }
  }

  async _setIfChanged(capability, value) {
    try {
      const current = await this.getCapabilityValue(capability);
      if (current !== value) {
        await this.setCapabilityValue(capability, value);
      }
    } catch (err) {
      this.error(`${capability}: ${err.message}`);
    }
  }

}

module.exports = Zone;
