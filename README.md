# Kopera — Fintech Backend

Multi-currency fintech platform with wallets, FX, payments, invoicing, loans, KYC/KYB, and a loyalty points system. Built for Latin American markets (Peru-first) with support for SUNAT electronic invoicing (boletas, facturas, notas de crédito/débito).

## Stack

- **Runtime**: Node 20 + TypeScript
- **Framework**: Fastify
- **ORM**: Prisma + PostgreSQL
- **Cache/Sessions**: Redis (ioredis)
- **Payments**: Stripe (gateway abstraction)
- **Testing**: Vitest
- **Package manager**: pnpm (monorepo workspaces)

## Structure

```
qary-backend/
├── backend/          # Main API server
│   ├── src/
│   │   ├── routes/           # REST endpoints (auth, payments, webhooks)
│   │   ├── routes/kopera/    # Fintech routes (wallets, fx, invoices, loans, kyc, points, gateway)
│   │   ├── kopera/services/  # Business logic services
│   │   └── lib/              # Shared utilities (audit, jwt, rate-limit)
│   ├── prisma/               # Schema + migrations
│   └── test/                 # Vitest test suite
├── agents/           # AI agent microservice (intents, STT/TTS)
├── frontend/         # React + Vite + Tailwind
├── mobile/           # Expo + WebView
└── infra/            # docker-compose, terraform
```

## Quick Start

```bash
# 1. Install dependencies
pnpm install
pnpm --filter backend exec prisma generate

# 2. Start services (postgres, redis)
docker compose -f infra/docker-compose.yml up -d

# 3. Database setup
pnpm --filter backend exec prisma migrate dev --name init

# 4. Run dev server
pnpm --filter backend dev    # http://localhost:3000

# 5. Run tests
pnpm --filter backend exec vitest run
```

## API Endpoints

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Register with email, receive OTP |
| POST | `/api/auth/verify-otp` | No | Verify OTP, get access + refresh tokens |
| POST | `/api/auth/refresh` | No | Refresh access token |
| POST | `/api/auth/logout` | Yes | Revoke refresh token |

### Wallets
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/wallets` | Yes | List all wallets with balances |
| POST | `/api/wallets` | Yes | Create a wallet (auto-sets first as default) |
| GET | `/api/wallets/:currency` | Yes | Get wallet balance by currency |
| POST | `/api/wallets/deposit` | Yes | Deposit funds |
| POST | `/api/wallets/withdraw` | Yes | Withdraw funds |
| POST | `/api/wallets/transfer` | Yes | Transfer between users |
| GET | `/api/transactions` | Yes | List transactions (paginated) |

### FX (Foreign Exchange)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/fx/rate/:pair` | No | Get exchange rate (e.g., `USD-PEN`) |
| GET | `/api/fx/pairs` | No | List supported currency pairs |
| POST | `/api/fx/convert` | Yes | Convert currency |
| POST | `/api/fx/quote` | Yes | Get buy/sell quote (valid 30s) |

### Invoicing (SUNAT-compatible)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/invoices` | Yes | Create invoice (BOLETA, FACTURA, RECIBO, etc.) |
| GET | `/api/invoices` | Yes | List invoices |
| GET | `/api/invoices/:id` | Yes | Get invoice by ID |
| POST | `/api/invoices/:id/send` | Yes | Mark invoice as sent |

### Loans
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/loans/simulate` | Yes | Simulate loan (amortization schedule, TCEA) |
| POST | `/api/loans/apply` | Yes | Apply for a loan |
| GET | `/api/loans` | Yes | List user loans |
| GET | `/api/loans/:id` | Yes | Get loan with repayment schedule |
| POST | `/api/loans/:id/approve` | Yes | Approve loan, generate repayment schedule |
| POST | `/api/loans/:id/disburse` | Yes | Disburse approved loan |

### KYC / KYB
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/kyc/start` | Yes | Start identity verification |
| GET | `/api/kyc/status` | Yes | Get KYC status |
| POST | `/api/kyb/register` | Yes | Register a business |
| GET | `/api/kyb/status` | Yes | Get KYB status |

