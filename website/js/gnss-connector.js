/* KUKL GNSS Connector — external GNSS / RTK receiver bridge (SW Maps style).
   Connects to a Bluetooth-LE or USB / Bluetooth-SPP (Web Serial) GNSS receiver,
   parses the live NMEA stream and reports high-accuracy fixes.

   Browser limits (important):
   - Web Bluetooth speaks BLE (GATT) only. Classic Bluetooth SPP devices are NOT
     reachable through navigator.bluetooth. For an SPP receiver, pair it in the OS
     so it appears as a COM/tty serial port, then use the SERIAL/USB option.
   - Both APIs require HTTPS (or localhost) and a user gesture to connect.

   Public API:
     window.KUKLGnss.supported  -> { ble:Boolean, serial:Boolean }
     window.KUKLGnss.create({ onFix, onStatus, onRaw }) -> {
         connectBLE(), connectSerial({baudRate}),
         disconnect(), isConnected(), getLast()
     }
   onFix receives:
     { lat, lng, fixType, fixLabel, sats, hdop, alt, acc, time, source }
*/
(function () {
  'use strict';

  // Known BLE "serial over GATT" services to probe (Nordic UART + common clones).
  var BLE_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  var BLE_UART_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device -> host (notify)
  var BLE_OPTIONAL_SERVICES = [
    BLE_UART_SERVICE,
    '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 / generic serial
    '0000fff0-0000-1000-8000-00805f9b34fb', // common GNSS serial
    '0000ffb0-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip transparent UART
  ];

  var FIX_LABELS = {
    0: 'No fix', 1: 'GPS', 2: 'DGPS', 3: 'PPS',
    4: 'RTK Fixed', 5: 'RTK Float', 6: 'Estimated', 7: 'Manual', 8: 'Simulation',
  };

  // ---- NMEA parsing -------------------------------------------------
  function nmeaChecksumOk(line) {
    var star = line.indexOf('*');
    if (star < 0) return true; // no checksum present -> accept
    var sum = 0;
    for (var i = 1; i < star; i++) sum ^= line.charCodeAt(i);
    var given = parseInt(line.slice(star + 1, star + 3), 16);
    return !isNaN(given) && sum === given;
  }

  function dm2deg(val, hemi) {
    if (!val) return null;
    var f = parseFloat(val);
    if (isNaN(f)) return null;
    var deg = Math.floor(f / 100);
    var min = f - deg * 100;
    var dec = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') dec = -dec;
    return dec;
  }

  function createParser(emit) {
    var cur = {
      lat: null, lng: null, fixType: 0, fixLabel: 'No fix',
      sats: null, hdop: null, alt: null, acc: null, time: null,
    };
    function pushFix(source) {
      if (cur.lat == null || cur.lng == null) return;
      if (cur.acc == null && cur.hdop != null) {
        // Rough horizontal accuracy when no GST sentence is available.
        cur.acc = Math.round(cur.hdop * 4 * 10) / 10;
      }
      emit({
        lat: cur.lat, lng: cur.lng,
        fixType: cur.fixType, fixLabel: cur.fixLabel,
        sats: cur.sats, hdop: cur.hdop, alt: cur.alt,
        acc: cur.acc, time: cur.time, source: source,
      });
    }
    return function handleLine(line) {
      line = (line || '').trim();
      if (line.charAt(0) !== '$') return;
      if (!nmeaChecksumOk(line)) return;
      var body = line.slice(1).split('*')[0];
      var p = body.split(',');
      var type = (p[0] || '').slice(2); // strip talker id (GP/GN/GL/GA/BD…)

      if (type === 'GGA') {
        var lat = dm2deg(p[2], p[3]);
        var lng = dm2deg(p[4], p[5]);
        var q = parseInt(p[6], 10);
        if (!isNaN(q)) { cur.fixType = q; cur.fixLabel = FIX_LABELS[q] || ('Fix ' + q); }
        cur.sats = p[7] ? parseInt(p[7], 10) : cur.sats;
        cur.hdop = p[8] ? parseFloat(p[8]) : cur.hdop;
        cur.alt = p[9] ? parseFloat(p[9]) : cur.alt;
        cur.time = p[1] || cur.time;
        if (lat != null && lng != null && cur.fixType > 0) {
          cur.lat = lat; cur.lng = lng;
          pushFix('GGA');
        }
      } else if (type === 'RMC') {
        var st = p[2];
        var rlat = dm2deg(p[3], p[4]);
        var rlng = dm2deg(p[5], p[6]);
        cur.time = p[1] || cur.time;
        if (st === 'A' && rlat != null && rlng != null) {
          cur.lat = rlat; cur.lng = rlng;
          if (cur.fixType === 0) { cur.fixType = 1; cur.fixLabel = FIX_LABELS[1]; }
          pushFix('RMC');
        }
      } else if (type === 'GST') {
        var latStd = parseFloat(p[6]);
        var lonStd = parseFloat(p[7]);
        if (!isNaN(latStd) && !isNaN(lonStd)) {
          cur.acc = Math.round(Math.sqrt(latStd * latStd + lonStd * lonStd) * 10) / 10;
        }
      }
    };
  }

  // ---- Connector ----------------------------------------------------
  function create(opts) {
    opts = opts || {};
    var onFix = opts.onFix || function () {};
    var onStatus = opts.onStatus || function () {};
    var onRaw = opts.onRaw || function () {};

    var last = null;
    var mode = null;            // 'ble' | 'serial' | null
    var bleDevice = null, bleChar = null;
    var serialPort = null, serialReader = null, serialKeep = false;
    var decoder = new TextDecoder();
    var buffer = '';

    var parse = createParser(function (fix) {
      last = fix;
      onFix(fix);
    });

    function feed(text) {
      onRaw(text);
      buffer += text;
      var idx;
      while ((idx = buffer.search(/[\r\n]/)) >= 0) {
        var line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line) parse(line);
      }
      if (buffer.length > 4096) buffer = buffer.slice(-1024); // guard runaway
    }

    function status(state, msg) { onStatus({ state: state, message: msg, mode: mode }); }

    // ---- Bluetooth LE ----
    function connectBLE() {
      if (!navigator.bluetooth) {
        status('error', 'Web Bluetooth is not supported in this browser.');
        return Promise.reject(new Error('no-bluetooth'));
      }
      status('connecting', 'Select your BLE GNSS receiver…');
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BLE_OPTIONAL_SERVICES,
      }).then(function (device) {
        bleDevice = device;
        device.addEventListener('gattserverdisconnected', function () {
          if (mode === 'ble') { mode = null; status('disconnected', 'Receiver disconnected.'); }
        });
        status('connecting', 'Connecting to ' + (device.name || 'device') + '…');
        return device.gatt.connect();
      }).then(function (server) {
        return findNotifyChar(server);
      }).then(function (ch) {
        if (!ch) throw new Error('no-notify-characteristic');
        bleChar = ch;
        ch.addEventListener('characteristicvaluechanged', function (e) {
          feed(decoder.decode(e.target.value));
        });
        return ch.startNotifications();
      }).then(function () {
        mode = 'ble';
        status('connected', 'BLE GNSS connected — waiting for fix…');
      }).catch(function (err) {
        if (err && err.name === 'NotFoundError') { status('idle', 'Connection cancelled.'); return; }
        console.warn('[GNSS] BLE connect failed', err);
        status('error', bleHint(err));
        cleanupBLE();
      });
    }

    function findNotifyChar(server) {
      // Prefer the Nordic UART TX characteristic, else the first notifiable one.
      return server.getPrimaryService(BLE_UART_SERVICE)
        .then(function (svc) { return svc.getCharacteristic(BLE_UART_TX); })
        .catch(function () {
          return server.getPrimaryServices().then(function (services) {
            return (function next(i) {
              if (i >= services.length) return null;
              return services[i].getCharacteristics().then(function (chars) {
                for (var j = 0; j < chars.length; j++) {
                  if (chars[j].properties && chars[j].properties.notify) return chars[j];
                }
                return next(i + 1);
              }).catch(function () { return next(i + 1); });
            })(0);
          });
        });
    }

    function bleHint(err) {
      var m = (err && err.message) || '';
      if (/notify/i.test(m)) return 'No readable data channel found on this device.';
      return 'Could not connect over Bluetooth. If this is a Classic/SPP receiver, pair it in the OS and use SERIAL/USB instead.';
    }

    function cleanupBLE() {
      try { if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) bleDevice.gatt.disconnect(); } catch (_) {}
      bleDevice = null; bleChar = null;
    }

    // ---- Web Serial (USB or paired Bluetooth-SPP COM port) ----
    function connectSerial(o) {
      o = o || {};
      if (!navigator.serial) {
        status('error', 'Web Serial is not supported in this browser.');
        return Promise.reject(new Error('no-serial'));
      }
      status('connecting', 'Select the GNSS serial port…');
      return navigator.serial.requestPort().then(function (port) {
        serialPort = port;
        return port.open({ baudRate: o.baudRate || 9600 });
      }).then(function () {
        mode = 'serial';
        serialKeep = true;
        status('connected', 'Serial GNSS connected — waiting for fix…');
        readSerialLoop();
      }).catch(function (err) {
        if (err && err.name === 'NotFoundError') { status('idle', 'No port selected.'); return; }
        console.warn('[GNSS] Serial connect failed', err);
        status('error', 'Could not open the serial port. Check it is free and the baud rate matches.');
        cleanupSerial();
      });
    }

    function readSerialLoop() {
      if (!serialPort || !serialPort.readable) return;
      var textStream = serialPort.readable.pipeThrough(new TextDecoderStream());
      serialReader = textStream.getReader();
      (function pump() {
        serialReader.read().then(function (res) {
          if (res.done || !serialKeep) { return; }
          if (res.value) feed(res.value);
          pump();
        }).catch(function (err) {
          if (serialKeep) console.warn('[GNSS] serial read error', err);
        });
      })();
    }

    function cleanupSerial() {
      serialKeep = false;
      var p = Promise.resolve();
      try { if (serialReader) { serialReader.cancel().catch(function () {}); serialReader.releaseLock(); } } catch (_) {}
      serialReader = null;
      try { if (serialPort) p = serialPort.close().catch(function () {}); } catch (_) {}
      serialPort = null;
      return p;
    }

    // ---- Common ----
    function disconnect() {
      var was = mode;
      mode = null;
      buffer = '';
      if (was === 'ble') cleanupBLE();
      cleanupSerial();
      status('disconnected', 'Receiver disconnected.');
    }

    return {
      connectBLE: connectBLE,
      connectSerial: connectSerial,
      disconnect: disconnect,
      isConnected: function () { return !!mode; },
      getMode: function () { return mode; },
      getLast: function () { return last; },
      // Replay raw NMEA text (e.g. from a logged stream) through the parser.
      feed: feed,
    };
  }

  window.KUKLGnss = {
    supported: {
      ble: typeof navigator !== 'undefined' && !!navigator.bluetooth,
      serial: typeof navigator !== 'undefined' && !!navigator.serial,
    },
    create: create,
  };
})();
