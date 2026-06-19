const { Queue, Worker, QueueScheduler } = require('bullmq');
const db = require('../config/database');
const redis = require('../config/redis');
const logger = require('../utils/logger');
const sessionService = require('../services/session.service');
const mikrotik = require('../services/mikrotik.service');
const daraja = require('../services/daraja.service');

const connection = {
  host: new URL(process.env.REDIS_URL || 'redis://localhost:6379').hostname,
  port: parseInt(new URL(process.env.REDIS_URL || 'redis://localhost:6379').port) || 6379,
};

// ── Queue Definitions ────────────────────────────────────────────────────────

const sessionExpiryQueue    = new Queue('session-expiry',    { connection });
const paymentPollQueue      = new Queue('payment-poll',      { connection });
const routerHealthQueue     = new Queue('router-health',     { connection });
const usageMonitorQueue     = new Queue('usage-monitor',     { connection });

// ── Workers ──────────────────────────────────────────────────────────────────

/**
 * Session expiry worker: terminates sessions that have passed their expiry time
 */
const sessionExpiryWorker = new Worker(
  'session-expiry',
  async (job) => {
    const { sessionId } = job.data;
    logger.info('Processing session expiry', { sessionId });
    await sessionService.terminateSession(sessionId, 'time_expired');
  },
  { connection, concurrency: 10 }
);

/**
 * Payment poll worker: poll Daraja for pending payments not yet confirmed
 */
const paymentPollWorker = new Worker(
  'payment-poll',
  async (job) => {
    const { paymentId, checkoutRequestId, tenantId, attempt = 1 } = job.data;
    const MAX_ATTEMPTS = 6;

    const paymentResult = await db.query(
      'SELECT * FROM payments WHERE id = $1',
      [paymentId]
    );
    const payment = paymentResult.rows[0];
    if (!payment || payment.status !== 'pending') return; // already resolved

    const tenantResult = await db.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = tenantResult.rows[0];

    try {
      const status = await daraja.querySTKStatus({ tenant, checkoutRequestId });
      if (status.ResultCode === 0) {
        logger.info('Payment confirmed via polling', { paymentId });
        // The callback usually handles this; this is a fallback
      } else if (status.ResultCode === 1037) {
        // DS timeout – user didn't respond
        await db.query(
          "UPDATE payments SET status='cancelled', failure_reason=$2 WHERE id=$1",
          [paymentId, 'User did not respond to STK Push']
        );
      } else if (attempt < MAX_ATTEMPTS) {
        // Re-queue with backoff
        await paymentPollQueue.add('poll', job.data, {
          delay: attempt * 15000, // 15s, 30s, 45s, ...
          jobId: `poll-${paymentId}-${attempt + 1}`,
        });
      } else {
        await db.query(
          "UPDATE payments SET status='failed', failure_reason=$2 WHERE id=$1",
          [paymentId, 'Payment verification timed out']
        );
      }
    } catch (error) {
      logger.error('Payment poll error', { paymentId, error: error.message });
    }
  },
  { connection, concurrency: 5 }
);

/**
 * Router health check worker
 */
const routerHealthWorker = new Worker(
  'router-health',
  async (job) => {
    const { routerId } = job.data;

    const result = await db.query('SELECT * FROM routers WHERE id = $1', [routerId]);
    if (!result.rows.length) return;

    const router = result.rows[0];
    const { isOnline, info, activeCount } = await mikrotik.healthCheckRouter(router);

    await db.query(
      `UPDATE routers
       SET is_online=$2, last_seen_at=$3, active_users=$4,
           firmware_ver=$5, updated_at=NOW()
       WHERE id=$1`,
      [routerId, isOnline, isOnline ? new Date() : router.last_seen_at, activeCount, info?.version]
    );
  },
  { connection, concurrency: 5 }
);

/**
 * Usage monitor: poll active sessions for data consumption
 */
const usageMonitorWorker = new Worker(
  'usage-monitor',
  async (job) => {
    const { sessionId } = job.data;

    const result = await db.query(
      `SELECT s.*, r.ip_address, r.api_port, r.api_username, r.api_password, r.hotspot_name
       FROM sessions s LEFT JOIN routers r ON r.id = s.router_id
       WHERE s.id = $1 AND s.status = 'active'`,
      [sessionId]
    );

    if (!result.rows.length) return;
    const session = result.rows[0];

    try {
      const client = mikrotik.createClient({ ...session, id: session.router_id });
      const stats = await client.getUserStats(session.username);
      if (stats) {
        const terminated = await sessionService.updateSessionUsage(sessionId, {
          bytesUp: stats.bytesIn,
          bytesDown: stats.bytesOut,
        });
        if (terminated.terminated) {
          logger.info('Session terminated due to data limit', { sessionId });
          return;
        }
      }
    } catch (error) {
      logger.error('Usage monitor error', { sessionId, error: error.message });
    }
  },
  { connection, concurrency: 10 }
);

// ── Recurring scheduler ──────────────────────────────────────────────────────

const scheduleRecurringJobs = async () => {
  // Health check all routers every 2 minutes
  routerHealthQueue.add(
    'sweep-all',
    { type: 'sweep' },
    { repeat: { every: 120000 }, jobId: 'router-health-sweep' }
  );

  // Usage monitoring every 30 seconds
  usageMonitorQueue.add(
    'sweep-active',
    { type: 'sweep' },
    { repeat: { every: 30000 }, jobId: 'usage-monitor-sweep' }
  );

  logger.info('Recurring jobs scheduled');
};

/**
 * Schedule a session expiry job
 */
const scheduleSessionExpiry = async (sessionId, expiresAt) => {
  if (!expiresAt) return;
  const delay = new Date(expiresAt).getTime() - Date.now();
  if (delay <= 0) {
    await sessionService.terminateSession(sessionId, 'already_expired');
    return;
  }
  await sessionExpiryQueue.add('expire', { sessionId }, {
    delay,
    jobId: `expire-${sessionId}`,
    removeOnComplete: true,
    removeOnFail: false,
  });
};

/**
 * Schedule payment status polling
 */
const schedulePaymentPoll = async ({ paymentId, checkoutRequestId, tenantId }) => {
  await paymentPollQueue.add('poll', {
    paymentId, checkoutRequestId, tenantId, attempt: 1,
  }, {
    delay: 15000, // first check after 15s
    jobId: `poll-${paymentId}-1`,
    removeOnComplete: true,
  });
};

// Worker error handlers
[sessionExpiryWorker, paymentPollWorker, routerHealthWorker, usageMonitorWorker].forEach((w) => {
  w.on('failed', (job, err) => {
    logger.error(`Worker job failed: ${w.name}`, { jobId: job?.id, error: err.message });
  });
});

module.exports = {
  sessionExpiryQueue,
  paymentPollQueue,
  routerHealthQueue,
  usageMonitorQueue,
  scheduleSessionExpiry,
  schedulePaymentPoll,
  scheduleRecurringJobs,
};