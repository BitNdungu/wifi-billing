const { z } = require('zod');
const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/crypto');
const mikrotik = require('../services/mikrotik.service');

const routerSchema = z.object({
  name: z.string().min(2),
  location: z.string().optional(),
  ipAddress: z.string().ip(),
  apiPort: z.number().default(8728),
  apiUsername: z.string().min(1),
  apiPassword: z.string().min(1),
  hotspotName: z.string().default('hotspot1'),
});

const listRouters = async (req, res) => {
  const result = await db.query(
    `SELECT id, name, location, ip_address, api_port, api_username, hotspot_name,
            is_online, last_seen_at, firmware_ver, active_users, created_at
     FROM routers WHERE tenant_id=$1 ORDER BY name`,
    [req.tenantId]
  );
  res.json({ routers: result.rows });
};

const getRouter = async (req, res) => {
  const result = await db.query(
    'SELECT * FROM routers WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.tenantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Router not found' });
  const r = result.rows[0];
  delete r.api_password; // never expose
  res.json({ router: r });
};

const createRouter = async (req, res) => {
  const parsed = routerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const { name, location, ipAddress, apiPort, apiUsername, apiPassword, hotspotName } = parsed.data;
  const encryptedPass = encrypt(apiPassword);

  const result = await db.query(
    `INSERT INTO routers (tenant_id, name, location, ip_address, api_port, api_username, api_password, hotspot_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, location, ip_address, api_port, api_username, hotspot_name`,
    [req.tenantId, name, location, ipAddress, apiPort, apiUsername, encryptedPass, hotspotName]
  );

  res.status(201).json({ router: result.rows[0] });
};

const updateRouter = async (req, res) => {
  const parsed = routerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  const { name, location, ipAddress, apiPort, apiUsername, apiPassword, hotspotName } = parsed.data;

  const updates = [];
  const params = [req.params.id, req.tenantId];
  let idx = 3;

  if (name)      { updates.push(`name=$${idx++}`); params.push(name); }
  if (location)  { updates.push(`location=$${idx++}`); params.push(location); }
  if (ipAddress) { updates.push(`ip_address=$${idx++}`); params.push(ipAddress); }
  if (apiPort)   { updates.push(`api_port=$${idx++}`); params.push(apiPort); }
  if (apiUsername) { updates.push(`api_username=$${idx++}`); params.push(apiUsername); }
  if (apiPassword) { updates.push(`api_password=$${idx++}`); params.push(encrypt(apiPassword)); }
  if (hotspotName) { updates.push(`hotspot_name=$${idx++}`); params.push(hotspotName); }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  const result = await db.query(
    `UPDATE routers SET ${updates.join(',')} WHERE id=$1 AND tenant_id=$2 RETURNING id, name`,
    params
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Router not found' });
  res.json({ router: result.rows[0] });
};

const deleteRouter = async (req, res) => {
  await db.query('DELETE FROM routers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({ success: true });
};

/**
 * POST /api/routers/:id/ping
 * Test connectivity to router
 */
const pingRouter = async (req, res) => {
  const result = await db.query(
    'SELECT * FROM routers WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.tenantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Router not found' });

  const router = result.rows[0];
  const { isOnline, info, activeCount } = await mikrotik.healthCheckRouter(router);

  await db.query(
    'UPDATE routers SET is_online=$2, last_seen_at=$3, active_users=$4 WHERE id=$1',
    [router.id, isOnline, isOnline ? new Date() : router.last_seen_at, activeCount]
  );

  res.json({ isOnline, info, activeCount });
};

/**
 * GET /api/routers/:id/active-users
 */
const getActiveUsers = async (req, res) => {
  const result = await db.query(
    'SELECT * FROM routers WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.tenantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Router not found' });

  const client = mikrotik.createClient(result.rows[0]);
  const users = await client.getActiveUsers();
  res.json({ users });
};

/**
 * POST /api/routers/:id/profiles
 * Sync package profiles to MikroTik
 */
const syncProfiles = async (req, res) => {
  const [routerResult, packagesResult] = await Promise.all([
    db.query('SELECT * FROM routers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]),
    db.query('SELECT * FROM packages WHERE tenant_id=$1 AND is_active=true', [req.tenantId]),
  ]);

  if (!routerResult.rows.length) return res.status(404).json({ error: 'Router not found' });

  const router = routerResult.rows[0];
  const client = mikrotik.createClient(router);
  const created = [];

  for (const pkg of packagesResult.rows) {
    const profileName = `wb_${pkg.id.slice(0, 8)}`;
    const rateLimit = pkg.upload_kbps && pkg.download_kbps
      ? `${pkg.upload_kbps}k/${pkg.download_kbps}k`
      : '0/0';

    try {
      await client.createUserProfile({ name: profileName, rateLimit });
      await db.query('UPDATE packages SET mikrotik_profile=$1 WHERE id=$2', [profileName, pkg.id]);
      created.push(profileName);
    } catch (e) {
      // Profile may already exist
    }
  }

  res.json({ success: true, profilesCreated: created });
};

module.exports = {
  listRouters, getRouter, createRouter, updateRouter, deleteRouter,
  pingRouter, getActiveUsers, syncProfiles,
};