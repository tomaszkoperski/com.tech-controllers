'use strict';

const {
  throws,
} = require('assert');
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

    this.registerCapabilityListener('target_temperature', async value => {
      // set temperature
      this.log(`Setting temperature in zone ${this.getName()} to: ${value}`);
      this.homey.app.setZone({
        module_udid: this.module_udid,
        mode_id: this.mode_id,
        mode_parent_id: this.zone_id,
        target_temperature: value,
      });
    });

    await this.__updateDevice();
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
  }

  async __updateDevice() {
    this.log('Updating device...');
    try {
      const zones = await this.homey.app.getZones();
      const zone = zones.find(zone => (zone.zone.id === this.zone_id && zone.module_udid === this.module_udid));
      this.setCapabilityValueLog('target_temperature', zone.zone.setTemperature / 10);
      this.setCapabilityValueLog('measure_temperature', zone.zone.currentTemperature / 10);
      this.setCapabilityValueLog('measure_battery', zone.zone.batteryLevel);
    } catch (err) {
      this.log(`Error in __updateDevice: ${err.message}`);
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

}

module.exports = Zone;
