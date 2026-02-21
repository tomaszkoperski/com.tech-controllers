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

    this._deviceReady = false;
    this._pendingSet = null; // { value, deadline, timer }

    this.registerCapabilityListener('target_temperature', async value => {
      // Wait for device initialization before accepting commands
      if (!this._deviceReady) {
        this.log(`Waiting for ${this.getName()} init before setting ${value}°...`);
        const deadline = Date.now() + 30000;
        while (!this._deviceReady && Date.now() < deadline) {
          await new Promise(resolve => this.homey.setTimeout(resolve, 1000));
        }
        if (!this._deviceReady) {
          this._queueTemperatureSet(value);
          return; // Don't throw — queued for retry
        }
      }

      await this._doSetTemperature(value);
    });

    await this.__updateDevice();
    this._deviceReady = true;
    this.log(`Device ${this.getName()} ready`);

    // Process any pending set that was queued during init
    this._processPendingSet();
  }

  /**
   * Attempt to set temperature, queue for retry on failure.
   */
  async _doSetTemperature(value) {
    this.log(`Setting temperature in zone ${this.getName()} to: ${value}`);
    try {
      const result = await this.homey.app.setZone({
        module_udid: this.module_udid,
        mode_id: this.mode_id,
        mode_parent_id: this.zone_id,
        target_temperature: value,
      });
      if (result === null) {
        throw new Error('eModul API returned null');
      }
      // Success — clear any pending retry for this device
      this._clearPendingSet();
      this.log(`Temperature set to ${value}° in ${this.getName()}`);
    } catch (err) {
      this.error(`Failed to set ${this.getName()} to ${value}°: ${err.message}`);
      this._queueTemperatureSet(value);
      throw new Error(`Failed to set temperature to ${value}° — will retry for 15 minutes`);
    }
  }

  /**
   * Queue a temperature set for retry (up to 15 minutes, every 60s).
   */
  _queueTemperatureSet(value) {
    // Cancel previous pending set (new value supersedes old)
    this._clearPendingSet();

    const retryDuration = 15 * 60 * 1000; // 15 minutes
    const retryInterval = 60 * 1000; // retry every 60s
    const deadline = Date.now() + retryDuration;

    this.log(`Queuing temperature ${value}° for ${this.getName()} — will retry until ${new Date(deadline).toISOString()}`);

    this._pendingSet = {
      value,
      deadline,
      timer: this.homey.setInterval(async () => {
        await this._processPendingSet();
      }, retryInterval),
    };
  }

  async _processPendingSet() {
    if (!this._pendingSet) return;

    const { value, deadline } = this._pendingSet;

    if (Date.now() > deadline) {
      this.error(`Giving up on setting ${this.getName()} to ${value}° — 15 min timeout reached`);
      this._clearPendingSet();
      return;
    }

    this.log(`Retrying: set ${this.getName()} to ${value}°...`);
    try {
      const result = await this.homey.app.setZone({
        module_udid: this.module_udid,
        mode_id: this.mode_id,
        mode_parent_id: this.zone_id,
        target_temperature: value,
      });
      if (result === null) {
        throw new Error('eModul API returned null');
      }
      this.log(`Retry succeeded: ${this.getName()} set to ${value}°`);
      this._clearPendingSet();
    } catch (err) {
      const remainingSec = Math.round((deadline - Date.now()) / 1000);
      this.log(`Retry failed for ${this.getName()}: ${err.message}. ${remainingSec}s remaining.`);
    }
  }

  _clearPendingSet() {
    if (this._pendingSet?.timer) {
      this.homey.clearInterval(this._pendingSet.timer);
    }
    this._pendingSet = null;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Zone has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }) {
    this.log('Zone settings where changed');
    await this.__updateDevice();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
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
    this._clearPendingSet();
  }

  async __updateDevice() {
    try {
      const zones = await this.homey.app.getZones();

      // Handle null response (API error case)
      if (!zones) {
        throw new Error('API returned null - zones unavailable');
      }

      const zone = zones.find(z => z.zone.id === this.zone_id && z.module_udid === this.module_udid);

      // Handle zone not found
      if (!zone) {
        throw new Error(`Zone ${this.zone_id} not found in API response`);
      }

      // Success - reset failure count and ensure device is available
      this._failureCount = 0;
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Device is now available again');
      }

      this.setCapabilityValueLogIfChanged('target_temperature', zone.zone.setTemperature / 10);
      this.setCapabilityValueLogIfChanged('measure_temperature', zone.zone.currentTemperature / 10);
      this.setCapabilityValueLogIfChanged('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this._failureCount++;
      this.error(`Error in __updateDevice (attempt ${this._failureCount}/${this._maxFailures}): ${err.message}`);

      // Mark device unavailable after consecutive failures
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
