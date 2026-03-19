# Session Method (Solana MPP)

This document explains the Solana `session` method in this SDK, how it maps to the MPP flow, and why the current implementation is Swig-focused for on-chain policy enforcement.

## What the session method is

`charge` is a one-shot payment per request.

`session` is a multi-step channel flow where a client:

1. opens a channel with a deposit,
2. updates a signed cumulative voucher over time,
3. optionally tops up,
4. closes when finished.

This is useful when a client calls the same paid API repeatedly and needs lower overhead than signing a full transfer every request.

## Why this implementation uses Swig

The main reason is policy enforcement quality.

- Off-chain-only budgets are easy to bypass if a client is misconfigured or malicious.
- Swig role state lets the SDK validate spend permissions and limits from chain data.
- Session delegation (`swig_session`) lets apps use short-lived delegated keys while still validating against the parent wallet role.

In short, Swig gives cryptographic, on-chain constraints for budgets and delegated sessions, not only local process checks.

## Method surface

Shared method schema:

- `sdk/src/Methods.ts` (`session`)

Client entry points:

- `solana-mpp-sdk/client` -> `solana.session(...)`
- `sdk/src/client/Session.ts`

Server entry points:

- `solana-mpp-sdk/server` -> `solana.session(...)`
- `sdk/src/server/Session.ts`

Authorizers:

- `SwigSessionAuthorizer` (`swig_session`)
- `BudgetAuthorizer` (`regular_budget`, now Swig role-backed)
- `UnboundedAuthorizer` (`regular_unbounded`)

## Session lifecycle

Credential actions:

- `open`
- `update`
- `topup`
- `close`

High level flow:

1. Client requests protected endpoint.
2. Server returns `402 Payment Required` challenge with session request metadata.
3. Client authorizer creates credential payload for one of the actions.
4. Server verifies voucher, challenge binding, and channel invariants.
5. Server returns paid response (or `204` for management actions like `topup` and `close`).

`close` payloads can optionally include `closeTx`, an on-chain settlement transaction reference.

## Server behavior and checks

The server session method (`sdk/src/server/Session.ts`) verifies:

- voucher signature and `signatureType`
- `channelId`, `payer`, `recipient`, `channelProgram`, `chainId`
- `serverNonce` challenge binding
- monotonic `sequence` and cumulative amount
- cumulative amount does not exceed deposit
- optional expiration (`expiresAt`) with skew allowance
- accepted authorization modes (`verifier.acceptAuthorizationModes`)

Optional hooks for stronger on-chain checks:

- `transactionVerifier.verifyOpen(channelId, openTx, deposit)`
- `transactionVerifier.verifyTopup(channelId, topupTx, amount)`
- `transactionVerifier.verifyClose(channelId, closeTx, finalCumulativeAmount)`

Use these hooks to ensure `openTx`, `topupTx`, and `closeTx` are real confirmed transactions with expected semantics.

## Client behavior

The client session method (`sdk/src/client/Session.ts`) supports:

- `autoOpen` (default `true`)
- `autoTopup` (default `false`)
- progress callbacks (`challenge`, `opening`, `opened`, `updating`, `updated`, `closing`, `closed`)

Explicit control via context is supported, for example:

```ts
await mppx.fetch(url, { context: { action: "close" } });
```

## Authorizer modes

### `swig_session` (SwigSessionAuthorizer)

Designed for delegated session keys.

Open-time behavior:

- loads Swig SDK and fetches on-chain Swig account
- resolves the role for the delegated session key
- validates role to session-key binding
- validates program permission against role actions
- validates on-chain spend limit against configured policy (`spendLimit`, `depositLimit`)

It then signs vouchers with the delegated signer and marks `signatureType: "swig-session"`.

### `regular_budget` (BudgetAuthorizer)

This mode is intentionally fail-closed and now requires Swig config.

Required config:

- `swig.swigAddress`
- `swig.swigRoleId`
- optional `swig.rpcUrl`

