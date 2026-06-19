const { z } = require('zod');
const db = require('../config/database');
const { generateVoucherCode } = require('../utils/crypto');
const sessionService = require('../services/session.service');
const queueService = require('../services/queue.service');
const logger = require('../utils/logger');

/**
 * POST /api/vouchers/generate
 * Generate a batch of vouchers
 */
const generateVouchers = async (req, res) => {
  const schema = z.object({
    packageId: z.string().uuid(),
    quantity: z.number().int().min(1).max(500),
    batchName: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const { packageId, quantity, batchName, expiresAt } = parsed.data;

  // Verify package belongs to tenant
  const pkgResult = await db.query(
    'SELECT * FROM packages WHERE id = $1 AND tenant_id = $2 AND is_active = true',
    [packageId, req.tenantId]
  );
  if (!pkgResult.rows.length) return res.status(404).json({ error: 'Package not found' });

  const codes = [];
  const values = [];
  let idx = 1;

  for (let i = 0; i < quantity; i++) {
    const code = generateVoucherCode();
    codes.push(code);
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
  }

  const params = [];
  for (let i = 0; i < quantity; i++) {
    params.push(req.tenantId, packageId, codes[i], batchName || null, expiresAt || null);
  }

  const result = await db.query(
    `INSERT INTO vouchers (tenant_id, package_id, code, batch_name, expires_at)
     VALUES ${values.join(',')}
     RETURNING *`,
    params
  );

  logger.info('Vouchers generated', {
    count: quantity,
    packageId,
    tenantId: req.tenantId,
    userId: req.user.id,
  });

  res.status(201).json({
    success: true,
    count: result.rows.length,
    vouchers: result.rows,
    batchName: batchName || null,
  });
};

/**
 * POST /api/vouchers/redeem
 * Redeem a voucher (from captive portal)
 */
const redeemVoucher = async (req, res) => {
  const schema = z.object({
    code: z.string().min(5).max(20),
    routerId: z.string().uuid(),
    deviceMac: z.string().optional(),
    deviceIp: z.string().ip().optional(),
    phone: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid voucher data' });

  const { code, routerId, deviceMac, deviceIp, phone } = parsed.data;
  const tenantId = req.headers['x-tenant-id'] || req.query.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant ID required' });

  const voucherResult = await db.query(
    `SELECT v.*, p.* FROM vouchers v
     LEFT JOIN packages p ON p.id = v.package_id
     WHERE v.code = $1 AND v.tenant_id = $2 AND v.status = 'unused'
       AND (v.expires_at IS NULL OR v.expires_at > NOW())`,
    [code.toUpperCase(), tenantId]
  );

  if (!voucherResult.rows.length) {
    return res.status(404).json({ error: 'Invalid, expired, or already used voucher code' });
  }

  const voucher = voucherResult.rows[0];

  // Verify router
  const routerResult = await db.query(
    'SELECT * FROM routers WHERE id = $1 AND tenant_id = $2',
    [routerId, tenantId]
  );
  if (!routerResult.rows.length) return res.status(404).json({ error: 'Router not found' });
  const router = routerResult.rows[0];

  // Mark voucher as active
  await db.query(
    `UPDATE vouchers SET status='active', redeemed_by_phone=$2, redeemed_at=NOW() WHERE id=$1`,
    [voucher.id, phone]
  );

  // Create session
  const pkg = {
    id: voucher.package_id,
    duration_minutes: voucher.duration_minutes,
    data_mb: voucher.data_mb,
    upload_kbps: voucher.upload_kbps,
    download_kbps: voucher.download_kbps,
    mikrotik_profile: voucher.mikrotik_profile,
    name: voucher.name,
  };

  const session = await sessionService.createSession({
    tenantId,
    routerId,
    packageData: pkg,
    paymentId: null,
    phone,
    deviceMac,
    deviceIp,
    voucherId: voucher.id,
  });

  if (session.expires_at) {
    await queueService.scheduleSessionExpiry(session.id, session.expires_at);
  }

  // Mark voucher expired
  await db.query("UPDATE vouchers SET status='expired' WHERE id=$1", [voucher.id]);

  res.json({
    success: true,
    session: {
      id: session.id,
      username: session.username,
      password: session.password,
      expiresAt: session.expires_at,
    },
  });
};

/**
 * GET /api/vouchers  (admin)
 */
const listVouchers = async (req, res) => {
  const { page = 1, limit = 50, status, packageId, batchName } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [req.tenantId];
  const conditions = ['v.tenant_id = $1'];
  let idx = 2;

  if (status) { conditions.push(`v.status = $${idx++}`); params.push(status); }
  if (packageId) { conditions.push(`v.package_id = $${idx++}`); params.push(packageId); }
  if (batchName) { conditions.push(`v.batch_name = $${idx++}`); params.push(batchName); }

  const where = conditions.join(' AND ');

  const [data, count] = await Promise.all([
    db.query(
      `SELECT v.*, p.name as package_name, p.price
       FROM vouchers v LEFT JOIN packages p ON p.id = v.package_id
       WHERE ${where} ORDER BY v.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    ),
    db.query(`SELECT COUNT(*) FROM vouchers v WHERE ${where}`, params),
  ]);

  res.json({
    vouchers: data.rows,
    total: parseInt(count.rows[0].count),
    page: parseInt(page),
    pages: Math.ceil(parseInt(count.rows[0].count) / parseInt(limit)),
  });
};

/**
 * DELETE /api/vouchers/:id  (revoke)
 */
const revokeVoucher = async (req, res) => {
  const result = await db.query(
    "UPDATE vouchers SET status='revoked' WHERE id=$1 AND tenant_id=$2 AND status='unused' RETURNING id",
    [req.params.id, req.tenantId]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Voucher not found or already used' });
  res.json({ success: true });
};

module.exports = { generateVouchers, redeemVoucher, listVouchers, revokeVoucher };