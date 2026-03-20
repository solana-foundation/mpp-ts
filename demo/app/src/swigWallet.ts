import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { Mppx, solana } from '@solana/mpp/client'
import { SwigSessionAuthorizer } from '@solana/mpp'
import {
  getAddAuthorityInstructions,
  fetchSwig,
  findSwigPda,
  getCreateSessionInstructions,
  getCreateSwigInstruction,
  getRemoveAuthorityInstructions,
  getSignInstructions,
  getSwigWalletAddress,
  SWIG_PROGRAM_ADDRESS,
} from '@swig-wallet/kit'
import {
  Actions,
  createEd25519AuthorityInfo,
  createEd25519SessionAuthorityInfo,
} from '@swig-wallet/lib'
import { getSigner } from './wallet.js'

const RPC_URL = 'http://localhost:8899'
const SESSION_CHANNEL_PROGRAM = SWIG_PROGRAM_ADDRESS
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const DEFAULT_SPEND_LIMIT_BASE_UNITS = 30_000n
const DEFAULT_SOL_LIMIT_LAMPORTS = 1_000_000_000n
const DEFAULT_SESSION_TTL_SECONDS = 180
const MANAGER_ROLE_ID = 0
const SESSION_SIGNER_FEE_BUFFER_LAMPORTS = 5_000_000n

const STORAGE_SWIG_ADDRESS = 'solana-mpp-demo:swig-address'
const STORAGE_SWIG_LIMIT = 'solana-mpp-demo:swig-limit'

type SwigSessionProgressEvent =
  | { type: 'challenge'; recipient: string; network: string; asset: { kind: 'sol' | 'spl'; mint?: string; decimals: number; symbol?: string } }
  | { type: 'opening'; channelId: string }
  | { type: 'opened'; channelId: string }
  | { type: 'updating'; channelId: string; cumulativeAmount: string }
  | { type: 'updated'; channelId: string; cumulativeAmount: string }
  | { type: 'closing'; channelId: string }
  | { type: 'closed'; channelId: string }

type DelegatedSessionState = {
  signer: KeyPairSigner
  openTx: string
  swigRoleId: number
  createdAtMs: number
}

type RuntimeState = {
  swigAddress: string | null
  swigWalletAddress: string | null
  spendLimitBaseUnits: bigint
  delegatedSession: DelegatedSessionState | null
  lastChannelId: string | null
}

export type SwigSnapshot = {
  swigAddress: string | null
  swigWalletAddress: string | null
  spendLimitBaseUnits: string
  delegatedSessionSigner: string | null
  delegatedSessionRoleId: number | null
  lastChannelId: string | null
  channelProgram: string
}

export type SwigStep =
  | { type: 'request'; url: string }
  | { type: 'setup'; message: string }
  | SwigSessionProgressEvent
  | { type: 'success'; data: unknown; status: number; receipt?: string }
  | { type: 'error'; message: string }

const runtime: RuntimeState = {
  swigAddress: localStorage.getItem(STORAGE_SWIG_ADDRESS),
  swigWalletAddress: null,
  spendLimitBaseUnits:
    readStoredBigInt(STORAGE_SWIG_LIMIT) ?? DEFAULT_SPEND_LIMIT_BASE_UNITS,
  delegatedSession: null,
  lastChannelId: null,
}

const channelDeposits = new Map<string, bigint>()

let mppxInstance: ReturnType<typeof Mppx.create> | null = null
let mppxSignerAddress: string | null = null
let progressCallback: ((step: SwigStep) => void) | null = null

export function getSwigSnapshot(): SwigSnapshot {
  return {
    swigAddress: runtime.swigAddress,
    swigWalletAddress: runtime.swigWalletAddress,
    spendLimitBaseUnits: runtime.spendLimitBaseUnits.toString(),
    delegatedSessionSigner: runtime.delegatedSession?.signer.address ?? null,
    delegatedSessionRoleId: runtime.delegatedSession?.swigRoleId ?? null,
    lastChannelId: runtime.lastChannelId,
    channelProgram: SESSION_CHANNEL_PROGRAM,
  }
}