Open-time behavior:

- fetches the configured Swig role from chain
- verifies signer matches that role
- verifies program permission from role actions
- derives on-chain spend limit
- clamps effective channel limits to `min(localConfig, onChainLimit)`

Update/topup/close behavior:

- requires known channel state created by open
- rejects unknown channels
- enforces per-channel limits pinned at open time

### `regular_unbounded` (UnboundedAuthorizer)

Wallet-signed session vouchers without budget caps.

Useful for manual or trusted environments. Not Swig-role-backed.

## Example: server setup

```ts
import { Mppx, solana } from "solana-mpp-sdk/server";

const mppx = Mppx.create({
    secretKey: process.env.MPP_SECRET_KEY!,
    methods: [
        solana.session({
            recipient: "RecipientPubkey...",
            network: "devnet",
            rpcUrl: "http://localhost:8899",
            asset: { kind: "sol", decimals: 9, symbol: "SOL" },
            channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
            pricing: {
                unit: "request",
                amountPerUnit: "10",
                meter: "api_calls",
            },
            sessionDefaults: { suggestedDeposit: "1000", ttlSeconds: 60 },
            verifier: {
                acceptAuthorizationModes: ["swig_session", "regular_budget"],
            },
            transactionVerifier: {
                async verifyOpen(channelId, openTx, depositAmount) {
                    // Fetch tx by signature and assert expected open semantics.
                },
                async verifyTopup(channelId, topupTx, amount) {
                    // Fetch tx by signature and assert expected topup semantics.
                },
                async verifyClose(channelId, closeTx, finalCumulativeAmount) {
                    // Fetch tx by signature and assert settlement transfer semantics.
                },
            },
        }),
    ],
});
```

## Example: client setup (swig_session)

```ts
import { Mppx, solana } from "solana-mpp-sdk/client";
import { SwigSessionAuthorizer } from "solana-mpp-sdk";

const authorizer = new SwigSessionAuthorizer({
    wallet: {
        address: walletAddress,
        swigAddress,
        swigRoleId: 0,
        async getSessionKey() {
            // Optional: return existing delegated signer with metadata.
            return null;
        },
        async createSessionKey({ ttlSeconds }) {
            // Create delegated session key on-chain and return:
            // signer, openTx, swigRoleId, createdAt
            return { signer, openTx, swigRoleId: 0, createdAt: Date.now() };
        },
    },
    policy: {
        profile: "swig-time-bound",
        ttlSeconds: 60,
        spendLimit: "1000",
    },
    rpcUrl: "http://localhost:8899",
    allowedPrograms: ["swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB"],
    buildTopupTx: async () => {
        // Return topup transaction reference.
        return "topup-signature";
    },
});

const method = solana.session({
    signer,
    authorizer,
    autoOpen: true,
    autoTopup: true,
});

const mppx = Mppx.create({ methods: [method] });
const res = await mppx.fetch("https://api.example.com/paid");
```

## Example: client setup (regular_budget with Swig role)

```ts
import { Mppx, solana } from "solana-mpp-sdk/client";
import { BudgetAuthorizer } from "solana-mpp-sdk";

const authorizer = new BudgetAuthorizer({
    signer,
    maxCumulativeAmount: "5000",
    maxDepositAmount: "2000",
    swig: {
        swigAddress,
        swigRoleId: 0,
        rpcUrl: "http://localhost:8899",
    },
    buildOpenTx: async () => "open-signature",
    buildTopupTx: async () => "topup-signature",
});

const method = solana.session({ signer, authorizer, autoTopup: true });
const mppx = Mppx.create({ methods: [method] });
```

## Design notes

- `@swig-wallet/kit` is an optional dependency and loaded dynamically by Swig authorizers.
- Browser demos can pass `swigModule: { fetchSwig }` to Swig authorizers to avoid runtime bare-specifier import issues in some bundler setups.
- For production, use `transactionVerifier` to require on-chain proof for open and topup actions.
