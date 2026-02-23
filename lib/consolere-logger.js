'use strict';

const consolere = require('console-remote-client');

/**
 * Console.re remote logging helper for Homey apps.
 * 
 * Simple approach: call rlog()/rerror() explicitly at key points.
 * No interception, no wrapping, no recursion risks.
 * 
 * Settings used:
 *   - consolere_enabled (boolean)
 *   - consolere_channel (string)
 */
class ConsoleReLogger {
  constructor(app, appName, appVersion) {
    this._app = app;
    this._appName = appName || 'HomeyApp';
    this._appVersion = appVersion || '0.0.0';
    this._enabled = false;
    this._connected = false;
  }

  /**
   * Initialize from app settings. Call in onInit() and on settings change.
   */
  init() {
    const enabled = this._app.homey.settings.get('consolere_enabled') === true;
    const channel = this._app.homey.settings.get('consolere_channel');

    // Disconnect previous
    if (this._connected && console.re && console.re.disconnect) {
      try { console.re.disconnect(); } catch (e) { /* ignore */ }
      this._connected = false;
    }

    this._enabled = false;

    if (enabled && channel) {
      try {
        consolere.connect({
          channel: channel,
          server: 'https://console.re',
        });
        this._enabled = true;
        this._connected = true;
      } catch (e) {
        // silently fail
      }
    }
  }

  /**
   * Send a log to console.re (if enabled).
   */
  log(...args) {
    if (!this._enabled || !console.re || !console.re.log) return;
    try {
      console.re.log(...args);
    } catch (e) { /* ignore */ }
  }

  /**
   * Send an error to console.re (if enabled).
   */
  error(...args) {
    if (!this._enabled || !console.re || !console.re.error) return;
    try {
      console.re.error(...args);
    } catch (e) { /* ignore */ }
  }

  get enabled() {
    return this._enabled;
  }
}

module.exports = ConsoleReLogger;