export async function initializeSwigWallet(
  spendLimitBaseUnits: bigint = runtime.spendLimitBaseUnits,
): Promise<SwigSnapshot> {
  await ensureSwigWallet(spendLimitBaseUnits)
  return getSwigSnapshot()
}

export function resetSwigDemoState() {
  runtime.swigAddress = null
  runtime.swigWalletAddress = null
  runtime.delegatedSession = null
  runtime.lastChannelId = null
  runtime.spendLimitBaseUnits = DEFAULT_SPEND_LIMIT_BASE_UNITS

  localStorage.removeItem(STORAGE_SWIG_ADDRESS)
  localStorage.removeItem(STORAGE_SWIG_LIMIT)

  channelDeposits.clear()
  mppxInstance = null
  mppxSignerAddress = null
}

export async function* payAndFetchSwigSession(
  url: string,
  options?: { context?: Record<string, unknown> },
): AsyncGenerator<SwigStep> {
  yield { type: 'request', url }

  const queue: SwigStep[] = []
  let resolve: (() => void) | null = null
  let closedChannelDuringRequest = false

  progressCallback = (step) => {
    if (step.type === 'closed') {
      closedChannelDuringRequest = true
    }

    queue.push(step)
    resolve?.()
  }

  try {
    if (!runtime.swigAddress) {
      queue.push({
        type: 'setup',
        message: 'Initializing Swig role on-chain...',
      })
    }

    const mppx = await getSwigMppx()

    queue.push({
      type: 'setup',
      message: `Swig ready: ${shortAddress(runtime.swigAddress)}`,
    })

    const fetchPromise: Promise<Response> = mppx.fetch(url, options as any)

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }

      const result = await Promise.race([
        fetchPromise.then((response) => ({ done: true as const, response })),
        new Promise<{ done: false }>((r) => {
          resolve = () => r({ done: false })
        }),
      ])

      if (!result.done) {
        continue
      }

      while (queue.length > 0) {
        yield queue.shift()!
      }

      const receipt = result.response.headers.get('payment-receipt') ?? undefined

      const rawBody = await result.response.text()
      let data: unknown = rawBody

      if (closedChannelDuringRequest && result.response.ok) {
        await recycleSessionRoleAfterSuccessfulClose()
      }

      if (rawBody.length === 0) {
        data = null
      } else {
        try {
          data = JSON.parse(rawBody)
        } catch {
          data = rawBody
        }
      }

      yield {
        type: 'success',
        data,
        status: result.response.status,
        receipt,
      }
      return
    }
  } catch (err: any) {
    yield { type: 'error', message: err?.message ?? String(err) }
  } finally {
    progressCallback = null
  }
}

async function recycleSessionRoleAfterSuccessfulClose() {
  const sessionRoleId = runtime.delegatedSession?.swigRoleId

  try {
    if (sessionRoleId !== undefined) {
      await removeSessionRole(sessionRoleId)
    }
  } finally {
    runtime.delegatedSession = null
    runtime.lastChannelId = null
    channelDeposits.clear()
    mppxInstance = null
    mppxSignerAddress = null
  }
}

