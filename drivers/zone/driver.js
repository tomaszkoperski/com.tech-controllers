'use strict';

const { Driver } = require('homey');

class Zone extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Zone has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    const zones = await this.homey.app.getZones();

    return zones.map(element => {
      return {
        name: element.description.name,
        data: {
          zone_id: element.zone.id,
          zone_parent_id: element.zone.parentId,
          mode_id: element.mode.id,
          module_udid: element.module_udid,
        },
      };
    });
  }

}

module.exports = Zone;
