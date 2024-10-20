# [TECH Controllers support for Athom Homey](https://github.com/tomaszkoperski/com.tech-controllers)

I've created this app to control [Tech Controllers](https://www.tech-controllers.com) heating zones using Homey.

How it works:
- The app allows you to pull "zones" from the emodul.eu / emodul.pl service.
- These zones are added to Homey with basic thermostat capabilities: reading and setting temperature, plus battery reading. This allows for controlling room temperature with the [Homey Heating Scheduler](https://homey.app/en-us/app/app.mskg.homey-heating/Homey-Heating-Scheduler/) or a similar app.

The app was built and tested on:
- Homey PRO
- TECH L-8e (v.3.0.14) controller with WiFi RS module
- Zones built on: TECH R-8 thermostats, TECH STT-869 actuators for radiators, and TECH STT-230/2T actuators for floor heating systems

The app uses the emodul.eu / emodul.pl API to read and send data, so it should work with other hardware.
Please ensure you provide your emodul login credentials in the app settings after installation.

## Known Issues
See the [Issue Tracker](https://github.com/tomaszkoperski/com.tech-controllers/issues)

## Supported Languages
* English

## Notes
* Build
  * `homey app run` to run the dev build of the app on your Homey PRO.
  * `homey app install` to install a development build onto your Homey PRO.

## Change Log
* **1.0.0** Initial release (2022-03-20).
* **1.0.3** Fixed handling of empty zones (2024-10-20).
* **1.1.0** Code cleanup, confirmation message in settings, check driver and devices readiness on startup (2024-10-20).

## Feedback
Please report issues in the [issues section on GitHub](https://github.com/tomaszkoperski/com.tech-controllers/issues).

## Thank You Note
I'd like to thank [AdyRock](https://github.com/AdyRock) for sharing his code, which helped a lot :)
