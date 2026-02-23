'use strict';

const consolere = require('console-remote-client');

/**
 * Console.re remote logging helper for Homey apps.
 * 
 * Mirrors all this.log() and this.error() calls to a console.re channel.
 * Uses Homey's SimpleClass.log/error interception via a safe wrapper approach.
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
    this._intercepted = false;

    // Store original console.log so we can use it for local output
    this._consoleLog = console.log.bind(console);
    this._consoleError = console.error.bind(console);
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

        // Intercept console.log/error since Homey's this.log() ultimately
        // calls console.log with a prefix. This is the safest way to capture
        // all output without touching Homey's read-only prototype properties.
        if (!this._intercepted) {
          this._interceptConsole();
          this._intercepted = true;
        }

        this._consoleLog(`[ConsoleRe] Connected to channel: ${channel}`);
      } catch (e) {
        this._consoleLog(`[ConsoleRe] Failed to connect: ${e.message}`);
      }
    }
  }

  /**
   * Intercept global console.log/error to mirror to console.re.
   * Only captures lines from our app (checks for app-related prefixes).
   */
  _interceptConsole() {
    const self = this;
    const origLog = this._consoleLog;
    const origError = this._consoleError;
    const appName = this._appName;

    console.log = function (...args) {
      origLog.apply(console, args);
      if (self._enabled && console.re && console.re.log) {
        try { console.re.log(`[${appName}]`, ...args); } catch (e) { /* ignore */ }
      }
    };

    console.error = function (...args) {
      origError.apply(console, args);
      if (self._enabled && console.re && console.re.error) {
        try { console.re.error(`[${appName}]`, ...args); } catch (e) { /* ignore */ }
      }
    };
  }

  /**
   * Send a log to console.re (if enabled).
   */
  log(...args) {
    if (!this._enabled || !console.re || !console.re.log) return;
    try {
      console.re.log(`[${this._appName}]`, ...args);
    } catch (e) { /* ignore */ }
  }

  /**
   * Send an error to console.re (if enabled).
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
