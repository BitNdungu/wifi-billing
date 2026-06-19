const db = require('../config/database');

/**
 * GET /api/analytics/dashboard
 * Main dashboard stats for admin
 */
const getDashboard = async (req, res) => {
  const { period = '7d' } = req.query;
  const tenantId = req.tenantId;

  const periodMap = { '1d': '1 day', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
  const interval = periodMap[period] || '7 days';

  const [
    revenueStats,
    sessionStats,
    paymentsByDay,
    topPackages,
    routerStats,
    recentPayments,
  ] = await Promise.all([
    // Revenue totals
    db.query(
      `SELECT
         SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as total_revenue,
         COUNT(CASE WHEN status='completed' THEN 1 END) as successful_payments,
         COUNT(CASE WHEN status='failed' THEN 1 END) as failed_payments,
         COUNT(*) as total_transactions
       FROM payments
       WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '${interval}'`,
      [tenantId]
    ),

    // Session stats
    db.query(
      `SELECT
         COUNT(*) as total_sessions,
         COUNT(CASE WHEN status='active' THEN 1 END) as active_sessions,
         AVG(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60)::int as avg_duration_min,
         SUM(bytes_up + bytes_down) as total_data_bytes
       FROM sessions
       WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '${interval}'`,
      [tenantId]
    ),

    // Revenue by day
    db.query(
      `SELECT
         DATE_TRUNC('day', created_at) as date,
         SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as revenue,
         COUNT(CASE WHEN status='completed' THEN 1 END) as transactions
       FROM payments
       WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE_TRUNC('day', created_at)
       ORDER BY date`,
      [tenantId]
    ),

    // Top packages
    db.query(
      `SELECT p.name, p.price, p.type,
              COUNT(py.id) as purchase_count,
              SUM(py.amount) as revenue
       FROM packages p
       LEFT JOIN payments py ON py.package_id=p.id AND py.status='completed'
                             AND py.created_at > NOW() - INTERVAL '${interval}'
                             AND py.tenant_id=$1
       WHERE p.tenant_id=$1
       GROUP BY p.id, p.name, p.price, p.type
       ORDER BY revenue DESC NULLS LAST
       LIMIT 5`,
      [tenantId]
    ),

    // Router stats
    db.query(
      `SELECT r.name, r.location, r.is_online, r.active_users, r.last_seen_at,
              COUNT(CASE WHEN s.status='active' THEN 1 END) as live_sessions
       FROM routers r
       LEFT JOIN sessions s ON s.router_id=r.id AND s.status='active'
       WHERE r.tenant_id=$1
       GROUP BY r.id
       ORDER BY r.name`,
      [tenantId]
    ),

    // Recent payments
    db.query(
      `SELECT p.*, pk.name as package_name
       FROM payments p LEFT JOIN packages pk ON pk.id=p.package_id
       WHERE p.tenant_id=$1
       ORDER BY p.created_at DESC LIMIT 10`,
      [tenantId]
    ),
  ]);

  const r = revenueStats.rows[0];
  const s = sessionStats.rows[0];

  res.json({
    revenue: {
      total: parseFloat(r.total_revenue || 0),
      transactions: parseInt(r.total_transactions),
      successful: parseInt(r.successful_payments),
      failed: parseInt(r.failed_payments),
    },
    sessions: {
      total: parseInt(s.total_sessions),
      active: parseInt(s.active_sessions),
      avgDurationMin: parseInt(s.avg_duration_min || 0),
      totalDataBytes: parseInt(s.total_data_bytes || 0),
    },
    revenueByDay: paymentsByDay.rows,
    topPackages: topPackages.rows,
    routers: routerStats.rows,
    recentPayments: recentPayments.rows,
  });
};

/**
 * GET /api/analytics/revenue
 * Detailed revenue breakdown
 */
const getRevenue = async (req, res) => {
  const { startDate, endDate, groupBy = 'day' } = req.query;
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = endDate || new Date().toISOString();

  const truncMap = { hour: 'hour', day: 'day', week: 'week', month: 'month' };
  const trunc = truncMap[groupBy] || 'day';

  const result = await db.query(
    `SELECT
       DATE_TRUNC('${trunc}', created_at) as period,
       SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as revenue,
       COUNT(CASE WHEN status='completed' THEN 1 END) as count,
       AVG(CASE WHEN status='completed' THEN amount END) as avg_amount
     FROM payments
     WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3
     GROUP BY DATE_TRUNC('${trunc}', created_at)
     ORDER BY period`,
    [req.tenantId, start, end]
  );

  res.json({ data: result.rows });
};

/**
 * GET /api/analytics/usage
 * Data usage stats
 */
const getUsage = async (req, res) => {
  const result = await db.query(
    `SELECT
       r.name as router_name,
       COUNT(s.id) as sessions,
       SUM(s.bytes_up) as bytes_up,
       SUM(s.bytes_down) as bytes_down,
       SUM(s.bytes_up + s.bytes_down) as total_bytes
     FROM sessions s
     LEFT JOIN routers r ON r.id = s.router_id
     WHERE s.tenant_id=$1 AND s.created_at > NOW() - INTERVAL '30 days'
     GROUP BY r.id, r.name
     ORDER BY total_bytes DESC`,
    [req.tenantId]
  );

  res.json({ data: result.rows });
};

module.exports = { getDashboard, getRevenue, getUsage };