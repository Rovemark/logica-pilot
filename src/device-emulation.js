'use strict';

/**
 * device-emulation.js — Device emulation + GPS spoofing via CDP.
 *
 * Emulates mobile devices (iPhone, iPad, Android) with proper viewport,
 * user agent, touch events and device scale factor. Also allows GPS
 * coordinate override for geolocation-dependent pages.
 */

const DEVICES = {
  'iphone-14': {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'iphone-15-pro': {
    width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  },
  'iphone-se': {
    width: 375, height: 667, deviceScaleFactor: 2, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'ipad': {
    width: 810, height: 1080, deviceScaleFactor: 2, mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'ipad-pro': {
    width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-7': {
    width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Mobile Safari/537.36',
  },
  'samsung-s24': {
    width: 412, height: 915, deviceScaleFactor: 3, mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Mobile Safari/537.36',
  },
  'desktop-1080p': {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Safari/537.36',
  },
  'desktop-mac': {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Safari/537.36',
  },
};

// Aliases for convenience
DEVICES['iphone'] = DEVICES['iphone-14'];
DEVICES['android'] = DEVICES['pixel-7'];
DEVICES['tablet'] = DEVICES['ipad'];

/**
 * Apply device emulation to a page.
 * @param {object} page - CDP page
 * @param {string|object} device - device name or custom { width, height, deviceScaleFactor, mobile, userAgent }
 */
async function emulateDevice(page, device) {
  // reset/clear: drop all device emulation, back to the real desktop viewport.
  if (typeof device === 'string' && /^(reset|clear|off|desktop)$/i.test(device)) {
    await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await page.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    return { ok: true, device: 'reset', reset: true };
  }
  const profile = typeof device === 'string' ? DEVICES[device.toLowerCase()] : device;
  if (!profile) {
    return { ok: false, error: `Unknown device: ${device}. Available: ${Object.keys(DEVICES).join(', ')}, reset` };
  }

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor || 1,
    mobile: !!profile.mobile,
  });

  if (profile.userAgent) {
    await page.send('Emulation.setUserAgentOverride', {
      userAgent: profile.userAgent,
      platform: profile.mobile ? (profile.userAgent.includes('iPhone') ? 'iPhone' : 'Linux armv81') : '',
    });
  }

  if (profile.mobile) {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  return {
    ok: true,
    device: typeof device === 'string' ? device : 'custom',
    width: profile.width,
    height: profile.height,
    mobile: !!profile.mobile,
  };
}

/**
 * Override geolocation coordinates.
 * @param {object} page - CDP page
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} [accuracy=10] - meters
 */
async function setGeolocation(page, latitude, longitude, accuracy = 10) {
  // Grant geolocation permission first
  try {
    const url = await page.eval('location.href').catch(() => 'https://example.com');
    const origin = new URL(url).origin;
    await page.send('Browser.grantPermissions', {
      permissions: ['geolocation'],
      origin,
    }).catch(() => {});
  } catch {}

  await page.send('Emulation.setGeolocationOverride', {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: Number(accuracy) || 10,
  });

  return { ok: true, latitude, longitude, accuracy };
}

/**
 * Clear geolocation override.
 */
async function clearGeolocation(page) {
  await page.send('Emulation.clearGeolocationOverride').catch(() => {});
  return { ok: true };
}

/**
 * List available device profiles.
 */
function listDevices() {
  return Object.entries(DEVICES).map(([name, d]) => ({
    name,
    width: d.width,
    height: d.height,
    mobile: d.mobile,
    scale: d.deviceScaleFactor,
  }));
}

module.exports = { emulateDevice, setGeolocation, clearGeolocation, listDevices, DEVICES };