### Points (Loyalty)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/points` | Yes | Get balance, tier, progress to next tier |
| GET | `/api/points/history` | Yes | Get points history |
| POST | `/api/points/redeem` | Yes | Redeem points |

### Notifications
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/notifications` | Yes | List notifications (paginated, filter unread) |
| GET | `/api/notifications/unread-count` | Yes | Get unread notification count |
| POST | `/api/notifications/:id/read` | Yes | Mark notification as read |
| POST | `/api/notifications/read-all` | Yes | Mark all notifications as read |

### Disputes
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/disputes` | Yes | Open a dispute on a payment |
| GET | `/api/disputes` | Yes | List user disputes |
| GET | `/api/disputes/:id` | Yes | Get dispute details |
| POST | `/api/disputes/:id/evidence` | Yes | Submit evidence for a dispute |
| POST | `/api/disputes/:id/escalate` | Yes | Escalate a dispute |

### Subscriptions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/subscriptions` | Yes | Create a recurring subscription |
| GET | `/api/subscriptions` | Yes | List user subscriptions |
| GET | `/api/subscriptions/:id` | Yes | Get subscription details |
| POST | `/api/subscriptions/:id/cancel` | Yes | Cancel a subscription |
| POST | `/api/subscriptions/:id/pause` | Yes | Pause a subscription |
| POST | `/api/subscriptions/:id/resume` | Yes | Resume a paused subscription |

### Payments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/payments/intent` | Yes | Create Stripe payment intent |
| GET | `/api/payments/:id` | Yes | Get payment status |
| POST | `/api/webhooks/stripe` | No | Stripe webhook handler |

## Key Design Decisions

- **BigInt for money**: All monetary amounts stored as `BigInt` in cents/centimos to avoid floating-point errors.
- **Double-entry ledger**: Every wallet operation creates a `LedgerEntry` with `balanceBefore`/`balanceAfter` for auditability.
- **Compound wallet keys**: Wallets are unique per `(userId, currency)`, allowing multi-currency per user.
- **FX rate fallback chain**: DB rates → hardcoded defaults → inverse calculation → USD cross rate.
- **Tiers**: BRONZE → SILVER (1K) → GOLD (5K) → PLATINUM (20K) → DIAMOND (50K) based on lifetime points earned.
- **Invoice series**: Boletas get `B001-NNNNNNNN`, facturas get `F001-NNNNNNNN` (SUNAT format).
- **Auto-earn points**: Wallet deposits and transfers automatically earn loyalty points based on tier multiplier.
- **Dispute lifecycle**: OPENED → EVIDENCE_NEEDED → UNDER_REVIEW → WON/LOST/ACCEPTED with 30-day evidence deadline.
- **Subscription billing**: Supports daily/weekly/monthly/yearly intervals with pause/resume/cancel lifecycle.

## Testing

```bash
# Run all tests
pnpm --filter backend exec vitest run

# Run specific test suite
pnpm --filter backend exec vitest run test/kopera-wallets.test.ts

# Watch mode
pnpm --filter backend exec vitest
```

89 tests across 15 test files covering auth, wallets, FX, invoices, loans (+ admin), KYC/KYB, points (+ auto-earn), payments, voice payments, notifications, disputes, and subscriptions.

## Configuration

Copy `.env.example` to `.env` and set the required values. Never commit `.env`.

Required environment variables:
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `JWT_SECRET` — Secret for JWT signing
- `STRIPE_SECRET_KEY` — Stripe API key
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret

## Security

- Secrets stored only in `.env`, never committed.
- PAN/CVV never stored; only Stripe tokens.
- Rate limiting on auth endpoints.
- Audit log with `request_id` for every sensitive action.
- JWT access tokens (short-lived) + refresh tokens (revocable).