async function getSwigMppx() {
  const rootSigner = await getSigner()

  if (mppxInstance && mppxSignerAddress === rootSigner.address) {
    return mppxInstance
  }

  if (!runtime.swigAddress) {
    await ensureSwigWallet(runtime.spendLimitBaseUnits)
  }

  const buildOpenTx = async (input: any) => {
    const depositAmount = parseNonNegativeBaseUnits(
      input.depositAmount,
      'open.depositAmount',
    )

    const swigWalletAddress = await ensureSwigWalletAddress()
    const [sourceAta, destinationAta] = await Promise.all([
      findUsdcAta(rootSigner.address),
      findUsdcAta(swigWalletAddress),
    ])

    const rpc = createSolanaRpc(RPC_URL)
    const signature = await sendInstructions({
      rpc,
      feePayer: rootSigner,
      instructions: [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: rootSigner,
          ata: address(destinationAta),
          owner: address(swigWalletAddress),
          mint: address(USDC_MINT),
          tokenProgram: address(TOKEN_PROGRAM),
        }),
        getTransferCheckedInstruction(
          {
            source: address(sourceAta),
            mint: address(USDC_MINT),
            destination: address(destinationAta),
            authority: rootSigner,
            amount: depositAmount,
            decimals: USDC_DECIMALS,
          },
          {
            programAddress: address(TOKEN_PROGRAM),
          },
        ),
      ],
    })

    channelDeposits.set(input.channelId, depositAmount)
    return signature
  }

  const buildTopupTx = async (input: any) => {
    const additionalAmount = parseNonNegativeBaseUnits(
      input.additionalAmount,
      'topup.additionalAmount',
    )

    const swigWalletAddress = await ensureSwigWalletAddress()
    const [sourceAta, destinationAta] = await Promise.all([
      findUsdcAta(rootSigner.address),
      findUsdcAta(swigWalletAddress),
    ])

    const rpc = createSolanaRpc(RPC_URL)
    const signature = await sendInstructions({
      rpc,
      feePayer: rootSigner,
      instructions: [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: rootSigner,
          ata: address(destinationAta),
          owner: address(swigWalletAddress),
          mint: address(USDC_MINT),
          tokenProgram: address(TOKEN_PROGRAM),
        }),
        getTransferCheckedInstruction(
          {
            source: address(sourceAta),
            mint: address(USDC_MINT),
            destination: address(destinationAta),
            authority: rootSigner,
            amount: additionalAmount,
            decimals: USDC_DECIMALS,
          },
          {
            programAddress: address(TOKEN_PROGRAM),
          },
        ),
      ],
    })

    const deposited = channelDeposits.get(input.channelId) ?? 0n
    channelDeposits.set(input.channelId, deposited + additionalAmount)
    return signature
  }

  const buildCloseTx = async (input: any) => {
    const delegatedSession = runtime.delegatedSession
    if (!delegatedSession) {
      throw new Error('No delegated session signer is available to settle close')
    }

    const swigAddress = runtime.swigAddress
    if (!swigAddress) {
      throw new Error('Swig wallet is not initialized')
    }

    const swigWalletAddress = await ensureSwigWalletAddress()
    const finalCumulativeAmount = parseNonNegativeBaseUnits(
      input.finalCumulativeAmount,
      'close.finalCumulativeAmount',
    )
    const deposited = channelDeposits.get(input.channelId) ?? finalCumulativeAmount

    if (finalCumulativeAmount > deposited) {
      throw new Error(
        `Close settlement exceeds channel deposit (${deposited.toString()})`,
      )
    }

    const [swigUsdcAta, recipientUsdcAta, payerUsdcAta] = await Promise.all([
      findUsdcAta(swigWalletAddress),
      findUsdcAta(input.recipient),
      findUsdcAta(rootSigner.address),
    ])

    const refundAmount = deposited - finalCumulativeAmount
    const innerInstructions: any[] = [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: delegatedSession.signer,
        ata: address(recipientUsdcAta),
        owner: address(input.recipient),
        mint: address(USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
      }),
      getTransferCheckedInstruction(
        {
          source: address(swigUsdcAta),
          mint: address(USDC_MINT),
          destination: address(recipientUsdcAta),
          authority: address(swigWalletAddress) as any,
          amount: finalCumulativeAmount,
          decimals: USDC_DECIMALS,
        },
        {
          programAddress: address(TOKEN_PROGRAM),
        },
      ),
    ]

    if (refundAmount > 0n) {
      innerInstructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: delegatedSession.signer,
          ata: address(payerUsdcAta),
          owner: address(rootSigner.address),
          mint: address(USDC_MINT),
          tokenProgram: address(TOKEN_PROGRAM),
        }),
        getTransferCheckedInstruction(
          {
            source: address(swigUsdcAta),
            mint: address(USDC_MINT),
            destination: address(payerUsdcAta),
            authority: address(swigWalletAddress) as any,
            amount: refundAmount,
            decimals: USDC_DECIMALS,
          },
          {
            programAddress: address(TOKEN_PROGRAM),
          },
        ),
      )
    }

    const rpc = createSolanaRpc(RPC_URL)
    const swig = await (fetchSwig as any)(rpc, swigAddress)
    const signInstructions = await getSignInstructions(
      swig,
      delegatedSession.swigRoleId,
      innerInstructions as any,
      false,
      {
        payer: delegatedSession.signer.address,
      },
    )

    const signature = await sendInstructions({
      rpc,
      feePayer: delegatedSession.signer,
      instructions: signInstructions,
    })

    channelDeposits.delete(input.channelId)
    return signature
  }

  const walletAdapter = {
    address: rootSigner.address,
    swigAddress: runtime.swigAddress ?? undefined,
    swigRoleId: runtime.delegatedSession?.swigRoleId,
    getSessionKey: async () => {
      if (!runtime.delegatedSession) {
        return null
      }

      return {
        signer: runtime.delegatedSession.signer,
        openTx: runtime.delegatedSession.openTx,
        swigRoleId: runtime.delegatedSession.swigRoleId,
        createdAt: runtime.delegatedSession.createdAtMs,
      }
    },
    createSessionKey: async ({ ttlSeconds }: { ttlSeconds: number }) => {
      const delegated = await createDelegatedSession(ttlSeconds)
      walletAdapter.swigAddress = runtime.swigAddress ?? undefined
      walletAdapter.swigRoleId = delegated.swigRoleId

      return {
        signer: delegated.signer,
        openTx: delegated.openTx,
        swigRoleId: delegated.swigRoleId,
        createdAt: delegated.createdAtMs,
      }
    },
  }

  const authorizer = new SwigSessionAuthorizer({
    wallet: walletAdapter,
    policy: {
      profile: 'swig-time-bound',
      ttlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      spendLimit: runtime.spendLimitBaseUnits.toString(),
      depositLimit: runtime.spendLimitBaseUnits.toString(),
    },
    rpcUrl: RPC_URL,
    swigModule: {
      fetchSwig: fetchSwig as any,
    },
    allowedPrograms: [SESSION_CHANNEL_PROGRAM],
    buildOpenTx,
    buildTopupTx,
    buildCloseTx,
  })

  const method = solana.session({
    signer: rootSigner,
    authorizer,
    autoOpen: true,
    autoTopup: false,
    settleOnLimitHit: true,
    onProgress(event: SwigSessionProgressEvent) {
      if ('channelId' in event) {
        runtime.lastChannelId = event.channelId
      }
      progressCallback?.(event)
    },
  })

  mppxInstance = Mppx.create({ methods: [method] })
  mppxSignerAddress = rootSigner.address

  return mppxInstance
}

