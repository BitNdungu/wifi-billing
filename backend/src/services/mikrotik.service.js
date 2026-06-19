const axios = require('axios');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');

/**
 * MikroTik RouterOS REST API client (for RouterOS 7+)
 * Falls back gracefully; older routers can use the legacy API
 */

class MikroTikClient {
  constructor(router) {
    this.router = router;
    this.baseUrl = `http://${router.ip_address}:${router.api_port || 80}/rest`;
    this.username = router.api_username;
    this.password = decrypt(router.api_password);
    this.timeout = parseInt(process.env.MIKROTIK_API_TIMEOUT) || 10000;
    this.hotspotName = router.hotspot_name || 'hotspot1';

    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      auth: { username: this.username, password: this.password },
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Generic REST call
   */
  async request(method, path, data = null) {
    try {
      const config = { method, url: path };
      if (data) config.data = data;
      const response = await this.axiosInstance(config);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data || error.message;
      logger.error('MikroTik API error', {
        routerId: this.router.id,
        path,
        status,
        detail,
      });
      throw new Error(`MikroTik error [${status}]: ${JSON.stringify(detail)}`);
    }
  }

  // ── Hotspot User Management ─────────────────────────────────────────

  /**
   * Add a hotspot user with bandwidth profile
   */
  async addHotspotUser({ username, password, profile = 'default', comment = '' }) {
    const data = {
      name: username,
      password,
      profile,
      comment,
      disabled: 'false',
    };
    const result = await this.request('PUT', '/ip/hotspot/user', data);
    logger.info('MikroTik: hotspot user added', { username, routerId: this.router.id });
    return result;
  }

  /**
   * Remove a hotspot user by username
   */
  async removeHotspotUser(username) {
    // Find user ID first
    const users = await this.request('GET', `/ip/hotspot/user?name=${username}`);
    if (!users || users.length === 0) {
      logger.warn('MikroTik: user not found for removal', { username });
      return false;
    }
    const userId = users[0]['.id'];
    await this.request('DELETE', `/ip/hotspot/user/${userId}`);
    logger.info('MikroTik: hotspot user removed', { username, routerId: this.router.id });

    // Also remove active session if any
    await this.disconnectActiveUser(username);
    return true;
  }

  /**
   * Disconnect an active hotspot session
   */
  async disconnectActiveUser(username) {
    try {
      const active = await this.request('GET', `/ip/hotspot/active?user=${username}`);
      if (active && active.length > 0) {
        const activeId = active[0]['.id'];
        await this.request('DELETE', `/ip/hotspot/active/${activeId}`);
        logger.info('MikroTik: active session disconnected', { username });
      }
    } catch (e) {
      // Not fatal if no active session found
    }
  }

  /**
   * Get active hotspot users (sessions)
   */
  async getActiveUsers() {
    const active = await this.request('GET', '/ip/hotspot/active');
    return (active || []).map((u) => ({
      username: u.user,
      macAddress: u['mac-address'],
      ipAddress: u.address,
      uptime: u.uptime,
      bytesIn: parseInt(u['bytes-in'] || 0),
      bytesOut: parseInt(u['bytes-out'] || 0),
      sessionId: u['.id'],
    }));
  }

  /**
   * Get usage stats for a specific user
   */
  async getUserStats(username) {
    const active = await this.request('GET', `/ip/hotspot/active?user=${username}`);
    if (!active || active.length === 0) return null;
    const u = active[0];
    return {
      uptime: u.uptime,
      bytesIn: parseInt(u['bytes-in'] || 0),
      bytesOut: parseInt(u['bytes-out'] || 0),
      sessionId: u['.id'],
    };
  }

  // ── Bandwidth Profiles ──────────────────────────────────────────────

  /**
   * Create a bandwidth profile (queue) for a package
   */
  async createUserProfile({ name, rateLimit, sessionTimeout = null }) {
    // rateLimit format: "1M/2M" (upload/download)
    const data = {
      name,
      'rate-limit': rateLimit,
    };
    if (sessionTimeout) data['session-timeout'] = sessionTimeout;
    return await this.request('PUT', '/ip/hotspot/user/profile', data);
  }

  /**
   * List all hotspot profiles
   */
  async listProfiles() {
    return await this.request('GET', '/ip/hotspot/user/profile');
  }

  // ── System Info ─────────────────────────────────────────────────────

  /**
   * Get router identity and system info
   */
  async getSystemInfo() {
    const [identity, resource] = await Promise.all([
      this.request('GET', '/system/identity'),
      this.request('GET', '/system/resource'),
    ]);
    return {
      name: identity?.name,
      version: resource?.version,
      uptime: resource?.uptime,
      cpuLoad: resource?.['cpu-load'],
      freeMemory: resource?.['free-memory'],
      totalMemory: resource?.['total-memory'],
      boardName: resource?.['board-name'],
    };
  }

  /**
   * Health check – returns true if reachable
   */
  async ping() {
    try {
      await this.request('GET', '/system/identity');
      return true;
    } catch {
      return false;
    }
  }

  // ── IP Bindings ─────────────────────────────────────────────────────

  /**
   * Bind a MAC address to an IP (to bypass hotspot for specific devices)
   */
  async addIPBinding({ macAddress, type = 'regular', comment = '' }) {
    return await this.request('PUT', '/ip/hotspot/ip-binding', {
      'mac-address': macAddress,
      type,
      comment,
    });
  }

  /**
   * Remove IP binding
   */
  async removeIPBinding(macAddress) {
    const bindings = await this.request('GET', `/ip/hotspot/ip-binding?mac-address=${macAddress}`);
    if (bindings && bindings.length > 0) {
      await this.request('DELETE', `/ip/hotspot/ip-binding/${bindings[0]['.id']}`);
    }
  }
}

/**
 * Factory: create a MikroTik client from a router DB record
 */
const createClient = (router) => new MikroTikClient(router);

/**
 * Provision a new WiFi session on MikroTik
 * Called after payment confirmation
 */
const provisionSession = async ({ router, session, pkg }) => {
  const client = createClient(router);

  // Build rate limit string: e.g. "512k/2M"
  const uploadKbps = pkg.upload_kbps;
  const downloadKbps = pkg.download_kbps;
  let rateLimit = null;
  if (uploadKbps && downloadKbps) {
    rateLimit = `${uploadKbps}k/${downloadKbps}k`;
  }

  // Build session timeout for MikroTik (if time-based)
  let sessionTimeout = null;
  if (pkg.duration_minutes) {
    const h = Math.floor(pkg.duration_minutes / 60);
    const m = pkg.duration_minutes % 60;
    sessionTimeout = `${h}h${m}m`;
  }

  // Use or create profile
  const profileName = pkg.mikrotik_profile || `wb_${pkg.id.slice(0, 8)}`;

  try {
    // Create/ensure profile exists
    const profiles = await client.listProfiles();
    const exists = profiles?.find((p) => p.name === profileName);
    if (!exists) {
      await client.createUserProfile({
        name: profileName,
        rateLimit: rateLimit || '0/0',
        sessionTimeout,
      });
    }
  } catch (e) {
    logger.warn('Could not create MikroTik profile, using default', { error: e.message });
  }

  // Add hotspot user
  await client.addHotspotUser({
    username: session.username,
    password: session.password,
    profile: profileName,
    comment: `WiFiBill:${session.id}`,
  });

  return { profileName };
};

/**
 * Terminate a session on MikroTik
 */
const terminateSession = async ({ router, session }) => {
  const client = createClient(router);
  await client.removeHotspotUser(session.username);
};

/**
 * Check router connectivity and update DB
 */
const healthCheckRouter = async (router) => {
  const client = createClient(router);
  const isOnline = await client.ping();

  if (isOnline) {
    const info = await client.getSystemInfo();
    const active = await client.getActiveUsers();
    return { isOnline: true, info, activeCount: active.length };
  }

  return { isOnline: false, info: null, activeCount: 0 };
};

module.exports = {
  MikroTikClient,
  createClient,
  provisionSession,
  terminateSession,
  healthCheckRouter,
};