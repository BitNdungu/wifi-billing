const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const db = require('../config/database');
const { generateTokens } = require('../middleware/auth.middleware');
const { hashString } = require('../utils/crypto');
const logger = require('../utils/logger');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
});

/**
 * POST /api/auth/login
 */
const login = async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials format' });

  const { email, password } = parsed.data;

  const result = await db.query(
    `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.logo_url, t.theme_color
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1 AND u.is_active = true`,
    [email.toLowerCase()]
  );

  if (!result.rows.length) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { accessToken, refreshToken } = generateTokens(user);

  // Store refresh token hash
  const tokenHash = hashString(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  );

  // Update last login
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  logger.info('User logged in', { userId: user.id, email });

  res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      tenantId: user.tenant_id,
      tenantName: user.tenant_name,
      tenantSlug: user.tenant_slug,
      logoUrl: user.logo_url,
      themeColor: user.theme_color,
    },
  });
};

/**
 * POST /api/auth/refresh
 */
const refreshToken = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) return res.status(400).json({ error: 'Refresh token required' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const tokenHash = hashString(token);
  const result = await db.query(
    'SELECT * FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
    [tokenHash, payload.sub]
  );

  if (!result.rows.length) {
    return res.status(401).json({ error: 'Refresh token not found or expired' });
  }

  const userResult = await db.query(
    'SELECT * FROM users WHERE id = $1 AND is_active = true',
    [payload.sub]
  );

  if (!userResult.rows.length) return res.status(401).json({ error: 'User not found' });

  const user = userResult.rows[0];
  const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

  // Rotate refresh token
  await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
  const newHash = hashString(newRefreshToken);
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, newHash, newExpiry]
  );

  res.json({ accessToken, refreshToken: newRefreshToken });
};

/**
 * POST /api/auth/logout
 */
const logout = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (token) {
    const hash = hashString(token);
    await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
  }
  res.json({ success: true });
};

/**
 * POST /api/auth/register  (platform registration for new tenants)
 */
const register = async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const { name, email, password, phone } = parsed.data;

  const exists = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const passwordHash = await bcrypt.hash(password, 12);

  await db.withTransaction(async (client) => {
    // Create tenant
    const tenantRes = await client.query(
      'INSERT INTO tenants (name, slug, email, phone) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, `${slug}-${Date.now()}`, email.toLowerCase(), phone]
    );
    const tenantId = tenantRes.rows[0].id;

    // Create admin user
    await client.query(
      'INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, email.toLowerCase(), passwordHash, name, 'admin']
    );
  });

  res.status(201).json({ success: true, message: 'Account created. Please log in.' });
};

/**
 * GET /api/auth/me
 */
const getMe = async (req, res) => {
  const { password_hash, ...user } = req.user;
  res.json({ user });
};

module.exports = { login, refreshToken, logout, register, getMe };