async function ensureSwigWallet(spendLimitBaseUnits: bigint): Promise<string> {
  const rootSigner = await getSigner()
  const rpc = createSolanaRpc(RPC_URL)

  if (runtime.swigAddress) {
    try {
      const existingSwig = await (fetchSwig as any)(rpc, runtime.swigAddress)

      const managerRole = existingSwig.findRoleById?.(MANAGER_ROLE_ID)
      if (!managerRole) {
        throw new Error('Swig manager role is missing')
      }

      if (managerRole?.isSessionBased?.()) {
        throw new Error('Legacy Swig manager role is session-based')
      }

      runtime.swigWalletAddress = await getSwigWalletAddress(existingSwig)
      runtime.spendLimitBaseUnits = spendLimitBaseUnits
      localStorage.setItem(STORAGE_SWIG_LIMIT, spendLimitBaseUnits.toString())
      return runtime.swigAddress
    } catch {
      runtime.swigAddress = null
      runtime.swigWalletAddress = null
      runtime.delegatedSession = null
      runtime.lastChannelId = null
      channelDeposits.clear()
      localStorage.removeItem(STORAGE_SWIG_ADDRESS)
    }
  }

  const swigId = crypto.getRandomValues(new Uint8Array(32))
  const createSwigIx = await getCreateSwigInstruction({
    payer: rootSigner.address,
    id: swigId,
    actions: Actions.set().manageAuthority().get(),
    authorityInfo: createEd25519AuthorityInfo(rootSigner.address),
  })

  await sendInstructions({
    rpc,
    feePayer: rootSigner,
    instructions: [createSwigIx],
  })

  const swigAddress = await findSwigPda(swigId)
  const swig = await (fetchSwig as any)(rpc, swigAddress)
  const swigWalletAddress = await getSwigWalletAddress(swig)

  runtime.swigAddress = swigAddress
  runtime.swigWalletAddress = swigWalletAddress
  runtime.spendLimitBaseUnits = spendLimitBaseUnits
  runtime.delegatedSession = null
  runtime.lastChannelId = null
  channelDeposits.clear()

  localStorage.setItem(STORAGE_SWIG_ADDRESS, swigAddress)
  localStorage.setItem(STORAGE_SWIG_LIMIT, spendLimitBaseUnits.toString())

  mppxInstance = null
  mppxSignerAddress = null

  return swigAddress
}

