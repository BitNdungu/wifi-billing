# WiFiBill – SaaS Hotspot Billing Platform Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INTERNET / WAN                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │      Nginx Reverse       │
              │    Proxy + SSL/TLS       │
              │    (Let's Encrypt)       │
              └────────────┬────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   ┌─────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  React SPA │  │  Express    │  │  Static     │
   │  Admin     │  │  REST API   │  │  Captive    │
   │  Dashboard │  │  :3001      │  │  Portal     │
   └────────────┘  └──────┬──────┘  └────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
   ┌──────▼──────┐ ┌──────▼──────┐ ┌─────▼──────┐
   │ PostgreSQL  │ │   Redis     │ │  BullMQ    │
   │  :5432      │ │   Cache     │ │  Job Queue │
   └─────────────┘ │   :6379     │ └─────┬──────┘
                   └─────────────┘       │
                                  ┌──────▼──────────────────┐
                                  │   Background Workers    │
                                  │  - Session Expiry       │
                                  │  - Payment Verification │
                                  │  - Usage Monitoring     │
                                  └──────┬──────────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────┐
              │                          │                      │
   ┌──────────▼──────────┐   ┌──────────▼──────────┐  ┌───────▼──────┐
   │  Safaricom Daraja   │   │  MikroTik RouterOS  │  │  SMS Gateway │
   │  M-Pesa STK Push    │   │  API (RADIUS/REST)  │  │  (Africa's   │
   │  OAuth + Callbacks  │   │  HotSpot Control    │  │   Talking)   │
   └─────────────────────┘   └─────────────────────┘  └──────────────┘
```

## Component Breakdown

### 1. Nginx (Reverse Proxy)
- Routes `/api/*` → Express backend
- Routes `/admin/*` → React SPA
- Routes `/portal/*` → Captive portal
- Handles SSL termination via Let's Encrypt
- Rate limiting and DDoS protection

### 2. Express REST API (:3001)
- **Auth**: JWT access tokens + refresh tokens
- **Payments**: Daraja STK Push initiation & callback handling
- **Sessions**: WiFi session lifecycle management
- **Vouchers**: Generation, validation, redemption
- **MikroTik**: Router provisioning and user management
- **Analytics**: Aggregated metrics endpoints
- **Webhooks**: Secure Safaricom callback endpoint

### 3. PostgreSQL (Primary Database)
- Hotspot providers (tenants)
- Packages (time/data based)
- Vouchers and redemptions
- Payment transactions
- Active sessions
- Router configurations
- Analytics events

### 4. Redis + BullMQ (Cache & Queues)
- Session state caching
- Payment status polling jobs
- Router health check scheduling
- Rate limiting counters

### 5. MikroTik Integration
- RouterOS REST API (v7+) or Winbox API (older)
- RADIUS server on router for authentication
- Hotspot user creation/deletion
- Bandwidth profile assignment
- IP binding and ARP management

### 6. Safaricom Daraja
- STK Push (Lipa Na M-Pesa Online)
- OAuth 2.0 token management (auto-refresh)
- Callback URL validation (IP whitelisting)
- Transaction status query (B2C polling)

## Security Architecture

```
Client → Nginx (TLS 1.2+) → Express
                              ├── CORS whitelist
                              ├── Helmet.js headers
                              ├── Rate limiting per IP
                              ├── JWT validation
                              └── Input sanitization (Zod)
```

## Multi-Tenancy Model
Each hotspot provider is a **tenant** with:
- Isolated router configurations
- Branded captive portal
- Separate package catalog
- Own Daraja credentials
- Scoped analytics

## Session Flow

```
Device connects to MikroTik AP
         │
         ▼
MikroTik redirects to Captive Portal
         │
         ▼
User selects package → STK Push sent to phone
         │
         ▼
User confirms on phone
         │
         ▼
Daraja sends callback → Express webhook
         │
         ▼
Payment verified → Session created in DB
         │
         ▼
MikroTik API called → User whitelisted + bandwidth assigned
         │
         ▼
Device gets internet access
         │
         ▼
Session timer/data monitor (BullMQ)
         │
         ▼
Limit reached → MikroTik removes user → Session closed
```