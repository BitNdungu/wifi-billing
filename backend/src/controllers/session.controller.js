const db = require('../config/database');
const redis = require('../config/redis');
const logger = require('../utils/logger');
const { generateSessionCredentials } = require('../utils/crypto');
const mikrotik = require('./mikrotik.service');

/**
 * Create a WiFi session after payment confirmation
 */
const createSession = async ({ tenantId, routerId, packageData, paymentId, phone, deviceMac, deviceIp, voucherId = null }) => {
  const { username, password } = generateSessionCredentials();

  // Calculate expiry
  let expiresAt = null;
  if (packageData.duration_minutes) {
    expiresAt = new Date(Date.now() + packageData.duration_minutes * 60 * 1000);
  }

  const result = await db.query(
    `INSERT INTO sessions
       (tenant_id, router_id, package_id, payment_id, voucher_id,
        phone, device_mac, device_ip, username, password, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
     RETURNING *`,
    [tenantId, routerId, packageData.id, paymentId, voucherId,
     phone, deviceMac, deviceIp, username, password, expiresAt]
  );

  const session = result.rows[0];

  // Provision on MikroTik
  try {
    const routerResult = await db.query('SELECT * FROM routers WHERE id = $1', [routerId]);
    const router = routerResult.rows[0];

    if (router) {
      await mikrotik.provisionSession({ router, session, pkg: packageData });
      logger.info('Session provisioned on MikroTik', { sessionId: session.id });
    }
  } catch (error) {
    logger.error('Failed to provision on MikroTik', { sessionId: session.id, error: error.message });
    // Don't fail the session creation; queue for retry
  }

  // Cache session in Redis for fast lookup
  await redis.set(
    `session:mac:${deviceMac}`,
    { sessionId: session.id, username, expiresAt },
    expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : 86400
  );

  // Log analytics event
  await db.query(
    `INSERT INTO analytics_events (tenant_id, event_type, router_id, package_id, duration_s)
     VALUES ($1, 'session_created', $2, $3, $4)`,
    [tenantId, routerId, packageData.id, packageData.duration_minutes ? packageData.duration_minutes * 60 : null]
  );

  return session;
};

/**
 * Terminate a session (by expiry, data limit, or admin action)
 */
const terminateSession = async (sessionId, reason = 'expired') => {
  const sessionResult = await db.query(
    'SELECT s.*, r.* FROM sessions s LEFT JOIN routers r ON r.id = s.router_id WHERE s.id = $1',
    [sessionId]
  );

  if (!sessionResult.rows.length) return false;

  const session = sessionResult.rows[0];

  // Remove from MikroTik
  try {
    if (session.ip_address) { // router ip present
      await mikrotik.terminateSession({ router: session, session });
    }
  } catch (error) {
    logger.error('Failed to terminate MikroTik session', { sessionId, error: error.message });
  }

  // Update DB
  await db.query(
    `UPDATE sessions SET status='terminated', ended_at=NOW(), terminate_reason=$2 WHERE id=$1`,
    [sessionId, reason]
  );

  // Clear Redis cache
  if (session.device_mac) {
    await redis.del(`session:mac:${session.device_mac}`);
  }

  logger.info('Session terminated', { sessionId, reason });
  return true;
};

/**
 * Get active session for a device MAC
 */
const getActiveSessionByMac = async (mac) => {
  // Try Redis first
  const cached = await redis.get(`session:mac:${mac}`);
  if (cached) {
    if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) {
      await redis.del(`session:mac:${mac}`);
      return null;
    }
    return cached;
  }

  // Fallback to DB
  const result = await db.query(
    `SELECT s.*, p.name as package_name, p.duration_minutes, p.data_mb
     FROM sessions s
     LEFT JOIN packages p ON p.id = s.package_id
     WHERE s.device_mac = $1 AND s.status = 'active'
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
     ORDER BY s.created_at DESC LIMIT 1`,
    [mac]
  );

  return result.rows[0] || null;
};

/**
 * Update session data usage from MikroTik polling
 */
const updateSessionUsage = async (sessionId, { bytesUp, bytesDown }) => {
  await db.query(
    `UPDATE sessions SET bytes_up=$2, bytes_down=$3, updated_at=NOW() WHERE id=$1`,
    [sessionId, bytesUp, bytesDown]
  );

  // Check data limit
  const result = await db.query(
    `SELECT s.bytes_up + s.bytes_down as total_bytes, p.data_mb
     FROM sessions s LEFT JOIN packages p ON p.id = s.package_id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (result.rows.length) {
    const { total_bytes, data_mb } = result.rows[0];
    if (data_mb && total_bytes >= data_mb * 1024 * 1024) {
      await terminateSession(sessionId, 'data_limit_reached');
      return { terminated: true, reason: 'data_limit_reached' };
    }
  }

  return { terminated: false };
};

/**
 * Get session list for a tenant (paginated)
 */
const getSessionList = async ({ tenantId, page = 1, limit = 20, status = null, routerId = null }) => {
  const offset = (page - 1) * limit;
  const conditions = ['s.tenant_id = $1'];
  const params = [tenantId];
  let paramIdx = 2;

  if (status) {
    conditions.push(`s.status = $${paramIdx++}`);
    params.push(status);
  }
  if (routerId) {
    conditions.push(`s.router_id = $${paramIdx++}`);
    params.push(routerId);
  }

  const where = conditions.join(' AND ');

  const [dataResult, countResult] = await Promise.all([
    db.query(
      `SELECT s.*, p.name as package_name, p.price, r.name as router_name
       FROM sessions s
       LEFT JOIN packages p ON p.id = s.package_id
       LEFT JOIN routers r ON r.id = s.router_id
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM sessions s WHERE ${where}`, params),
  ]);

  return {
    sessions: dataResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
  };
};

module.exports = {
  createSession,
  terminateSession,
  getActiveSessionByMac,
  updateSessionUsage,
  getSessionList,
};