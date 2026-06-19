const axios = require('axios');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');
const db = require('../config/database');
const redis = require('../config/redis');

/**
 * Get Daraja base URL based on environment
 */
const getBaseUrl = (env) =>
  env === 'production'
    ? process.env.DARAJA_PROD_BASE_URL
    : process.env.DARAJA_SANDBOX_BASE_URL;

/**
 * Fetch (or refresh) an OAuth access token for a tenant's Daraja credentials
 * Tokens are cached in Redis for ~55 minutes (they expire at 60m)
 */
const getAccessToken = async (tenant) => {
  const cacheKey = `daraja_token:${tenant.id}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const consumerKey = decrypt(tenant.daraja_consumer_key);
  const consumerSecret = decrypt(tenant.daraja_consumer_secret);

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const baseUrl = getBaseUrl(tenant.daraja_env);

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` },
      timeout: 10000,
    }
  );

  const token = response.data.access_token;
  await redis.set(cacheKey, token, 3300); // 55 minutes
  return token;
};

/**
 * Build the Daraja password for STK Push
 * password = Base64(ShortCode + Passkey + Timestamp)
 */
const buildPassword = (shortcode, passkey, timestamp) => {
  const raw = `${shortcode}${passkey}${timestamp}`;
  return Buffer.from(raw).toString('base64');
};

/**
 * Get current timestamp in Daraja format: YYYYMMDDHHmmss
 */
const getDarajaTimestamp = () => {
  return new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
};

/**
 * Format a Kenyan phone number to international format
 * 0712345678 → 254712345678
 * +254712345678 → 254712345678
 */
const formatKenyanPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('254') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 10) return `254${cleaned.slice(1)}`;
  if (cleaned.startsWith('7') && cleaned.length === 9) return `254${cleaned}`;
  throw new Error(`Invalid Kenyan phone number: ${phone}`);
};

/**
 * Initiate an STK Push (Lipa Na M-Pesa Online)
 */
const initiateSTKPush = async ({ tenant, phone, amount, accountRef, description, paymentId }) => {
  const token = await getAccessToken(tenant);
  const timestamp = getDarajaTimestamp();
  const shortcode = tenant.daraja_shortcode;
  const passkey = decrypt(tenant.daraja_passkey);
  const password = buildPassword(shortcode, passkey, timestamp);
  const formattedPhone = formatKenyanPhone(phone);
  const callbackUrl = `${process.env.DARAJA_CALLBACK_HOST}/api/payments/callback/${tenant.id}`;
  const baseUrl = getBaseUrl(tenant.daraja_env);

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.ceil(amount), // M-Pesa requires whole numbers
    PartyA: formattedPhone,
    PartyB: shortcode,
    PhoneNumber: formattedPhone,
    CallBackURL: callbackUrl,
    AccountReference: accountRef || `WIFI-${paymentId?.slice(0, 8).toUpperCase()}`,
    TransactionDesc: description || 'WiFi Access',
  };

  logger.info('Initiating STK Push', {
    tenantId: tenant.id,
    phone: formattedPhone,
    amount,
    paymentId,
  });

  const response = await axios.post(
    `${baseUrl}/mpesa/stkpush/v1/processrequest`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const { ResponseCode, ResponseDescription, MerchantRequestID, CheckoutRequestID } =
    response.data;

  if (ResponseCode !== '0') {
    throw new Error(`STK Push failed: ${ResponseDescription}`);
  }

  logger.info('STK Push initiated successfully', {
    merchantRequestId: MerchantRequestID,
    checkoutRequestId: CheckoutRequestID,
  });

  return {
    merchantRequestId: MerchantRequestID,
    checkoutRequestId: CheckoutRequestID,
    responseDescription: ResponseDescription,
  };
};

/**
 * Query the status of an STK Push transaction
 */
const querySTKStatus = async ({ tenant, checkoutRequestId }) => {
  const token = await getAccessToken(tenant);
  const timestamp = getDarajaTimestamp();
  const shortcode = tenant.daraja_shortcode;
  const passkey = decrypt(tenant.daraja_passkey);
  const password = buildPassword(shortcode, passkey, timestamp);
  const baseUrl = getBaseUrl(tenant.daraja_env);

  const response = await axios.post(
    `${baseUrl}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  return response.data;
};

/**
 * Process the Daraja callback payload
 * Returns structured payment result
 */
const processCallback = (callbackBody) => {
  const { Body } = callbackBody;
  const { stkCallback } = Body;
  const {
    MerchantRequestID,
    CheckoutRequestID,
    ResultCode,
    ResultDesc,
    CallbackMetadata,
  } = stkCallback;

  const result = {
    merchantRequestId: MerchantRequestID,
    checkoutRequestId: CheckoutRequestID,
    resultCode: ResultCode,
    resultDesc: ResultDesc,
    success: ResultCode === 0,
    mpesaReceiptNumber: null,
    transactionDate: null,
    phoneNumber: null,
    amount: null,
  };

  if (ResultCode === 0 && CallbackMetadata?.Item) {
    const items = CallbackMetadata.Item;
    const find = (name) => items.find((i) => i.Name === name)?.Value;

    result.mpesaReceiptNumber = find('MpesaReceiptNumber');
    result.amount = find('Amount');
    result.phoneNumber = String(find('PhoneNumber'));
    const rawDate = find('TransactionDate');
    if (rawDate) {
      const s = String(rawDate);
      result.transactionDate = new Date(
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`
      );
    }
  }

  return result;
};

module.exports = {
  getAccessToken,
  initiateSTKPush,
  querySTKStatus,
  processCallback,
  formatKenyanPhone,
};