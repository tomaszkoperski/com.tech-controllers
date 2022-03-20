Support for TECH Controller heating zones in Homey

The way this works is:
- the app allows you to pull "zones" from emodul.eu / emodul.pl service
- these zones are added to homey with basic thermostat capabilities: reading and setting temperature + battery reading. This allows for controlling room temperature using

App was build and tested on:
- Homey PRO
- TECH L-8e (v.3.0.14) controller with WiFi RS module
- Zones built on: TECH R-8 thermostats, TECH STT-869 actuators for radiators and TECH STT-230/2T actuators for floor heating system

The app uses emodul.eu / emodul.pl API to read and send data, so it should work with other hardware.
Please make sure you provide your emodul login credentials in app settings after installation.