// ════════════════════════════════════════════════════════════════
// package.controller.js
// ════════════════════════════════════════════════════════════════
const { z } = require('zod');
const db = require('../config/database');

const packageSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  type: z.enum(['time', 'data', 'combo']),
  price: z.number().positive(),
  durationMinutes: z.number().int().positive().optional().nullable(),
  dataMb: z.number().int().positive().optional().nullable(),
  uploadKbps: z.number().int().positive().optional().nullable(),
  downloadKbps: z.number().int().positive().optional().nullable(),
  isFeatured: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

const listPackages = async (req, res) => {
  const result = await db.query(
    'SELECT * FROM packages WHERE tenant_id=$1 ORDER BY sort_order, price',
    [req.tenantId]
  );
  res.json({ packages: result.rows });
};

const getPackage = async (req, res) => {
  const result = await db.query(
    'SELECT * FROM packages WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.tenantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Package not found' });
  res.json({ package: result.rows[0] });
};

const createPackage = async (req, res) => {
  const parsed = packageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const d = parsed.data;
  const result = await db.query(
    `INSERT INTO packages (tenant_id, name, description, type, price, duration_minutes, data_mb,
       upload_kbps, download_kbps, is_featured, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.tenantId, d.name, d.description, d.type, d.price, d.durationMinutes,
     d.dataMb, d.uploadKbps, d.downloadKbps, d.isFeatured, d.sortOrder]
  );
  res.status(201).json({ package: result.rows[0] });
};

const updatePackage = async (req, res) => {
  const parsed = packageSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  const d = parsed.data;
  const fields = {
    name: d.name, description: d.description, type: d.type, price: d.price,
    duration_minutes: d.durationMinutes, data_mb: d.dataMb,
    upload_kbps: d.uploadKbps, download_kbps: d.downloadKbps,
    is_featured: d.isFeatured, sort_order: d.sortOrder,
    is_active: d.isActive,
  };
  const updates = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  const sets = updates.map(([k], i) => `${k}=$${i + 3}`).join(',');
  const vals = updates.map(([, v]) => v);

  const result = await db.query(
    `UPDATE packages SET ${sets} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.tenantId, ...vals]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Package not found' });
  res.json({ package: result.rows[0] });
};

const deletePackage = async (req, res) => {
  await db.query(
    'UPDATE packages SET is_active=false WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.tenantId]
  );
  res.json({ success: true });
};

// ════════════════════════════════════════════════════════════════
// session.controller.js
// ════════════════════════════════════════════════════════════════
const sessionService = require('../services/session.service');

const listSessions = async (req, res) => {
  const { page, limit, status, routerId } = req.query;
  const result = await sessionService.getSessionList({
    tenantId: req.tenantId,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    status,
    routerId,
  });
  res.json(result);
};

const terminateSession = async (req, res) => {
  const success = await sessionService.terminateSession(req.params.id, 'admin_terminated');
  if (!success) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true });
};

// ════════════════════════════════════════════════════════════════
// portal.controller.js  – public endpoints for captive portal
// ════════════════════════════════════════════════════════════════
const getPublicPackages = async (req, res) => {
  const tenantResult = await db.query(
    'SELECT id FROM tenants WHERE slug=$1 AND is_active=true', [req.params.tenantSlug]
  );
  if (!tenantResult.rows.length) return res.status(404).json({ error: 'Hotspot not found' });

  const result = await db.query(
    `SELECT id, name, description, type, price, currency, duration_minutes, data_mb,
            upload_kbps, download_kbps, is_featured, sort_order
     FROM packages WHERE tenant_id=$1 AND is_active=true ORDER BY sort_order, price`,
    [tenantResult.rows[0].id]
  );
  res.json({ packages: result.rows });
};

const getTenantInfo = async (req, res) => {
  const result = await db.query(
    'SELECT id, name, slug, logo_url, theme_color FROM tenants WHERE slug=$1 AND is_active=true',
    [req.params.tenantSlug]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ tenant: result.rows[0] });
};

const checkSession = async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ error: 'MAC address required' });
  const session = await sessionService.getActiveSessionByMac(mac);
  res.json({ hasActiveSession: !!session, session });
};

// ════════════════════════════════════════════════════════════════
// settings.controller.js
// ════════════════════════════════════════════════════════════════
const { encrypt } = require('../utils/crypto');

const updateDaraja = async (req, res) => {
  const { consumerKey, consumerSecret, shortcode, passkey, env } = req.body;
  await db.query(
    `UPDATE tenants SET
       daraja_consumer_key=$2, daraja_consumer_secret=$3,
       daraja_shortcode=$4, daraja_passkey=$5, daraja_env=$6
     WHERE id=$1`,
    [req.tenantId, encrypt(consumerKey), encrypt(consumerSecret), shortcode, encrypt(passkey), env]
  );
  res.json({ success: true });
};

const updateBranding = async (req, res) => {
  const { name, phone, logoUrl, themeColor } = req.body;
  await db.query(
    'UPDATE tenants SET name=$2, phone=$3, logo_url=$4, theme_color=$5 WHERE id=$1',
    [req.tenantId, name, phone, logoUrl, themeColor]
  );
  res.json({ success: true });
};

module.exports = {
  // Packages
  listPackages, getPackage, createPackage, updatePackage, deletePackage,
  // Sessions
  listSessions, terminateSession,
  // Portal
  getPublicPackages, getTenantInfo, checkSession,
  // Settings
  updateDaraja, updateBranding,
};