async function ensureSwigWalletAddress(): Promise<string> {
  if (!runtime.swigAddress) {
    await ensureSwigWallet(runtime.spendLimitBaseUnits)
  }

  if (runtime.swigWalletAddress) {
    return runtime.swigWalletAddress
  }

  const swigAddress = runtime.swigAddress
  if (!swigAddress) {
    throw new Error('Swig wallet is not initialized')
  }

  const rpc = createSolanaRpc(RPC_URL)
  const swig = await (fetchSwig as any)(rpc, swigAddress)
  const swigWalletAddress = await getSwigWalletAddress(swig)
  runtime.swigWalletAddress = swigWalletAddress
  return swigWalletAddress
}

async function removeSessionRole(roleId: number): Promise<void> {
  if (roleId === MANAGER_ROLE_ID) {
    throw new Error('Refusing to remove the Swig manager role')
  }

  const swigAddress = runtime.swigAddress
  if (!swigAddress) {
    return
  }

  const rootSigner = await getSigner()
  const rpc = createSolanaRpc(RPC_URL)
  const swig = await (fetchSwig as any)(rpc, swigAddress)

  if (!swig.findRoleById?.(roleId)) {
    return
  }

  const removeRoleInstructions = await getRemoveAuthorityInstructions(
    swig,
    MANAGER_ROLE_ID,
    roleId,
  )

  await sendInstructions({
    rpc,
    feePayer: rootSigner,
    instructions: removeRoleInstructions,
  })
}

function buildDelegatedRoleActions(spendLimitBaseUnits: bigint) {
  return Actions.set()
    .programAll()
    .solLimit({ amount: DEFAULT_SOL_LIMIT_LAMPORTS })
    .tokenLimit({
      mint: USDC_MINT,
      amount: spendLimitBaseUnits,
    })
    .get()
}

