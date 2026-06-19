const { z } = require('zod');
const db = require('../config/database');
const daraja = require('../services/daraja.service');
const sessionService = require('../services/session.service');
const queueService = require('../services/queue.service');
const logger = require('../utils/logger');

// ── Validation Schemas ───────────────────────────────────────────────────────

const initiateSchema = z.object({
  phone: z.string().min(9).max(13),
  packageId: z.string().uuid(),
  routerId: z.string().uuid(),
  deviceMac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/).optional(),
  deviceIp: z.string().ip().optional(),
});

// ── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/payments/initiate
 * Initiate STK Push payment for a package
 */
const initiatePayment = async (req, res) => {
  const parsed = initiateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const { phone, packageId, routerId, deviceMac, deviceIp } = parsed.data;

  // Get tenant (from portal context – tenantId in header or query)
  const tenantId = req.headers['x-tenant-id'] || req.query.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'Tenant ID required' });

  // Load package and tenant
  const [pkgResult, tenantResult, routerResult] = await Promise.all([
    db.query('SELECT * FROM packages WHERE id = $1 AND tenant_id = $2 AND is_active = true', [packageId, tenantId]),
    db.query('SELECT * FROM tenants WHERE id = $1 AND is_active = true', [tenantId]),
    db.query('SELECT * FROM routers WHERE id = $1 AND tenant_id = $2', [routerId, tenantId]),
  ]);

  if (!pkgResult.rows.length)    return res.status(404).json({ error: 'Package not found' });
  if (!tenantResult.rows.length) return res.status(404).json({ error: 'Tenant not found' });
  if (!routerResult.rows.length) return res.status(404).json({ error: 'Router not found' });

  const pkg    = pkgResult.rows[0];
  const tenant = tenantResult.rows[0];

  // Check Daraja credentials
  if (!tenant.daraja_consumer_key || !tenant.daraja_shortcode) {
    return res.status(503).json({ error: 'Payment gateway not configured for this hotspot' });
  }

  // Create pending payment record
  const paymentResult = await db.query(
    `INSERT INTO payments (tenant_id, package_id, phone, amount, currency, device_mac, router_id, status)
     VALUES ($1, $2, $3, $4, 'KES', $5, $6, 'pending')
     RETURNING *`,
    [tenantId, packageId, phone, pkg.price, deviceMac, routerId]
  );
  const payment = paymentResult.rows[0];

  // Fire STK Push
  let stkResult;
  try {
    stkResult = await daraja.initiateSTKPush({
      tenant,
      phone,
      amount: pkg.price,
      accountRef: `WIFI-${payment.id.slice(0, 8).toUpperCase()}`,
      description: `${pkg.name} - WiFi Access`,
      paymentId: payment.id,
    });
  } catch (error) {
    await db.query(
      "UPDATE payments SET status='failed', failure_reason=$2 WHERE id=$1",
      [payment.id, error.message]
    );
    logger.error('STK Push initiation failed', { paymentId: payment.id, error: error.message });
    return res.status(502).json({ error: 'Failed to initiate payment. Please try again.' });
  }

  // Store Daraja references
  await db.query(
    `UPDATE payments SET merchant_request_id=$2, checkout_request_id=$3 WHERE id=$1`,
    [payment.id, stkResult.merchantRequestId, stkResult.checkoutRequestId]
  );

  // Schedule polling fallback
  await queueService.schedulePaymentPoll({
    paymentId: payment.id,
    checkoutRequestId: stkResult.checkoutRequestId,
    tenantId,
  });

  res.json({
    success: true,
    paymentId: payment.id,
    checkoutRequestId: stkResult.checkoutRequestId,
    message: 'STK Push sent. Please check your phone and enter your M-Pesa PIN.',
  });
};

/**
 * POST /api/payments/callback/:tenantId
 * Daraja callback endpoint (called by Safaricom servers)
 */
