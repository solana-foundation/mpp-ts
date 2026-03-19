<p align="center">
  <img src="assets/banner.png" alt="MPP" width="100%" />
</p>

# solana-mpp-sdk

Solana payment method for the [Machine Payments Protocol](https://mpp.dev).

**MPP** is [an open protocol proposal](https://paymentauth.org) that lets any HTTP API accept payments using the `402 Payment Required` flow.

> [!IMPORTANT]
> This repository is under active development. The [Solana MPP spec](https://github.com/tempoxyz/mpp-specs/pull/188) is not yet finalized — APIs and wire formats are subject to change.

## Features

**Charge** (one-time payments)
- Native SOL and SPL token transfers (USDC, PYUSD, Token-2022, etc.)
- Two settlement flows: server-broadcast (`type="transaction"`, default) and client-broadcast (`type="signature"`)
- Fee sponsorship: server pays transaction fees on behalf of clients
- Replay protection via consumed transaction signatures

**Session** (metered / streaming payments)
- Voucher-based payment channels with monotonic cumulative amounts
- Multiple authorization modes: `unbounded`, `regular_budget`, `swig_session`
- Auto-open, auto-topup, and close lifecycle
- [Swig](https://build.onswig.com) smart wallet integration for on-chain spend limits

**General**
- Works with [ConnectorKit](https://www.connectorkit.dev) and `@solana/kit` keypair signers
- Server pre-fetches `recentBlockhash` to save client an RPC round-trip
- Transaction simulation before broadcast to prevent wasted fees

## Architecture

```
solana-mpp-sdk/
├── sdk/src/
│   ├── Methods.ts              # Shared charge + session schemas
│   ├── constants.ts            # Token programs, USDC mints, RPC URLs
│   ├── server/
│   │   ├── Charge.ts           # Server: challenge, verify, broadcast
│   │   └── Session.ts          # Server: session channel management
│   ├── client/
│   │   ├── Charge.ts           # Client: build tx, sign, send
│   │   └── Session.ts          # Client: session lifecycle
│   └── session/
│       ├── Types.ts            # Session types and interfaces
│       ├── Voucher.ts          # Voucher signing and verification
│       ├── ChannelStore.ts     # Persistent channel state
│       └── authorizers/        # Pluggable authorization strategies
│           ├── UnboundedAuthorizer.ts
│           ├── BudgetAuthorizer.ts
│           └── SwigSessionAuthorizer.ts
├── examples/
│   ├── server.ts               # USDC-gated API
│   └── client.ts               # Headless client with keypair
└── demo/                       # Interactive playground (see demo/README.md)
```

**Exports:**
- `solana-mpp-sdk` — shared schemas, session types, and authorizers
- `solana-mpp-sdk/server` — server-side charge + session, `Mppx`, `Store`
- `solana-mpp-sdk/client` — client-side charge + session, `Mppx`

## Quick Start

### Charge (one-time payment)

**Server:**

```ts
import { Mppx, solana } from 'solana-mpp-sdk/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    solana.charge({
      recipient: 'RecipientPubkey...',
      splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    }),
  ],
})

const result = await mppx.charge({
  amount: '1000000', // 1 USDC
  currency: 'USDC',
})(request)

if (result.status === 402) return result.challenge
return result.withReceipt(Response.json({ data: '...' }))
```

**Client:**

```ts
import { Mppx, solana } from 'solana-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [solana.charge({ signer })], // any TransactionSigner
})

const response = await mppx.fetch('https://api.example.com/paid-endpoint')
```

### Session (metered payments)

**Server:**

```ts
import { Mppx, solana } from 'solana-mpp-sdk/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    solana.session({
      recipient: 'RecipientPubkey...',
      asset: { kind: 'sol', decimals: 9 },
      channelProgram: 'ChannelProgramId...',
      pricing: { unit: 'request', amountPerUnit: '10', meter: 'api_calls' },
      sessionDefaults: { suggestedDeposit: '1000', ttlSeconds: 60 },
    }),
  ],
})
```

**Client:**

```ts
import { Mppx, solana } from 'solana-mpp-sdk/client'
import { UnboundedAuthorizer } from 'solana-mpp-sdk'

const mppx = Mppx.create({
  methods: [
    solana.session({
      signer,
      authorizer: new UnboundedAuthorizer({ signer, buildOpenTx, buildTopupTx }),
    }),
  ],
})

const response = await mppx.fetch('https://api.example.com/metered-endpoint')
```

### Fee Sponsorship (charge)

The server can pay transaction fees on behalf of clients:

```ts
// Server — pass a KeyPairSigner to cover fees
solana.charge({
  recipient: '...',
  signer: feePayerSigner, // server's KeyPairSigner
})

// Client — no changes needed, fee payer is handled automatically
```

## How It Works

### Charge Flow

1. Client requests a resource
2. Server returns **402 Payment Required** with a challenge (`recipient`, `amount`, `currency`, `recentBlockhash`)
3. Client builds and signs a Solana transfer transaction
4. Server simulates, broadcasts, confirms on-chain, and verifies the transfer
5. Server returns the resource with a `Payment-Receipt` header

With fee sponsorship, the client partially signs (transfer authority only) and the server co-signs as fee payer before broadcasting.

### Session Flow

1. First request: server returns 402, client opens a channel (deposit + voucher)
2. Subsequent requests: client sends updated vouchers with monotonic cumulative amounts
3. Server deducts from the channel balance per its pricing config
4. When balance runs low: client tops up the channel
5. On close: final voucher settles the channel

## Demo

An interactive playground with a React frontend and Express backend, running against [Surfpool](https://surfpool.run).

- Charge flow demo: `http://localhost:5173/playground`
- Swig session demo: `http://localhost:5173/swig`

```bash
surfpool start
npm run demo:install
npm run demo:server
npm run demo:app
```

See [demo/README.md](demo/README.md) for full details.

## Development

```bash
npm install

npm run typecheck          # TypeScript check
npm test                   # Unit tests (charge + session, no network)
npm run test:session       # Session unit tests only
npm run test:integration   # Integration tests (requires Surfpool)
npm run test:all           # All tests
```

## Spec

This SDK implements the [Solana Charge Intent](https://github.com/tempoxyz/mpp-specs/pull/188) for the [HTTP Payment Authentication Scheme](https://paymentauth.org).

Session method docs and implementation notes:

- [docs/methods/sessions.md](docs/methods/sessions.md)

## License

MIT
