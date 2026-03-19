import type {
  Express,
  Request,
  Response as ExpressResponse,
} from 'express'
import { address } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { Mppx, Store, solana } from '../sdk.js'
import { toWebRequest } from '../utils.js'
import {
  SESSION_CHANNEL_PROGRAM,
  SWIG_SESSION_PRICE_BASE_UNITS,
  SWIG_SESSION_SUGGESTED_DEPOSIT_BASE_UNITS,
  TOKEN_PROGRAM,
  USDC_DECIMALS,
  USDC_MINT,
} from '../constants.js'

const SURFPOOL_RPC = 'http://localhost:8899'

export function registerSwigSession(
  app: Express,
  recipient: string,
  network: string,
  secretKey: string,
) {
  const store = Store.memory()

  const mppx = Mppx.create({
    secretKey,
    methods: [
      solana.session({
        recipient,
        network,
        asset: {
          kind: 'spl',
          mint: USDC_MINT,
          decimals: USDC_DECIMALS,
          symbol: 'USDC',
        },
        channelProgram: SESSION_CHANNEL_PROGRAM,
        pricing: {
          unit: 'request',
          amountPerUnit: SWIG_SESSION_PRICE_BASE_UNITS,
          meter: 'api_calls',
        },
        sessionDefaults: {
          suggestedDeposit: SWIG_SESSION_SUGGESTED_DEPOSIT_BASE_UNITS,
          ttlSeconds: 180,
        },
        verifier: {
          acceptAuthorizationModes: ['swig_session'],
        },
        transactionVerifier: {
          async verifyOpen(_channelId, openTx, depositAmount) {
            const tx = await getConfirmedTransaction(openTx)
            if (!tx) {
              throw new Error('openTx should resolve to a confirmed on-chain transaction')
            }

            const expectedDeposit = parseNonNegativeAtomicAmount(
              depositAmount,
              'open.depositAmount',
            )
            const transferred = sumTokenTransferAmount(tx, { mint: USDC_MINT })

            if (transferred < expectedDeposit) {
              throw new Error(
                `openTx must transfer at least ${expectedDeposit.toString()} USDC base units on-chain`,
              )
            }
          },
          async verifyTopup(_channelId, topupTx, additionalAmount) {
            const tx = await getConfirmedTransaction(topupTx)
            if (!tx) {
              throw new Error('topupTx should resolve to a confirmed on-chain transaction')
            }

            const expectedAdditional = parseNonNegativeAtomicAmount(
              additionalAmount,
              'topup.additionalAmount',
            )
            const transferred = sumTokenTransferAmount(tx, { mint: USDC_MINT })

            if (transferred < expectedAdditional) {
              throw new Error(
                `topupTx must transfer at least ${expectedAdditional.toString()} USDC base units on-chain`,
              )
            }
          },
          async verifyClose(_channelId, closeTx, finalCumulativeAmount) {
            const tx = await getConfirmedTransaction(closeTx)
            if (!tx) {
              throw new Error('closeTx should resolve to a confirmed on-chain transaction')
            }

            const expectedSettlement = parseNonNegativeAtomicAmount(
              finalCumulativeAmount,
              'close.finalCumulativeAmount',
            )
            const [recipientAta] = await findAssociatedTokenPda({
              owner: address(recipient),
              mint: address(USDC_MINT),
              tokenProgram: address(TOKEN_PROGRAM),
            })
            const transferredToRecipient = sumTokenTransferAmount(
              tx,
              {
                mint: USDC_MINT,
                destination: recipientAta,
              },
            )

            if (transferredToRecipient < expectedSettlement) {
              throw new Error(
                `closeTx must settle at least ${expectedSettlement.toString()} USDC base units to recipient ${recipient}`,
              )
            }
          },
        },
        store,
      }),
    ],
  })

  app.get('/api/v1/swig/status', (_req: Request, res: ExpressResponse) => {
    res.json({
      recipient,
      network,
      channelProgram: SESSION_CHANNEL_PROGRAM,
      currency: 'USDC',
      mint: USDC_MINT,
      decimals: USDC_DECIMALS,
      priceBaseUnitsPerRequest: SWIG_SESSION_PRICE_BASE_UNITS,
      suggestedDepositBaseUnits: SWIG_SESSION_SUGGESTED_DEPOSIT_BASE_UNITS,
      authorizationMode: 'swig_session',
      settlement: 'on_close',
    })
  })

  app.get('/api/v1/swig/research/:topic', async (req: Request, res: ExpressResponse) => {
    await handlePaidSessionRequest(mppx, req, res, () => {
      const topic = String(req.params.topic)
      return {
        topic,
        generatedAt: new Date().toISOString(),
        summary: `Session-scoped market pulse for ${topic}.`,
        takeaways: [
          'Monitor developer activity and retained user cohorts.',
          'Track unit economics before scaling paid workloads.',
          'Prefer delegated session keys for repeated API usage.',
        ],
      }
    })
  })

  app.get('/api/v1/swig/risk/:symbol', async (req: Request, res: ExpressResponse) => {
    await handlePaidSessionRequest(mppx, req, res, () => {
      const symbol = String(req.params.symbol).toUpperCase()
      const score = deterministicScore(symbol)

      return {
        symbol,
        generatedAt: new Date().toISOString(),
        riskScore: score,
        tier: score > 70 ? 'high' : score > 40 ? 'medium' : 'low',
        notes: [
          'This score is demo data for session payment flow visualization.',
          'Use real risk pipelines in production workloads.',
        ],
      }
    })
  })
}

