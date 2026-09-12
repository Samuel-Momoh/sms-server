'use strict';

const axios = require('axios');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const { logger } = require('../logger');

// Play rate-limits, and the mobile app calls this on every launch
const CACHE_TTL_MS = parseInt(process.env.PLAY_STORE_CACHE_TTL_MS || '1800000', 10); // 30 minutes
const REQUEST_TIMEOUT_MS = parseInt(process.env.PLAY_STORE_TIMEOUT_MS || '10000', 10);

const cache = new Map();

let googleAuthClient = null;

function getAuthClient() {
  if (!googleAuthClient) {
    const keyFile = path.resolve(__dirname, '../../etrack-b00bb-firebase-adminsdk-fbsvc-ed8b03fa14.json');
    googleAuthClient = new GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  }
  return googleAuthClient;
}

/**
 * Fetch the current production release from the Google Play Developer API.
 */
async function fetchPlayStoreVersion(packageName) {
  const pkg = String(packageName || '').trim();
  if (!pkg) {
    throw new Error('packageName is required to query the Play Store');
  }

  const cacheKey = `${pkg}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  try {
    const auth = getAuthClient();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/tracks/production/releases`;
    
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    // Extract the latest release version code and name
    const releases = response.data?.releases || [];
    // The active release is usually the highest version code or the most recent in the array
    // Filter for completed/inProgress rollouts
    const activeReleases = releases.filter(r => r.status === 'completed' || r.status === 'inProgress');
    
    if (activeReleases.length === 0) {
      throw new Error(`No active production releases found for package '${pkg}'`);
    }

    // Sort by versionCode descending to get the latest
    activeReleases.sort((a, b) => Number(b.versionCode || 0) - Number(a.versionCode || 0));
    
    const latestRelease = activeReleases[0];
    const versionCode = latestRelease.versionCode ? Number(latestRelease.versionCode) : null;
    const versionName = latestRelease.name || null;
    
    const releaseNotes = latestRelease.releaseNotes && latestRelease.releaseNotes.length > 0 
      ? latestRelease.releaseNotes[0].text 
      : null;

    const value = {
      packageName: pkg,
      version: versionName,
      build: versionCode,
      releaseNotes,
      updatedAt: new Date().toISOString(),
      storeUrl: `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`,
      fetchedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, { fetchedAt: Date.now(), value });
    logger.info('PLAY_STORE_VERSION_FETCHED', { packageName: pkg, version: versionName, build: versionCode });

    return { ...value, cached: false };
  } catch (err) {
    logger.warn('PLAY_STORE_API_ERROR', { packageName: pkg, error: err.response?.data?.error?.message || err.message, status: err.response?.status });
    if (err.response?.status === 404) {
      const notFoundErr = new Error(`Package '${pkg}' was not found on the Google Play Developer API`);
      notFoundErr.code = 'PACKAGE_NOT_FOUND';
      throw notFoundErr;
    }
    throw err;
  }
}

/**
 * Drop cached listings so the next lookup hits Play again.
 */
function clearPlayStoreCache() {
  cache.clear();
}

module.exports = {
  fetchPlayStoreVersion,
  clearPlayStoreCache,
};
