'use strict';

const consolere = require('console-remote-client');

/**
 * Console.re remote logging helper for Homey apps.
 * 
 * Uses the built-in `redirectDefaultConsoleToRemote` option from
 * console-remote-client to mirror all console.log/error/warn/debug
 * calls to the remote console.re channel.
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
          // Built-in option: redirect all console.log/warn/error/debug
          // to remote console. This is the official way to mirror everything.
          redirectDefaultConsoleToRemote: true,
        });
        this._enabled = true;
        this._connected = true;
        this._app.log(`[ConsoleRe] Connected to channel: ${channel}`);
      } catch (e) {
        this._app.log(`[ConsoleRe] Failed to connect: ${e.message}`);
      }
    }
  }

  /**
   * Send a log to console.re (if enabled). For explicit remote-only messages.
   */
  log(...args) {
    if (!this._enabled || !console.re || !console.re.log) return;
    try {
      console.re.log(`[${this._appName}]`, ...args);
    } catch (e) { /* ignore */ }
  }

  /**
   * Send an error to console.re (if enabled). For explicit remote-only messages.
   */
  error(...args) {
    if (!this._enabled || !console.re || !console.re.error) return;
    try {
      console.re.error(`[${this._appName}]`, ...args);
    } catch (e) { /* ignore */ }
  }

  /**
   * Whether remote logging is currently enabled.
   */
  get enabled() {
    return this._enabled;
  }
}

module.exports = ConsoleReLogger;