async function handlePaidSessionRequest(
  mppx: any,
  req: Request,
  res: ExpressResponse,
  responseBody: () => unknown,
) {
  const result = await mppx.session({})(toWebRequest(req))

  if (result.status === 402) {
    const challenge = result.challenge as Response
    res.writeHead(challenge.status, Object.fromEntries(challenge.headers))
    res.end(await challenge.text())
    return
  }

  const response = result.withReceipt(Response.json(responseBody())) as Response
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
}

function deterministicScore(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return (hash % 100) + 1
}

async function getConfirmedTransaction(signature: string): Promise<any | null> {
  const res = await fetch(SURFPOOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  })

  const data = (await res.json()) as {
    result?: unknown
    error?: unknown
  }

  if (data.error) {
    throw new Error(`getTransaction failed: ${JSON.stringify(data.error)}`)
  }

  return (data.result as any) ?? null
}

function sumTokenTransferAmount(
  tx: any,
  filter: {
    mint: string
    destination?: string
  },
): bigint {
  let total = 0n

  for (const instruction of collectParsedInstructions(tx)) {
    const parsed = instruction?.parsed
    if (
      !parsed ||
      !isTokenTransferInstruction(instruction.program, parsed.type)
    ) {
      continue
    }

    const mint = parsed.info?.mint
    if (!mint || mint !== filter.mint) {
      continue
    }

    const destination = parsed.info?.destination
    if (filter.destination && destination !== filter.destination) {
      continue
    }

    const amountRaw = parsed.info?.tokenAmount?.amount ?? parsed.info?.amount
    if (amountRaw === undefined) {
      continue
    }

    total += BigInt(String(amountRaw))
  }

  return total
}

function isTokenTransferInstruction(program: unknown, type: unknown): boolean {
  return (
    (program === 'spl-token' || program === 'spl-token-2022') &&
    (type === 'transfer' || type === 'transferChecked')
  )
}

function collectParsedInstructions(tx: any): any[] {
  const topLevel = tx?.transaction?.message?.instructions ?? []
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap(
    (entry: { instructions?: any[] }) => entry.instructions ?? [],
  )

  return [...topLevel, ...inner]
}

function parseNonNegativeAtomicAmount(value: string, field: string): bigint {
  let amount: bigint
  try {
    amount = BigInt(value)
  } catch {
    throw new Error(`${field} must be a valid integer base-unit amount`)
  }

  if (amount < 0n) {
    throw new Error(`${field} must be non-negative`)
  }

  return amount
}
