'use strict';

const axios = require('axios');
const { logger } = require('../logger');
const { gpsEventEmitter } = require('../gpsEvents');
const { updateDeviceState, getDeviceState } = require('../gt06Server');
const { saveLocationHistory, upsertDevice, getDeviceByImei } = require('../db/mysql');

const TESTER_EMAIL = (process.env.TESTER_EMAIL || 'tester@gmail.com').toLowerCase().trim();

// Active simulation timers: Map<imei, { timerId, stopTimerId, startTime, isOilCut, workMode, ... }>
const activeSimulations = new Map();

// Preset routes across major hubs for TomTom routing variety
const ROUTE_START_END_PAIRS = [
  // Port Harcourt — GRA to Trans-Amadi / Aba Road
  { start: { lat: 4.8156, lon: 7.0498 }, end: { lat: 4.8981, lon: 6.9073 }, city: 'Port Harcourt Hub' },
  // Port Harcourt — Airport Road to Peter Odili
  { start: { lat: 4.8520, lon: 7.0120 }, end: { lat: 4.8010, lon: 7.0560 }, city: 'Port Harcourt Commercial' },
  // Lagos — Victoria Island to Lekki Phase 1
  { start: { lat: 6.4281, lon: 3.4219 }, end: { lat: 6.4474, lon: 3.4723 }, city: 'Lagos Lekki Corridor' },
  // Lagos — Ikeja GRA to Maryland
  { start: { lat: 6.5922, lon: 3.3551 }, end: { lat: 6.5721, lon: 3.3712 }, city: 'Lagos Mainland' },
];

/**
 * Check if the authenticated user is the designated tester.
 */
function isTesterUser(user) {
  if (!user) return false;
  const email = (user.email || '').toLowerCase().trim();
  const username = (user.username || '').toLowerCase().trim();
  return email === TESTER_EMAIL || username === TESTER_EMAIL;
}

/**
 * Check if an IMEI belongs to the tester.
 */
async function isTesterDevice(imei, user = null) {
  if (user && isTesterUser(user)) return true;
  if (!imei) return false;

  const targetImei = String(imei).trim();
  const devState = getDeviceState(targetImei);
  if (devState && (devState.isTester || devState.userId === 'tester')) {
    return true;
  }

  const dbDev = await getDeviceByImei(targetImei);
  if (dbDev && (dbDev.user_email === TESTER_EMAIL || dbDev.registeredBy === 'tester@gmail.com' || dbDev.registeredBy === 'tester')) {
    return true;
  }

  return false;
}

/**
 * Calculate compass bearing between two lat/lon points (0-359 degrees).
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

  let brng = toDeg(Math.atan2(y, x));
  return Math.round((brng + 360) % 360);
}

/**
 * Calculate distance in km between two lat/lon points using Haversine formula.
 */
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Fetch a realistic road route from TomTom Calculate Route API.
 */