async function createSessionRole(parameters: {
  rpc: ReturnType<typeof createSolanaRpc>
  swigAddress: string
  rootSigner: KeyPairSigner
  ttlSeconds: number
  spendLimitBaseUnits: bigint
}): Promise<number> {
  const { rpc, swigAddress, rootSigner, ttlSeconds, spendLimitBaseUnits } =
    parameters

  const swigBefore = await (fetchSwig as any)(rpc, swigAddress)
  const existingRoleIds = new Set<number>(
    (swigBefore.roles as Array<{ id: number }>).map((role) => role.id),
  )

  const addRoleInstructions = await getAddAuthorityInstructions(
    swigBefore,
    MANAGER_ROLE_ID,
    createEd25519SessionAuthorityInfo(rootSigner.address, BigInt(ttlSeconds)),
    buildDelegatedRoleActions(spendLimitBaseUnits),
  )

  await sendInstructions({
    rpc,
    feePayer: rootSigner,
    instructions: addRoleInstructions,
  })

  const swigAfter = await (fetchSwig as any)(rpc, swigAddress)
  const addedRole = (swigAfter.roles as Array<{ id: number }>).find(
    (role) => !existingRoleIds.has(role.id),
  )

  if (!addedRole) {
    throw new Error('Unable to locate the newly added delegated Swig role')
  }

  return addedRole.id
}

async function createDelegatedSession(ttlSeconds: number): Promise<DelegatedSessionState> {
  const rootSigner = await getSigner()
  const swigAddress = await ensureSwigWallet(runtime.spendLimitBaseUnits)
  const rpc = createSolanaRpc(RPC_URL)

  const swigRoleId = await createSessionRole({
    rpc,
    swigAddress,
    rootSigner,
    ttlSeconds,
    spendLimitBaseUnits: runtime.spendLimitBaseUnits,
  })

  const swig = await (fetchSwig as any)(rpc, swigAddress)
  const delegatedSigner = await generateKeyPairSigner()
  const createSessionInstructions = await getCreateSessionInstructions(
    swig,
    swigRoleId,
    delegatedSigner.address,
    BigInt(ttlSeconds),
  )

  const openTx = await sendInstructions({
    rpc,
    feePayer: rootSigner,
    instructions: createSessionInstructions,
  })

  await sendInstructions({
    rpc,
    feePayer: rootSigner,
    instructions: [
      getTransferSolInstruction({
        source: rootSigner,
        destination: address(delegatedSigner.address),
        amount: SESSION_SIGNER_FEE_BUFFER_LAMPORTS,
      }),
    ],
  })

  const delegatedSession = {
    signer: delegatedSigner,
    openTx,
    swigRoleId,
    createdAtMs: Date.now(),
  }

  runtime.delegatedSession = delegatedSession

  return delegatedSession
}

async function sendInstructions(parameters: {
  rpc: ReturnType<typeof createSolanaRpc>
  feePayer: KeyPairSigner
  instructions: readonly Instruction[]
}): Promise<string> {
  const { rpc, feePayer, instructions } = parameters
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayerSigner(feePayer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
    (message) => appendTransactionMessageInstructions(instructions, message),
  )

  const signed = await signTransactionMessageWithSigners(txMessage)
  const wire = getBase64EncodedWireTransaction(signed)
  const signature = await rpc
    .sendTransaction(wire, {
      encoding: 'base64',
      skipPreflight: false,
    })
    .send()

  await waitForSignatureConfirmation(signature)
  return signature
}

async function waitForSignatureConfirmation(signature: string, timeoutMs = 30_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature]],
      }),
    })

    const data = (await res.json()) as {
      result?: {
        value: Array<
          | null
          | {
              confirmationStatus?: string
              err?: unknown
            }
        >
      }
    }

    const status = data.result?.value?.[0]
    if (status) {
      if (status.err) {
        throw new Error(
          `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
        )
      }

      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for transaction confirmation: ${signature}`)
}

function readStoredBigInt(key: string): bigint | null {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

function shortAddress(value: string | null): string {
  if (!value) {
    return '(not initialized)'
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

async function findUsdcAta(owner: string): Promise<ReturnType<typeof address>> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(USDC_MINT),
    tokenProgram: address(TOKEN_PROGRAM),
  })

  return ata
}

function parseNonNegativeBaseUnits(value: string, field: string): bigint {
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new Error(`${field} must be an integer base-unit amount`)
  }

  if (parsed < 0n) {
    throw new Error(`${field} must be non-negative`)
  }

  return parsed
}