const handleCallback = async (req, res) => {
  const { tenantId } = req.params;

  // Always respond 200 immediately to Safaricom
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  // Process asynchronously
  setImmediate(async () => {
    try {
      const callbackData = daraja.processCallback(req.body);
      const { checkoutRequestId, success, mpesaReceiptNumber, transactionDate, phoneNumber, amount, resultDesc } = callbackData;

      const paymentResult = await db.query(
        'SELECT * FROM payments WHERE checkout_request_id = $1 AND tenant_id = $2',
        [checkoutRequestId, tenantId]
      );

      if (!paymentResult.rows.length) {
        logger.warn('Callback received for unknown checkout request', { checkoutRequestId, tenantId });
        return;
      }

      const payment = paymentResult.rows[0];

      if (!success) {
        await db.query(
          "UPDATE payments SET status='failed', failure_reason=$2, raw_callback=$3 WHERE id=$1",
          [payment.id, resultDesc, JSON.stringify(req.body)]
        );
        logger.info('Payment failed via callback', { paymentId: payment.id, reason: resultDesc });
        return;
      }

      // Mark payment completed
      await db.query(
        `UPDATE payments
         SET status='completed', mpesa_receipt_number=$2, transaction_date=$3, raw_callback=$4
         WHERE id=$1`,
        [payment.id, mpesaReceiptNumber, transactionDate, JSON.stringify(req.body)]
      );

      // Load package and router
      const [pkgResult, routerResult] = await Promise.all([
        db.query('SELECT * FROM packages WHERE id = $1', [payment.package_id]),
        db.query('SELECT * FROM routers WHERE id = $1', [payment.router_id]),
      ]);

      const pkg    = pkgResult.rows[0];
      const router = routerResult.rows[0];

      if (!pkg || !router) {
        logger.error('Package or router not found during callback', { paymentId: payment.id });
        return;
      }

      // Create session
      const session = await sessionService.createSession({
        tenantId,
        routerId: payment.router_id,
        packageData: pkg,
        paymentId: payment.id,
        phone: payment.phone || phoneNumber,
        deviceMac: payment.device_mac,
        deviceIp: null,
      });

      // Schedule session expiry
      if (session.expires_at) {
        await queueService.scheduleSessionExpiry(session.id, session.expires_at);
      }

      // Log analytics
      await db.query(
        `INSERT INTO analytics_events (tenant_id, event_type, router_id, package_id, amount)
         VALUES ($1, 'payment_completed', $2, $3, $4)`,
        [tenantId, payment.router_id, payment.package_id, payment.amount]
      );

      logger.info('Payment processed and session created', {
        paymentId: payment.id,
        sessionId: session.id,
        mpesaReceipt: mpesaReceiptNumber,
      });
    } catch (error) {
      logger.error('Callback processing error', { error: error.message, body: req.body });
    }
  });
};

/**
 * GET /api/payments/:paymentId/status
 * Poll payment status (from captive portal)
 */
const getPaymentStatus = async (req, res) => {
  const { paymentId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || req.query.tenantId;

  const result = await db.query(
    `SELECT p.*, s.id as session_id, s.username, s.password, s.expires_at
     FROM payments p
     LEFT JOIN sessions s ON s.payment_id = p.id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [paymentId, tenantId]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const payment = result.rows[0];

  res.json({
    paymentId: payment.id,
    status: payment.status,
    amount: payment.amount,
    mpesaReceipt: payment.mpesa_receipt_number,
    sessionId: payment.session_id,
    sessionCredentials: payment.session_id
      ? { username: payment.username, password: payment.password, expiresAt: payment.expires_at }
      : null,
  });
};

/**
 * GET /api/payments (admin)
 */
const listPayments = async (req, res) => {
  const { page = 1, limit = 20, status, startDate, endDate } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [req.tenantId];
  const conditions = ['p.tenant_id = $1'];
  let idx = 2;

  if (status) { conditions.push(`p.status = $${idx++}`); params.push(status); }
  if (startDate) { conditions.push(`p.created_at >= $${idx++}`); params.push(startDate); }
  if (endDate) { conditions.push(`p.created_at <= $${idx++}`); params.push(endDate); }

  const where = conditions.join(' AND ');

  const [data, count] = await Promise.all([
    db.query(
      `SELECT p.*, pk.name as package_name, r.name as router_name
       FROM payments p
       LEFT JOIN packages pk ON pk.id = p.package_id
       LEFT JOIN routers r ON r.id = p.router_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, parseInt(limit), offset]
    ),
    db.query(`SELECT COUNT(*), SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as revenue FROM payments p WHERE ${where}`, params),
  ]);

  res.json({
    payments: data.rows,
    total: parseInt(count.rows[0].count),
    revenue: parseFloat(count.rows[0].revenue || 0),
    page: parseInt(page),
    pages: Math.ceil(parseInt(count.rows[0].count) / parseInt(limit)),
  });
};

module.exports = { initiatePayment, handleCallback, getPaymentStatus, listPayments };