async function fetchTomTomRoute() {
  const apiKey = process.env.TOMTOM_API_KEY || 'rDJMYBeHtsRSNUCkRZr1iFM1EYJqERqb';
  const pair = ROUTE_START_END_PAIRS[Math.floor(Math.random() * ROUTE_START_END_PAIRS.length)];

  if (apiKey) {
    try {
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${pair.start.lat},${pair.start.lon}:${pair.end.lat},${pair.end.lon}/json?key=${apiKey}&traffic=false`;
      const res = await axios.get(url, { timeout: 8000 });
      const rawPoints = res.data?.routes?.[0]?.legs?.[0]?.points;

      if (Array.isArray(rawPoints) && rawPoints.length > 5) {
        logger.info('TOMTOM_ROUTE_FETCHED', {
          pointsCount: rawPoints.length,
          start: pair.start,
          end: pair.end,
          city: pair.city,
        });

        // Sample 30 evenly distributed waypoints across the 60-second trip
        const targetCount = 30;
        const step = Math.max(1, Math.floor(rawPoints.length / targetCount));
        const sampled = [];
        for (let i = 0; i < rawPoints.length; i += step) {
          sampled.push({
            latitude: parseFloat(rawPoints[i].latitude.toFixed(6)),
            longitude: parseFloat(rawPoints[i].longitude.toFixed(6)),
          });
          if (sampled.length >= targetCount) break;
        }

        // Always include exact destination point
        const last = rawPoints[rawPoints.length - 1];
        sampled[sampled.length - 1] = {
          latitude: parseFloat(last.latitude.toFixed(6)),
          longitude: parseFloat(last.longitude.toFixed(6)),
        };

        return sampled;
      }
    } catch (err) {
      logger.warn('TOMTOM_API_FETCH_FAILED_FALLBACK', { error: err.message });
    }
  }

  // Fallback high-fidelity realistic road polyline
  const baseLat = pair.start.lat;
  const baseLon = pair.start.lon;
  const dLat = (pair.end.lat - pair.start.lat) / 30;
  const dLon = (pair.end.lon - pair.start.lon) / 30;

  const fallback = [];
  for (let i = 0; i < 30; i++) {
    // Add realistic subtle road curve noise
    const noise = Math.sin((i / 30) * Math.PI * 2) * 0.0008;
    fallback.push({
      latitude: parseFloat((baseLat + i * dLat + noise).toFixed(6)),
      longitude: parseFloat((baseLon + i * dLon).toFixed(6)),
    });
  }
  return fallback;
}

/**
 * Start 1-minute live TomTom trip simulation for a tester device.
 */
async function startTesterSimulation(imei, user = null) {
  const targetImei = String(imei).trim();

  // If already actively running, let it continue
  if (activeSimulations.has(targetImei)) {
    return { success: true, running: true, message: 'Simulation already in progress' };
  }

  const waypoints = await fetchTomTomRoute();
  if (!waypoints || waypoints.length === 0) {
    return { success: false, error: 'No waypoints generated' };
  }

  const simState = {
    imei: targetImei,
    userEmail: user?.email || TESTER_EMAIL,
    isOilCut: false,
    workMode: 0,
    intervalSec: 2,
    currentIndex: 0,
    startTime: Date.now(),
    durationMs: 60 * 1000, // 1 minute (60 seconds)
    waypoints,
    timerId: null,
    stopTimerId: null,
  };

  activeSimulations.set(targetImei, simState);

  logger.info('TESTER_SIMULATION_STARTED', {
    imei: targetImei,
    userEmail: simState.userEmail,
    points: waypoints.length,
    duration: '60 seconds',
    interval: '2 seconds',
  });

  const intervalMs = 2000; // Emit every 2 seconds

  simState.timerId = setInterval(() => {
    const current = activeSimulations.get(targetImei);
    if (!current) return;

    if (current.currentIndex >= current.waypoints.length) {
      current.currentIndex = 0; // Loop seamlessly within the 1-minute window
    }

    const currPoint = current.waypoints[current.currentIndex];
    const nextPoint = current.waypoints[(current.currentIndex + 1) % current.waypoints.length];

    const direction = calculateBearing(currPoint.latitude, currPoint.longitude, nextPoint.latitude, nextPoint.longitude);
    const distKm = calculateDistanceKm(currPoint.latitude, currPoint.longitude, nextPoint.latitude, nextPoint.longitude);

    // Realistic vehicle speed (between 35 - 65 km/h) or 0 if oil cut is active
    let speedKmh = current.isOilCut ? 0 : Math.round(35 + Math.sin(current.currentIndex) * 20);
    if (speedKmh < 0) speedKmh = 0;
    const speedKnots = parseFloat((speedKmh / 1.852).toFixed(2));

    const nowIso = new Date().toISOString();
    const nowUtc = nowIso.replace('T', ' ').replace('Z', ' UTC').substring(0, 19) + ' UTC';

    const equStatusHex = current.isOilCut ? 'F7FEFBFF' : 'FFFFFBFF';

    const payload = {
      id: `${Date.now()}_sim_${Math.random().toString(36).slice(2, 8)}`,
      ts: nowIso,
      level: 'INFO',
      event: 'HQ_GPS_UPDATE',
      protocol: 'HQ',
      cmd: 'V1',
      imei: targetImei,
      remote: '197.210.54.228:11610',
      latitude: currPoint.latitude,
      longitude: currPoint.longitude,
      speed: speedKmh,
      speed_knots: speedKnots,
      speed_kmh: speedKmh,
      direction,
      gpsStatus: 'A',
      accOn: !current.isOilCut,
      isBackupBattery: false,
      isOilCut: current.isOilCut,
      equStatusHex,
      timestamp: nowUtc,
      isTesterSimulated: true,
    };

    // 1. Emit live real-time WebSocket update to mobile apps
    gpsEventEmitter.emit('gps:update', payload);

    // 2. Update in-memory state
    updateDeviceState(targetImei, {
      connected: true,
      protocol: 'HQ',
      isTester: true,
      lastLocation: {
        latitude: currPoint.latitude,
        longitude: currPoint.longitude,
        speed_kmh: speedKmh,
        speed_knots: speedKnots,
        direction,
        gpsStatus: 'A',
        timestamp: nowUtc,
      },
      vehicleStatus: {
        raw: equStatusHex,
        accOn: !current.isOilCut,
        gpsFixed: true,
        isBackupBattery: false,
        isOilCut: current.isOilCut,
        alarms: [],
      },
      lastActivityAt: nowIso,
    });

    // 3. Persist waypoint to MySQL history
    saveLocationHistory({
      imei: targetImei,
      latitude: currPoint.latitude,
      longitude: currPoint.longitude,
      speed_kmh: speedKmh,
      direction,
      accOn: !current.isOilCut,
      gpsStatus: 'A',
      timestamp: nowUtc,
      raw_hex: `*HQ,${targetImei},V1,SIM,A,${currPoint.latitude},${currPoint.longitude},${speedKnots},${direction}#`,
    });

    upsertDevice({
      imei: targetImei,
      protocol: 'HQ',
      connected: true,
      latitude: currPoint.latitude,
      longitude: currPoint.longitude,
      speed_kmh: speedKmh,
      direction,
      accOn: !current.isOilCut,
      isOilCut: current.isOilCut,
      isBackupBattery: false,
      gpsStatus: 'A',
      lastSeen: nowUtc,
    });

    current.currentIndex++;
  }, intervalMs);

  // Auto-stop after 1 minute (60 seconds)
  simState.stopTimerId = setTimeout(() => {
    stopTesterSimulation(targetImei);
  }, simState.durationMs);

  return { success: true, running: true, duration: 60 };
}

