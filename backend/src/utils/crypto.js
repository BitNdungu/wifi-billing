const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');

/**
 * Encrypt a string value (for storing API keys, passwords in DB)
 */
const encrypt = (plaintext) => {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

/**
 * Decrypt a previously encrypted string
 */
const decrypt = (ciphertext) => {
  if (!ciphertext) return null;
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

/**
 * Generate a secure random voucher code
 */
const generateVoucherCode = (length = 10) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[bytes[i] % chars.length];
  }
  // Format: XXXXX-XXXXX
  return `${code.slice(0, 5)}-${code.slice(5)}`;
};

/**
 * Generate MikroTik session credentials
 */
const generateSessionCredentials = () => {
  const username = `wb_${crypto.randomBytes(5).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex');
  return { username, password };
};

/**
 * Hash a string (for refresh tokens etc)
 */
const hashString = (str) => {
  return crypto.createHash('sha256').update(str).digest('hex');
};

module.exports = { encrypt, decrypt, generateVoucherCode, generateSessionCredentials, hashString };