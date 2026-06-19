-- ============================================================
-- WiFiBill – Complete PostgreSQL Schema
-- Run in order: 001 → 008
-- ============================================================

-- 001_extensions.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fuzzy search

-- ============================================================
-- 002_tenants.sql  – Hotspot Providers (Multi-tenant)
-- ============================================================
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(100) UNIQUE NOT NULL,  -- subdomain key
  email           VARCHAR(255) UNIQUE NOT NULL,
  phone           VARCHAR(20),
  logo_url        TEXT,
  theme_color     VARCHAR(7) DEFAULT '#16a34a',  -- hex
  -- Daraja credentials (encrypted at app layer)
  daraja_consumer_key     TEXT,
  daraja_consumer_secret  TEXT,
  daraja_shortcode        VARCHAR(20),
  daraja_passkey          TEXT,
  daraja_callback_url     TEXT,
  daraja_env              VARCHAR(10) DEFAULT 'sandbox' CHECK (daraja_env IN ('sandbox','production')),
  -- SMS (Africa's Talking)
  at_api_key      TEXT,
  at_username     VARCHAR(100),
  at_sender_id    VARCHAR(20),
  -- Billing
  plan            VARCHAR(20) DEFAULT 'starter' CHECK (plan IN ('starter','growth','enterprise')),
  plan_expires_at TIMESTAMPTZ,
  commission_rate DECIMAL(5,4) DEFAULT 0.03,  -- 3% platform fee
  -- Status
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- ============================================================
-- 003_users.sql  – Admin users per tenant
-- ============================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           VARCHAR(255) NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(255),
  role            VARCHAR(20) DEFAULT 'admin' CHECK (role IN ('superadmin','admin','viewer')),
  phone           VARCHAR(20),
  last_login_at   TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email  ON users(email);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 004_routers.sql  – MikroTik router registry
-- ============================================================
CREATE TABLE routers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  location        VARCHAR(255),
  ip_address      INET NOT NULL,
  api_port        INTEGER DEFAULT 8728,
  api_username    VARCHAR(100) NOT NULL,
  api_password    TEXT NOT NULL,  -- encrypted
  hotspot_name    VARCHAR(100) DEFAULT 'hotspot1',
  -- Status
  is_online       BOOLEAN DEFAULT FALSE,
  last_seen_at    TIMESTAMPTZ,
  firmware_ver    VARCHAR(50),
  -- Stats (cached from router)
  active_users    INTEGER DEFAULT 0,
  uptime_seconds  BIGINT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_routers_tenant ON routers(tenant_id);

-- ============================================================
-- 005_packages.sql  – Service packages
-- ============================================================
CREATE TABLE packages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  type            VARCHAR(20) NOT NULL CHECK (type IN ('time','data','combo')),
  -- Pricing
  price           DECIMAL(10,2) NOT NULL,
  currency        VARCHAR(3) DEFAULT 'KES',
  -- Time limits (for 'time' and 'combo' types)
  duration_minutes  INTEGER,                    -- NULL = unlimited
  -- Data limits (for 'data' and 'combo' types)
  data_mb           INTEGER,                    -- NULL = unlimited
  -- Bandwidth throttling
  upload_kbps       INTEGER,                    -- NULL = unlimited
  download_kbps     INTEGER,
  -- Sharing
  shared_users      INTEGER DEFAULT 1,          -- devices on one session
  -- Display
  is_featured       BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  sort_order        INTEGER DEFAULT 0,
  -- MikroTik profile reference
  mikrotik_profile  VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_packages_tenant ON packages(tenant_id);

-- ============================================================
-- 006_vouchers.sql
-- ============================================================
CREATE TABLE vouchers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id      UUID NOT NULL REFERENCES packages(id),
  code            VARCHAR(20) NOT NULL UNIQUE,
  batch_name      VARCHAR(100),
  -- Status
  status          VARCHAR(20) DEFAULT 'unused' CHECK (status IN ('unused','active','expired','revoked')),
  -- Redemption
  redeemed_by_phone     VARCHAR(20),
  redeemed_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,  -- NULL = no expiry until used
  -- Generation metadata
  generated_by_user_id  UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_vouchers_code ON vouchers(code);
CREATE INDEX idx_vouchers_tenant     ON vouchers(tenant_id);
CREATE INDEX idx_vouchers_status     ON vouchers(status);

-- ============================================================
-- 007_payments.sql  – M-Pesa transactions
-- ============================================================
CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  package_id            UUID REFERENCES packages(id),
  -- Payer info
  phone                 VARCHAR(20) NOT NULL,
  amount                DECIMAL(10,2) NOT NULL,
  currency              VARCHAR(3) DEFAULT 'KES',
  -- Daraja fields
  merchant_request_id   VARCHAR(100),
  checkout_request_id   VARCHAR(100) UNIQUE,
  mpesa_receipt_number  VARCHAR(50),
  transaction_date      TIMESTAMPTZ,
  -- Status
  status                VARCHAR(20) DEFAULT 'pending'
                          CHECK (status IN ('pending','completed','failed','cancelled','refunded')),
  failure_reason        TEXT,
  -- Metadata
  device_mac            VARCHAR(17),
  router_id             UUID REFERENCES routers(id),
  voucher_id            UUID REFERENCES vouchers(id),
  raw_callback          JSONB,     -- full Daraja callback
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_tenant       ON payments(tenant_id);
CREATE INDEX idx_payments_phone        ON payments(phone);
CREATE INDEX idx_payments_checkout     ON payments(checkout_request_id);
CREATE INDEX idx_payments_receipt      ON payments(mpesa_receipt_number);
CREATE INDEX idx_payments_status       ON payments(status);
CREATE INDEX idx_payments_created      ON payments(created_at DESC);

-- ============================================================
-- 008_sessions.sql  – Active WiFi sessions
-- ============================================================
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  router_id       UUID NOT NULL REFERENCES routers(id),
  package_id      UUID REFERENCES packages(id),
  payment_id      UUID REFERENCES payments(id),
  voucher_id      UUID REFERENCES vouchers(id),
  -- Device / user identity
  phone           VARCHAR(20),
  device_mac      VARCHAR(17),
  device_ip       INET,
  username        VARCHAR(100),  -- MikroTik hotspot username
  password        VARCHAR(100),  -- MikroTik hotspot password
  -- Session window
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  -- Data usage (polled from MikroTik)
  bytes_up        BIGINT DEFAULT 0,
  bytes_down      BIGINT DEFAULT 0,
  -- Status
  status          VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active','expired','terminated','paused')),
  terminate_reason VARCHAR(100),
  -- MikroTik reference
  mikrotik_id     VARCHAR(50),  -- hotspot active user .id
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_tenant      ON sessions(tenant_id);
CREATE INDEX idx_sessions_phone       ON sessions(phone);
CREATE INDEX idx_sessions_mac         ON sessions(device_mac);
CREATE INDEX idx_sessions_status      ON sessions(status);
CREATE INDEX idx_sessions_expires     ON sessions(expires_at);
CREATE INDEX idx_sessions_router      ON sessions(router_id);

-- ============================================================
-- 009_analytics_events.sql  – Time-series analytics
-- ============================================================
CREATE TABLE analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type  VARCHAR(50) NOT NULL,
  -- Common dims
  router_id   UUID REFERENCES routers(id),
  package_id  UUID REFERENCES packages(id),
  -- Metrics
  amount      DECIMAL(10,2),
  duration_s  INTEGER,
  bytes       BIGINT,
  -- Context
  metadata    JSONB DEFAULT '{}',
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_analytics_tenant_time ON analytics_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_analytics_type        ON analytics_events(event_type);

-- ============================================================
-- 010_audit_log.sql
-- ============================================================
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  resource    VARCHAR(100),
  resource_id UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

-- ============================================================
-- Triggers: updated_at auto-maintenance
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','routers','packages','payments','sessions']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t, t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- Seed: superadmin tenant + user
-- ============================================================
INSERT INTO tenants (name, slug, email, daraja_env)
VALUES ('WiFiBill Admin', 'admin', 'superadmin@wifibill.co.ke', 'sandbox')
ON CONFLICT DO NOTHING;

-- Default superadmin password: Admin@2024  (bcrypt hash)
INSERT INTO users (tenant_id, email, password_hash, full_name, role)
SELECT id,
       'admin@wifibill.co.ke',
       '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBpj2oWRk3JE8.',
       'Platform Admin',
       'superadmin'
FROM tenants WHERE slug = 'admin'
ON CONFLICT DO NOTHING;