/**
 * Stop active tester simulation for a device.
 */
function stopTesterSimulation(imei) {
  const targetImei = String(imei).trim();
  const sim = activeSimulations.get(targetImei);
  if (!sim) return;

  if (sim.timerId) clearInterval(sim.timerId);
  if (sim.stopTimerId) clearTimeout(sim.stopTimerId);
  activeSimulations.delete(targetImei);

  // Set parked state with speed 0
  const devState = getDeviceState(targetImei);
  if (devState && devState.lastLocation) {
    devState.lastLocation.speed_kmh = 0;
    devState.lastLocation.speed_knots = 0;
    updateDeviceState(targetImei, {
      lastLocation: devState.lastLocation,
      connected: true,
      lastActivityAt: new Date().toISOString(),
    });
  }

  logger.info('TESTER_SIMULATION_STOPPED', {
    imei: targetImei,
    durationElapsed: '60 seconds completed',
  });
}

/**
 * Handle incoming tracker commands targeted at a tester device as if it's a real car.
 */
async function handleTesterCommand(imei, cmdCode, params = []) {
  const targetImei = String(imei).trim();
  const sim = activeSimulations.get(targetImei);
  const devState = getDeviceState(targetImei) || {};
  const cmd = String(cmdCode).toUpperCase();
  const nowStr = new Date().toISOString();
  const hhmmss = new Date().toTimeString().slice(0, 8).replace(/:/g, '');

  let responseAscii = `*HQ,${targetImei},V4,${cmd},${hhmmss}#`;
  let successMsg = `Command ${cmd} executed successfully on device ${targetImei}`;

  if (cmd === 'S20') {
    // S20: Remote Cut-Off / Restore Oil & Electricity
    // params[1] !== 0 -> Cut oil, params[1] === 0 -> Restore oil
    const isCut = params.length > 1 ? String(params[1]) !== '0' : String(params[0]) === '1';
    if (sim) sim.isOilCut = isCut;

    const equStatusHex = isCut ? 'F7FEFBFF' : 'FFFFFBFF';
    responseAscii = `*HQ,${targetImei},V4,S20,${isCut ? 'DONE' : 'OK'},${hhmmss},${hhmmss},A,4.898115,N,6.907373,E,0.00,0,010926,${equStatusHex}#`;
    successMsg = isCut
      ? `Engine / Fuel cut off successfully for device ${targetImei}`
      : `Engine / Fuel restored successfully for device ${targetImei}`;

    updateDeviceState(targetImei, {
      vehicleStatus: {
        raw: equStatusHex,
        accOn: !isCut,
        gpsFixed: true,
        isBackupBattery: false,
        isOilCut: isCut,
        alarms: isCut ? ['OIL_CUT'] : [],
      },
      lastActivityAt: nowStr,
    });
  } else if (cmd === 'D1') {
    // D1: Upload interval
    const interval = params[0] || 30;
    if (sim) sim.intervalSec = parseInt(interval, 10);
    responseAscii = `*HQ,${targetImei},V4,D1,${hhmmss},${hhmmss},A,4.898115,N,6.907373,E,0.00,0,010926,FFFFFBFF#`;
    successMsg = `Tracking upload interval updated to ${interval} seconds`;
  } else if (cmd === 'D2') {
    // D2: Fast locate
    const duration = params[0] || 180;
    responseAscii = `*HQ,${targetImei},V4,D2,${hhmmss},${hhmmss},A,4.898115,N,6.907373,E,0.00,0,010926,FFFFFBFF#`;
    successMsg = `Fast locate activated for ${duration} seconds`;
  } else if (cmd === 'R1') {
    // R1: Restart
    responseAscii = `*HQ,${targetImei},V4,R1,${hhmmss},${hhmmss},A,4.898115,N,6.907373,E,0.00,0,010926,FFFFFBFF#`;
    successMsg = `Device ${targetImei} restarted successfully`;
  } else if (cmd === 'WKMD') {
    // WKMD: Work mode
    const mode = params[0] || 0;
    if (sim) sim.workMode = parseInt(mode, 10);
    responseAscii = `*HQ,${targetImei},V4,WKMD,${hhmmss},${hhmmss},A,4.898115,N,6.907373,E,0.00,0,010926,FFFFFBFF#`;
    successMsg = `Working mode updated to mode ${mode}`;
  } else if (cmd === 'S26') {
    // S26: Read State
    responseAscii = `*HQ,${targetImei},V4,S26,${hhmmss},CMNET,,,13812341234,1,100,30,1,100#`;
    successMsg = `Device state read successfully`;
  }

  // Log command confirm
  logger.info('HQ_COMMAND_CONFIRM', {
    imei: targetImei,
    cmdConfirmed: cmd,
    responseAscii,
    isTesterDevice: true,
  });

  // Emit WebSocket events
  gpsEventEmitter.emit('gps:command_confirm', {
    imei: targetImei,
    cmd: cmd,
    response: responseAscii,
    timestamp: nowStr,
    isTesterDevice: true,
  });

  return {
    success: true,
    imei: targetImei,
    cmd,
    message: successMsg,
    response: responseAscii,
    timestamp: nowStr,
    simulated: true,
  };
}

/**
 * Trigger simulation in the background if not already transmitting.
 */
function triggerTesterSimulationIfIdle(imei, user) {
  if (!isTesterUser(user)) return;
  const targetImei = String(imei).trim();
  if (activeSimulations.has(targetImei)) return;

  // Run in background asynchronously
  setImmediate(() => {
    startTesterSimulation(targetImei, user).catch((err) => {
      logger.error('TESTER_AUTO_SIMULATION_ERROR', { imei: targetImei, error: err.message });
    });
  });
}

module.exports = {
  TESTER_EMAIL,
  isTesterUser,
  isTesterDevice,
  fetchTomTomRoute,
  startTesterSimulation,
  stopTesterSimulation,
  handleTesterCommand,
  triggerTesterSimulationIfIdle,
  isTesterSimulationActive: (imei) => activeSimulations.has(String(imei).trim()),
};
