const fs = require('fs');

const gpsRoutesPath = '/Users/samuelmomoh/sms-gateway-server/src/gpsRoutes.js';
let content = fs.readFileSync(gpsRoutesPath, 'utf8');

// The new logic to inject
const newRoutes = `
// ── Mobile App Version Check (Public — no authentication) ────────────────────

/**
 * Parse a version string such as "v1.12.3-beta" into a numeric segment array [1, 12, 3].
 */
function parseVersion(version) {
  const cleaned = String(version || '').trim().replace(/^v/i, '').split(/[-+ ]/)[0];
  if (!cleaned) return null;
  const parts = cleaned.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

/**
 * Compare two version strings. Returns -1 if a < b, 0 if equal, 1 if a > b, null if unparsable.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * GET /api/gps/app-version
 */
async function handleAppVersionCheck(req, res) {
  const source = { ...(req.query || {}), ...(req.body || {}) };
  const platform = normalizePlatform(source.platform || source.os || source.deviceType || 'android');
  const installedVersion = String(
    source.version || source.installedVersion || source.appVersion || source.current_version || ''
  ).trim();
  const rawBuild = source.build || source.buildNumber || source.build_number || source.versionCode;
  const installedBuild = rawBuild === undefined || rawBuild === null || rawBuild === '' ? null : Number(rawBuild);
  const forceRefresh = source.refresh === 'true' || source.refresh === true;

  try {
    const config = await getAppVersionConfig(platform);

    if (!config) {
      return res.status(404).json({
        success: false,
        error: \`No version record configured for platform '\${platform}'. Supported platforms: android, ios.\`,
      });
    }

    let store = null;
    let storeError = null;
    if (platform === 'android' && config.packageName) {
      try {
        store = await fetchPlayStoreVersion(config.packageName, { force: forceRefresh });
      } catch (err) {
        storeError = err.message;
        logger.warn('PLAY_STORE_API_LOOKUP_FAILED', {
          packageName: config.packageName,
          error: err.message,
        });
      }
    }

    const currentVersion = (store && store.version) || config.latestVersion || null;
    const currentBuild = (store && store.build) || config.latestBuild || null;

    const updatePayload = {};
    if (store && store.version && store.version !== config.latestVersion) updatePayload.latestVersion = store.version;
    if (store && store.build && store.build !== config.latestBuild) updatePayload.latestBuild = store.build;
    if (Object.keys(updatePayload).length > 0) {
      await upsertAppVersionConfig(platform, updatePayload);
    }

    let forceUpgrade = false;
    let needsUpdate = false;

    if (installedVersion) {
      const vsMinimum = compareVersions(installedVersion, config.minimumVersion);
      if (vsMinimum !== null && vsMinimum < 0) forceUpgrade = true;

      const vsCurrent = compareVersions(installedVersion, currentVersion);
      if (vsCurrent !== null && vsCurrent < 0) needsUpdate = true;
    }

    if (Number.isFinite(installedBuild)) {
      if (Number.isFinite(config.minimumBuild) && installedBuild < config.minimumBuild) forceUpgrade = true;
      if (Number.isFinite(currentBuild) && installedBuild < currentBuild) needsUpdate = true;
    }

    if (forceUpgrade) needsUpdate = true;

    return res.json({
      success: true,
      platform,
      packageName: config.packageName || null,

      currentVersion,
      currentBuild,
      source: store && store.version ? 'google-play-api' : 'database',
      storeCheckedAt: store ? store.fetchedAt : null,
      storeError,

      minimumVersion: config.minimumVersion,
      minimumBuild: config.minimumBuild,

      installedVersion: installedVersion || null,
      installedBuild: Number.isFinite(installedBuild) ? installedBuild : null,

      forceUpgrade,
      needsUpdate,
    });

  } catch (err) {
    logger.error('APP_VERSION_CHECK_FAILED', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

router.get('/app-version', handleAppVersionCheck);
router.put('/app-version', handleAppVersionCheck);
router.post('/app-version/check', handleAppVersionCheck);
router.get('/app-version/:platform', handleAppVersionCheck);
router.put('/app-version/:platform', handleAppVersionCheck);

`;

// Replace it right before "// ── GET /api/gps/devices"
const targetStr = "// ── GET /api/gps/devices ──────────────────────────────────────────────────────";
if (content.includes(targetStr)) {
  content = content.replace(targetStr, newRoutes + targetStr);
  fs.writeFileSync(gpsRoutesPath, content, 'utf8');
  console.log("Successfully injected app-version routes.");
} else {
  console.log("Could not find target string to inject.");
}
