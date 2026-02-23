'use strict';

const {
  Device,
} = require('homey');

class Zone extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Zone initialising');

    this.log(`name: ${this.getName()}`);

    this.zone_id = this.getData().zone_id;
    this.log(`zone_id: ${this.zone_id}`);

    this.mode_id = this.getData().mode_id;
    this.log(`mode_id: ${this.mode_id}`);

    this.zone_parent_id = this.getData().zone_parent_id;
    this.log(`zone_parent_id: ${this.zone_parent_id}`);

    this.module_udid = this.getData().module_udid;
    this.log(`module_udid: ${this.module_udid}`);

    // Track consecutive failures for availability management
    this._failureCount = 0;
    this._maxFailures = 3;

    this.registerCapabilityListener('target_temperature', async value => {
      this.log(`Setting temperature in zone ${this.getName()} to: ${value}`);

      // Delegate to the app's write queue — returns immediately.
      // The queue handles deduplication, duringChange gating,
      // module offline detection, and bounded retries.
      await this.homey.app.setZone({
        module_udid: this.module_udid,
        mode_id: this.mode_id,
        mode_parent_id: this.zone_id,
        target_temperature: value,
      });
    });

    await this.__updateDevice();
    this.log(`Device ${this.getName()} ready`);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Zone has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Zone settings where changed');
    await this.__updateDevice();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log('Zone was renamed');
    await this.__updateDevice();
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Zone has been deleted');
  }

  /**
   * Update device from pre-fetched zones data (no API call).
   * Used by polling to avoid multiple getZones() calls.
   */
  async __updateDeviceFromCache(zones) {
    try {
      if (!zones) {
        throw new Error('Zones data is null/undefined');
      }

      const zone = zones.find(z => z.zone.id === this.zone_id && z.module_udid === this.module_udid);

      if (!zone) {
        throw new Error(`Zone ${this.zone_id} not found in zones data`);
      }

      // Success - reset failure count and ensure device is available
      this._failureCount = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Device is now available again');
      }

      await this.setCapabilityValueLogIfChanged('target_temperature', zone.zone.setTemperature / 10);
      await this.setCapabilityValueLogIfChanged('measure_temperature', zone.zone.currentTemperature / 10);
      await this.setCapabilityValueLogIfChanged('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this._failureCount++;
      this.error(`Error in __updateDeviceFromCache (attempt ${this._failureCount}/${this._maxFailures}): ${err.message}`);

      if (this._failureCount >= this._maxFailures && this.getAvailable()) {
        await this.setUnavailable('Connection lost - retrying...');
        this.error('Device marked as unavailable due to repeated failures');
      }
    }
  }

  /**
   * Update device by fetching zones from API.
   * Used for initial load and settings changes.
   */
  async __updateDevice() {
    try {
      const zones = await this.homey.app.getZones();

      if (!zones) {
        throw new Error('API returned null - zones unavailable');
      }

      const zone = zones.find(z => z.zone.id === this.zone_id && z.module_udid === this.module_udid);

      if (!zone) {
        throw new Error(`Zone ${this.zone_id} not found in API response`);
      }

      // Success - reset failure count and ensure device is available
      this._failureCount = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Device is now available again');
      }

      await this.setCapabilityValueLogIfChanged('target_temperature', zone.zone.setTemperature / 10);
      await this.setCapabilityValueLogIfChanged('measure_temperature', zone.zone.currentTemperature / 10);
      await this.setCapabilityValueLogIfChanged('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this._failureCount++;
      this.error(`Error in __updateDevice (attempt ${this._failureCount}/${this._maxFailures}): ${err.message}`);

      if (this._failureCount >= this._maxFailures && this.getAvailable()) {
        await this.setUnavailable('Connection lost - retrying...');
        this.error('Device marked as unavailable due to repeated failures');
      }
    }
  }

  async setCapabilityValueLog(capability, value) {
    this.log(`setCapability in ${this.getName()}: ${capability}: ${value}`);
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`setCapabilityValueLog error ${capability} ${err.message}`);
    }
  }

  async setCapabilityValueLogIfChanged(capability, value) {
    const currentValue = await this.getCapabilityValue(capability);
    if (currentValue !== value) {
      this.log(`setCapability in ${this.getName()}: ${capability}: ${value} (was: ${currentValue})`);
      try {
        await this.setCapabilityValue(capability, value);
      } catch (err) {
        this.log(`setCapabilityValueLog error ${capability} ${err.message}`);
      }
    }
  }

}

module.exports = Zone;
