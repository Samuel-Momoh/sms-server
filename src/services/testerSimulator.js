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
// Verified on-road asphalt waypoints along major commercial and highway corridors
const VERIFIED_ROAD_ROUTES = [
  // Route 1: Port Harcourt — Aba Road Expressway (Garrison -> Waterlines -> Rumuola -> Artillery)
  [
    { latitude: 4.823900, longitude: 7.021500 },
    { latitude: 4.825800, longitude: 7.023200 },
    { latitude: 4.828100, longitude: 7.025300 },
    { latitude: 4.831000, longitude: 7.027800 },
    { latitude: 4.834500, longitude: 7.030700 },
    { latitude: 4.837800, longitude: 7.033500 },
    { latitude: 4.842000, longitude: 7.037000 },
  ],
  // Route 2: Port Harcourt — Olu Obasanjo Road Commercial Corridor (GRA Junction -> Bank Row -> Aba Rd)
  [
    { latitude: 4.819500, longitude: 7.001200 },
    { latitude: 4.822000, longitude: 7.005500 },
    { latitude: 4.824800, longitude: 7.009800 },
    { latitude: 4.827500, longitude: 7.014200 },
    { latitude: 4.830500, longitude: 7.019000 },
    { latitude: 4.833500, longitude: 7.023000 },
  ],
  // Route 3: Lagos Mainland — Ikorodu Road Expressway (Fadeyi -> Onipanu -> Palm Grove -> Anthony -> Maryland)
  [
    { latitude: 6.541200, longitude: 3.367800 },
    { latitude: 6.546800, longitude: 3.368700 },
    { latitude: 6.552000, longitude: 3.369500 },
    { latitude: 6.558500, longitude: 3.370500 },
    { latitude: 6.565000, longitude: 3.371800 },
    { latitude: 6.572000, longitude: 3.373000 },
  ],
  // Route 4: Victoria Island — Ahmadu Bello Way & Adeola Odeku Main Axis
  [
    { latitude: 6.428500, longitude: 3.421500 },
    { latitude: 6.431200, longitude: 3.428000 },
    { latitude: 6.434500, longitude: 3.435000 },
    { latitude: 6.438000, longitude: 3.442000 },
    { latitude: 6.442000, longitude: 3.450000 },
  ],
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
 * Fetch a realistic road route from TomTom Calculate Route API or verified on-road asphalt paths.
 */
async function fetchTomTomRoute() {
  const apiKey = process.env.TOMTOM_API_KEY || 'rDJMYBeHtsRSNUCkRZr1iFM1EYJqERqb';
  const selectedRoad = VERIFIED_ROAD_ROUTES[Math.floor(Math.random() * VERIFIED_ROAD_ROUTES.length)];
  const startPt = selectedRoad[0];
  const endPt = selectedRoad[selectedRoad.length - 1];

  if (apiKey) {
    try {
      const url = `https://api.tomtom.com/routing/1/calculateRoute/${startPt.latitude},${startPt.longitude}:${endPt.latitude},${endPt.longitude}/json?key=${apiKey}&traffic=false`;
      const res = await axios.get(url, { timeout: 8000 });
      const rawPoints = res.data?.routes?.[0]?.legs?.[0]?.points;

      if (Array.isArray(rawPoints) && rawPoints.length >= 5) {
        logger.info('TOMTOM_ROAD_ROUTE_FETCHED', {
          pointsCount: rawPoints.length,
          start: startPt,
          end: endPt,
        });

        // Sample points closely along the road without skipping sharp corners
        const step = Math.max(1, Math.floor(rawPoints.length / 8));
        const sampled = [];
        for (let i = 0; i < rawPoints.length; i += step) {
          sampled.push({
            latitude: parseFloat(rawPoints[i].latitude.toFixed(6)),
            longitude: parseFloat(rawPoints[i].longitude.toFixed(6)),
          });
          if (sampled.length >= 8) break;
        }

        const last = rawPoints[rawPoints.length - 1];
        sampled[sampled.length - 1] = {
          latitude: parseFloat(last.latitude.toFixed(6)),
          longitude: parseFloat(last.longitude.toFixed(6)),
        };

        return sampled;
      }
    } catch (err) {
      logger.warn('TOMTOM_API_FETCH_FALLBACK_ROAD', { error: err.message });
    }
  }

  // Return verified on-road asphalt coordinates
  return selectedRoad;
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
    intervalSec: 15,
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
    interval: '15 seconds',
  });

  const intervalMs = 15 * 1000; // Emit every 15 seconds

  const emitTelemetryTick = () => {
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
  };

  // Emit first tick immediately, then every 15 seconds
  emitTelemetryTick();
  simState.timerId = setInterval(emitTelemetryTick, intervalMs);

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
