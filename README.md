# [TECH Controllers support for Athom Homey](https://github.com/tomaszkoperski/com.tech-controllers)

I've made this app to be able to control my [Tech Controllers](https://www.tech-controllers.com) heating zones using Homey.

The way this works is:
- the app allows you to pull "zones" from emodul.eu / emodul.pl service
- these zones are added to homey with basic thermostat capabilities: reading and setting temperature + battery reading. This allows for controlling room temperature using

App was build and tested on:
- Homey PRO
- TECH L-8e (v.3.0.14) controller with WiFi RS module
- Zones built on: TECH R-8 thermostats, TECH STT-869 actuators for radiators and TECH STT-230/2T actuators for floor heating system

The app uses emodul.eu / emodul.pl API to read and send data, so it should work with other hardware.
Please make sure you provide your emodul login credentials in app settings after installation.

## Known Issues
See [Issue Tracker](https://github.com/tomaszkoperski/com.tech-controllers/issues)

## Supported Languages

* English

## Notes
* Build
  * `homey app run` to run the dev build of the App on your Homey PRO.
  * `homey app install` to drop a production build onto your Homey PRO.

## Change Log
* **1.0.0** Initial release (2022-03-20).

## Feedback

Please report issues at the [issues section on GitHub](https://github.com/tomaszkoperski/com.tech-controllers/issues).

## Thank you note

I'd like to thank [AdyRock](https://github.com/AdyRock) for sharing his code, which helped a lot :)