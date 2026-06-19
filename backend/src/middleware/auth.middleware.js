const jwt = require('jsonwebtoken');
const db = require('../config/database');
const logger = require('../utils/logger');

/**
 * Verify JWT and attach req.user
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.query(
      `SELECT u.*, t.slug as tenant_slug, t.name as tenant_name
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.is_active = true`,
      [payload.sub]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    req.user = result.rows[0];
    req.tenantId = result.rows[0].tenant_id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Require specific role
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

/**
 * Validate that tenant-scoped resources belong to the requesting tenant
 */
const scopeToTenant = (req, res, next) => {
  // Superadmin can access any tenant
  if (req.user?.role === 'superadmin' && req.query.tenantId) {
    req.tenantId = req.query.tenantId;
  }
  next();
};

/**
 * Generate access + refresh token pair
 */
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role, tenantId: user.tenant_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

module.exports = { authenticate, requireRole, scopeToTenant, generateTokens };