import { Method, Receipt, Store } from 'mppx'
import * as Methods from '../Methods.js'
import type {
  ChannelState,
  SessionCredentialPayload,
  SignedSessionVoucher,
  VoucherVerifier,
} from '../session/Types.js'
import {
  parseVoucherFromPayload,
  verifyVoucherSignature,
} from '../session/Voucher.js'
import * as ChannelStore from '../session/ChannelStore.js'
import { DEFAULT_RPC_URLS } from '../constants.js'

type SessionAsset = {
  kind: 'sol' | 'spl'
  mint?: string
  decimals: number
  symbol?: string
}

type SessionPricing = {
  unit: string
  amountPerUnit: string
  meter: string
  minDebit?: string
}

type SessionDefaults = {
  suggestedDeposit?: string
  ttlSeconds?: number
  settleInterval?: { kind: string; minIncrement?: string; seconds?: number }
  closeBehavior?: 'server_may_finalize' | 'payer_must_close'
}

type SessionRequest = {
  recipient: string
  network?: string
  asset: SessionAsset
  channelProgram: string
  pricing?: SessionPricing
  sessionDefaults?: SessionDefaults
  verifier?: {
    acceptAuthorizationModes?: Array<
      'swig_session' | 'regular_budget' | 'regular_unbounded'
    >
    maxClockSkewSeconds?: number
  }
}

type SessionChallenge = {
  id?: string
  request: SessionRequest
}

type OpenPayload = Extract<SessionCredentialPayload, { action: 'open' }>
type UpdatePayload = Extract<SessionCredentialPayload, { action: 'update' }>
type TopupPayload = Extract<SessionCredentialPayload, { action: 'topup' }>
type ClosePayload = Extract<SessionCredentialPayload, { action: 'close' }>

type TransactionVerifier = {
  verifyOpen?(channelId: string, openTx: string, deposit: string): Promise<void>
  verifyTopup?(channelId: string, topupTx: string, amount: string): Promise<void>
  verifyClose?(
    channelId: string,
    closeTx: string,
    finalCumulativeAmount: string,
  ): Promise<void>
}

export function session(parameters: session.Parameters) {
  const {
    recipient,
    network = 'mainnet-beta',
    asset,
    channelProgram,
    store = Store.memory(),
  } = parameters

  assertSessionParameters(parameters)

  const resolvedRpcUrl =
    parameters.rpcUrl ??
    DEFAULT_RPC_URLS[network] ??
    DEFAULT_RPC_URLS['mainnet-beta']
  if (!resolvedRpcUrl) {
    throw new Error(`Unable to resolve RPC URL for network: ${network}`)
  }

  const channelStore = ChannelStore.fromStore(store)

  return Method.toServer(Methods.session, {
    defaults: {
      recipient: '',
      asset: { kind: 'sol' as const, decimals: 9 },
      channelProgram: '',
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request
      }

      const verifierRequest = toVerifierRequest(parameters.verifier)

      return {
        ...request,
        recipient,
        network,
        asset,
        channelProgram,
        ...(parameters.pricing ? { pricing: parameters.pricing } : {}),
        ...(parameters.sessionDefaults
          ? { sessionDefaults: parameters.sessionDefaults }
          : {}),
        ...(verifierRequest ? { verifier: verifierRequest } : {}),
      }
    },

    async verify({ credential }) {
      const payload = credential.payload as SessionCredentialPayload
      const challenge = credential.challenge as SessionChallenge
      const challengeId = challenge.id

      switch (payload.action) {
        case 'open':
          return await handleOpen(
            channelStore,
            payload,
            challenge,
            recipient,
            parameters,
            challengeId,
          )
        case 'update':
          return await handleUpdate(
            channelStore,
            payload,
            challenge,
            parameters,
            challengeId,
          )
        case 'topup':
          return await handleTopup(
            channelStore,
            payload,
            parameters,
            challengeId,
          )
        case 'close':
          return await handleClose(
            channelStore,
            payload,
            challenge,
            parameters,
            challengeId,
          )
        default: {
          const exhaustive: never = payload
          throw new Error(`Unknown session action: ${(exhaustive as { action?: string }).action}`)
        }
      }
    },

    respond({ credential }) {
      const payload = credential.payload as SessionCredentialPayload

      if (payload.action === 'close') {
        return new Response(null, { status: 204 })
      }

      if (payload.action === 'topup') {
        return new Response(null, { status: 204 })
      }

      return undefined
    },
  })
}

async function handleOpen(
  channelStore: ChannelStore.ChannelStore,
  payload: OpenPayload,
  challenge: SessionChallenge,
  configuredRecipient: string,
  parameters: session.Parameters,
  challengeId?: string,
) {
  const request = challenge.request
  const voucher = parseVoucherFromPayload(payload)

  const depositAmount = parseNonNegativeAmount(payload.depositAmount, 'depositAmount')
  const cumulativeAmount = parseNonNegativeAmount(
    voucher.voucher.cumulativeAmount,
    'voucher.cumulativeAmount',
  )

  if (!payload.openTx.trim()) {
    throw new Error('openTx is required for session open')
  }

  await parameters.transactionVerifier?.verifyOpen?.(
    payload.channelId,
    payload.openTx,
    payload.depositAmount,
  )

  if (voucher.voucher.channelId !== payload.channelId) {
    throw new Error('Voucher channelId mismatch for open action')
  }

  if (voucher.voucher.payer !== payload.payer) {
    throw new Error('Voucher payer mismatch for open action')
  }

  if (voucher.voucher.recipient !== configuredRecipient) {
    throw new Error('Voucher recipient does not match configured recipient')
  }

  if (voucher.voucher.recipient !== request.recipient) {
    throw new Error('Voucher recipient does not match challenge recipient')
  }

  if (voucher.voucher.channelProgram !== request.channelProgram) {
    throw new Error('Voucher channelProgram mismatch')
  }

  const expectedChainId = normalizeChainId(request.network ?? 'mainnet-beta')
  if (voucher.voucher.chainId !== expectedChainId) {
    throw new Error(
      `Voucher chainId mismatch: expected ${expectedChainId}, received ${voucher.voucher.chainId}`,
    )
  }

  if (cumulativeAmount > depositAmount) {
    throw new Error('Voucher cumulative amount exceeds channel deposit')
  }

  if (
    parameters.verifier?.acceptAuthorizationModes &&
    !parameters.verifier.acceptAuthorizationModes.includes(payload.authorizationMode)
  ) {
    throw new Error(`Authorization mode not accepted: ${payload.authorizationMode}`)
  }

  assertVoucherNotExpired(voucher, parameters.verifier?.maxClockSkewSeconds)

  const createdAt = new Date().toISOString()
  const expiresAtUnix = toUnixSeconds(payload.expiresAt ?? voucher.voucher.expiresAt)

  const nextState: ChannelState = {
    channelId: payload.channelId,
    payer: payload.payer,
    recipient: request.recipient,
    asset: {
      kind: request.asset.kind,
      decimals: request.asset.decimals,
      ...(request.asset.mint ? { mint: request.asset.mint } : {}),
    },
    escrowedAmount: depositAmount.toString(),
    settledAmount: '0',
    lastAuthorizedAmount: cumulativeAmount.toString(),
    openSlot: Date.now(),
    expiresAtUnix,
    status: 'open',
    authorizationMode: payload.authorizationMode,
    authority: {
      wallet: payload.payer,
      ...(payload.authorizationMode === 'swig_session'
        ? { delegatedSessionKey: voucher.signer }
        : {}),
    },
    serverNonce: voucher.voucher.serverNonce,
    lastSequence: voucher.voucher.sequence,
    createdAt,
  }

  await verifySignedVoucher(voucher, nextState, parameters.verifier?.voucherVerifier)

  await channelStore.updateChannel(payload.channelId, (current) => {
    if (current) {
      throw new Error(`Channel already exists: ${payload.channelId}`)
    }

    return nextState
  })

  return toSuccessReceipt(payload.channelId, challengeId)
}

async function handleUpdate(
  channelStore: ChannelStore.ChannelStore,
  payload: UpdatePayload,
  challenge: SessionChallenge,
  parameters: session.Parameters,
  challengeId?: string,
) {
  const channel = await channelStore.getChannel(payload.channelId)
  if (!channel) {
    throw new Error(`Channel not found: ${payload.channelId}`)
  }

  assertChannelOpen(channel, parameters.verifier?.maxClockSkewSeconds)

  const voucher = parseVoucherFromPayload(payload)
  assertVoucherMatchesChannel(voucher, channel, challenge)
  assertVoucherNotExpired(voucher, parameters.verifier?.maxClockSkewSeconds)

  const cumulativeAmount = parseNonNegativeAmount(
    voucher.voucher.cumulativeAmount,
    'voucher.cumulativeAmount',
  )
  const escrowedAmount = parseNonNegativeAmount(channel.escrowedAmount, 'channel.escrowedAmount')
  const lastAuthorizedAmount = parseNonNegativeAmount(
    channel.lastAuthorizedAmount,
    'channel.lastAuthorizedAmount',
  )

  if (voucher.voucher.sequence <= channel.lastSequence) {
    throw new Error(
      `Voucher sequence replay detected. Last=${channel.lastSequence}, received=${voucher.voucher.sequence}`,
    )
  }

  if (cumulativeAmount < lastAuthorizedAmount) {
    throw new Error('Voucher cumulative amount must be monotonically non-decreasing')
  }

  if (cumulativeAmount > escrowedAmount) {
    throw new Error('Voucher cumulative amount exceeds channel deposit')
  }

  await verifySignedVoucher(voucher, channel, parameters.verifier?.voucherVerifier)

  await channelStore.updateChannel(payload.channelId, (current) => {
    if (!current) {
      throw new Error(`Channel not found: ${payload.channelId}`)
    }

    assertChannelOpen(current, parameters.verifier?.maxClockSkewSeconds)

    if (voucher.voucher.sequence <= current.lastSequence) {
      throw new Error(
        `Voucher sequence replay detected. Last=${current.lastSequence}, received=${voucher.voucher.sequence}`,
      )
    }

    const currentEscrowed = parseNonNegativeAmount(
      current.escrowedAmount,
      'channel.escrowedAmount',
    )
    const currentLastAuthorized = parseNonNegativeAmount(
      current.lastAuthorizedAmount,
      'channel.lastAuthorizedAmount',
    )

    if (cumulativeAmount < currentLastAuthorized) {
      throw new Error('Voucher cumulative amount must be monotonically non-decreasing')
    }

    if (cumulativeAmount > currentEscrowed) {
      throw new Error('Voucher cumulative amount exceeds channel deposit')
    }

    return {
      ...current,
      lastAuthorizedAmount: cumulativeAmount.toString(),
      lastSequence: voucher.voucher.sequence,
    }
  })

  return toSuccessReceipt(payload.channelId, challengeId)
}

async function handleTopup(
  channelStore: ChannelStore.ChannelStore,
  payload: TopupPayload,
  parameters: session.Parameters,
  challengeId?: string,
) {
  const current = await channelStore.getChannel(payload.channelId)
  if (!current) {
    throw new Error(`Channel not found: ${payload.channelId}`)
  }

  assertChannelOpen(current)

  if (!payload.topupTx.trim()) {
    throw new Error('topupTx is required for session topup')
  }

  const additionalAmount = parseNonNegativeAmount(
    payload.additionalAmount,
    'additionalAmount',
  )

  await parameters.transactionVerifier?.verifyTopup?.(
    payload.channelId,
    payload.topupTx,
    payload.additionalAmount,
  )

  await channelStore.updateChannel(payload.channelId, (channel) => {
    if (!channel) {
      throw new Error(`Channel not found: ${payload.channelId}`)
    }

    assertChannelOpen(channel)

    if (channel.channelId !== payload.channelId) {
      throw new Error('Channel id mismatch for topup action')
    }

    const escrowedAmount = parseNonNegativeAmount(
      channel.escrowedAmount,
      'channel.escrowedAmount',
    )
    const nextEscrowed = escrowedAmount + additionalAmount

    return {
      ...channel,
      escrowedAmount: nextEscrowed.toString(),
    }
  })

  return toSuccessReceipt(payload.channelId, challengeId)
}

async function handleClose(
  channelStore: ChannelStore.ChannelStore,
  payload: ClosePayload,
  challenge: SessionChallenge,
  parameters: session.Parameters,
  challengeId?: string,
) {
  const channel = await channelStore.getChannel(payload.channelId)
  if (!channel) {
    throw new Error(`Channel not found: ${payload.channelId}`)
  }

  if (channel.status === 'closed') {
    throw new Error(`Channel already closed: ${payload.channelId}`)
  }

  assertChannelOpen(channel, parameters.verifier?.maxClockSkewSeconds)

  const voucher = parseVoucherFromPayload(payload)
  assertVoucherMatchesChannel(voucher, channel, challenge)
  assertVoucherNotExpired(voucher, parameters.verifier?.maxClockSkewSeconds)

  const cumulativeAmount = parseNonNegativeAmount(
    voucher.voucher.cumulativeAmount,
    'voucher.cumulativeAmount',
  )
  const escrowedAmount = parseNonNegativeAmount(channel.escrowedAmount, 'channel.escrowedAmount')
  const lastAuthorizedAmount = parseNonNegativeAmount(
    channel.lastAuthorizedAmount,
    'channel.lastAuthorizedAmount',
  )

  if (voucher.voucher.sequence <= channel.lastSequence) {
    throw new Error(
      `Voucher sequence replay detected. Last=${channel.lastSequence}, received=${voucher.voucher.sequence}`,
    )
  }

  if (cumulativeAmount < lastAuthorizedAmount) {
    throw new Error('Voucher cumulative amount must be monotonically non-decreasing')
  }

  if (cumulativeAmount > escrowedAmount) {
    throw new Error('Voucher cumulative amount exceeds channel deposit')
  }

  if (parameters.transactionVerifier?.verifyClose) {
    if (!payload.closeTx?.trim()) {
      throw new Error('closeTx is required for session close')
    }

    await parameters.transactionVerifier.verifyClose(
      payload.channelId,
      payload.closeTx,
      voucher.voucher.cumulativeAmount,
    )
  }

  await verifySignedVoucher(voucher, channel, parameters.verifier?.voucherVerifier)

  await channelStore.updateChannel(payload.channelId, (current) => {
    if (!current) {
      throw new Error(`Channel not found: ${payload.channelId}`)
    }

    if (current.status === 'closed') {
      throw new Error(`Channel already closed: ${payload.channelId}`)
    }

    assertChannelOpen(current, parameters.verifier?.maxClockSkewSeconds)

    if (voucher.voucher.sequence <= current.lastSequence) {
      throw new Error(
        `Voucher sequence replay detected. Last=${current.lastSequence}, received=${voucher.voucher.sequence}`,
      )
    }

    const currentEscrowed = parseNonNegativeAmount(
      current.escrowedAmount,
      'channel.escrowedAmount',
    )
    const currentLastAuthorized = parseNonNegativeAmount(
      current.lastAuthorizedAmount,
      'channel.lastAuthorizedAmount',
    )

    if (cumulativeAmount < currentLastAuthorized) {
      throw new Error('Voucher cumulative amount must be monotonically non-decreasing')
    }

    if (cumulativeAmount > currentEscrowed) {
      throw new Error('Voucher cumulative amount exceeds channel deposit')
    }

    return {
      ...current,
      lastAuthorizedAmount: cumulativeAmount.toString(),
      lastSequence: voucher.voucher.sequence,
      status: 'closed',
    }
  })

  return toSuccessReceipt(payload.closeTx ?? payload.channelId, challengeId)
}

function assertSessionParameters(parameters: session.Parameters) {
  if (!parameters.recipient.trim()) {
    throw new Error('recipient is required')
  }

  if (!parameters.channelProgram.trim()) {
    throw new Error('channelProgram is required')
  }

  if (!Number.isInteger(parameters.asset.decimals) || parameters.asset.decimals < 0) {
    throw new Error('asset.decimals must be a non-negative integer')
  }

  if (parameters.asset.kind !== 'sol' && parameters.asset.kind !== 'spl') {
    throw new Error('asset.kind must be "sol" or "spl"')
  }

  if (parameters.asset.kind === 'spl' && !parameters.asset.mint) {
    throw new Error('asset.mint is required when asset.kind is "spl"')
  }

  if (
    parameters.verifier?.maxClockSkewSeconds !== undefined &&
    (!Number.isInteger(parameters.verifier.maxClockSkewSeconds) ||
      parameters.verifier.maxClockSkewSeconds < 0)
  ) {
    throw new Error('verifier.maxClockSkewSeconds must be a non-negative integer')
  }
}

function toVerifierRequest(verifier: session.Parameters['verifier']) {
  if (!verifier) {
    return undefined
  }

  const requestVerifier: SessionRequest['verifier'] = {
    ...(verifier.acceptAuthorizationModes
      ? { acceptAuthorizationModes: verifier.acceptAuthorizationModes }
      : {}),
    ...(verifier.maxClockSkewSeconds !== undefined
      ? { maxClockSkewSeconds: verifier.maxClockSkewSeconds }
      : {}),
  }

  if (
    !requestVerifier.acceptAuthorizationModes &&
    requestVerifier.maxClockSkewSeconds === undefined
  ) {
    return undefined
  }

  return requestVerifier
}

function normalizeChainId(network: string): string {
  const normalized = network.trim()
  if (normalized.length === 0) {
    throw new Error('network must be a non-empty string')
  }

  return normalized.startsWith('solana:')
    ? normalized
    : `solana:${normalized}`
}

function toUnixSeconds(expiresAt?: string): number | null {
  if (!expiresAt) {
    return null
  }

  const unixMs = Date.parse(expiresAt)
  if (Number.isNaN(unixMs)) {
    throw new Error('expiresAt must be a valid ISO timestamp')
  }

  return Math.floor(unixMs / 1000)
}

function assertChannelOpen(channel: ChannelState, maxClockSkewSeconds = 0) {
  if (channel.status === 'closed') {
    throw new Error(`Channel is closed: ${channel.channelId}`)
  }

  if (channel.status === 'expired') {
    throw new Error(`Channel has expired: ${channel.channelId}`)
  }

  if (channel.status !== 'open') {
    throw new Error(
      `Channel must be open to accept this action. Current status=${channel.status}`,
    )
  }

  if (channel.expiresAtUnix !== null) {
    const nowUnix = Math.floor(Date.now() / 1000)
    if (nowUnix > channel.expiresAtUnix + maxClockSkewSeconds) {
      throw new Error(`Channel has expired: ${channel.channelId}`)
    }
  }
}

function assertVoucherMatchesChannel(
  voucher: SignedSessionVoucher,
  channel: ChannelState,
  challenge: SessionChallenge,
) {
  if (voucher.voucher.channelId !== channel.channelId) {
    throw new Error('Voucher channelId mismatch')
  }

  if (voucher.voucher.payer !== channel.payer) {
    throw new Error('Voucher payer mismatch')
  }

  if (voucher.voucher.recipient !== channel.recipient) {
    throw new Error('Voucher recipient mismatch')
  }

  if (voucher.voucher.serverNonce !== channel.serverNonce) {
    throw new Error('Voucher serverNonce mismatch')
  }

  if (voucher.voucher.channelProgram !== challenge.request.channelProgram) {
    throw new Error('Voucher channelProgram mismatch')
  }

  const expectedChainId = normalizeChainId(
    challenge.request.network ?? 'mainnet-beta',
  )
  if (voucher.voucher.chainId !== expectedChainId) {
    throw new Error(
      `Voucher chainId mismatch: expected ${expectedChainId}, received ${voucher.voucher.chainId}`,
    )
  }
}

function assertVoucherNotExpired(
  voucher: SignedSessionVoucher,
  maxClockSkewSeconds = 0,
) {
  if (!voucher.voucher.expiresAt) {
    return
  }

  const unixMs = Date.parse(voucher.voucher.expiresAt)
  if (Number.isNaN(unixMs)) {
    throw new Error('voucher.expiresAt must be a valid ISO timestamp')
  }

  if (Date.now() > unixMs + maxClockSkewSeconds * 1000) {
    throw new Error('Voucher has expired')
  }
}

async function verifySignedVoucher(
  voucher: SignedSessionVoucher,
  channel: ChannelState,
  customVerifier?: VoucherVerifier,
) {
  // Bind signer to channel authority — reject rogue signers
  assertSignerAuthorized(voucher, channel)

  if (voucher.signatureType === 'ed25519' || voucher.signatureType === 'swig-session') {
    const valid = await verifyVoucherSignature(voucher)
    if (!valid) {
      throw new Error('Invalid voucher signature')
    }
    return
  }

  if (!customVerifier) {
    throw new Error(
      `Unsupported voucher signatureType without custom verifier: ${voucher.signatureType}`,
    )
  }

  const valid = await customVerifier.verify(voucher, channel)
  if (!valid) {
    throw new Error('Invalid voucher signature')
  }
}

function assertSignerAuthorized(
  voucher: SignedSessionVoucher,
  channel: ChannelState,
) {
  const signer = voucher.signer

  if (channel.authorizationMode === 'swig_session') {
    // For swig_session mode, the signer must be the delegated session key
    const expectedKey = channel.authority.delegatedSessionKey
    if (!expectedKey) {
      throw new Error(
        'Channel uses swig_session authorization but no delegated session key is recorded',
      )
    }
    if (signer !== expectedKey) {
      throw new Error(
        `Voucher signer ${signer} does not match delegated session key ${expectedKey}`,
      )
    }
    return
  }

  // For regular_budget and regular_unbounded, the signer must be the channel payer
  if (signer !== channel.payer && signer !== channel.authority.wallet) {
    throw new Error(
      `Voucher signer ${signer} does not match channel payer ${channel.payer}`,
    )
  }
}

function parseNonNegativeAmount(value: string, field: string): bigint {
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new Error(`${field} must be a valid integer string`)
  }

  if (parsed < 0n) {
    throw new Error(`${field} must be non-negative`)
  }

  return parsed
}

function toSuccessReceipt(channelId: string, challengeId?: string): Receipt.Receipt {
  return Receipt.from({
    method: 'solana',
    ...(challengeId ? { challengeId } : {}),
    reference: channelId,
    status: 'success',
    timestamp: new Date().toISOString(),
  })
}

export declare namespace session {
  type Parameters = {
    recipient: string
    network?: 'mainnet-beta' | 'devnet' | 'localnet' | 'surfnet' | (string & {})
    rpcUrl?: string
    asset: { kind: 'sol' | 'spl'; mint?: string; decimals: number; symbol?: string }
    channelProgram: string
    pricing?: {
      unit: string
      amountPerUnit: string
      meter: string
      minDebit?: string
    }
    sessionDefaults?: {
      suggestedDeposit?: string
      ttlSeconds?: number
      settleInterval?: { kind: string; minIncrement?: string; seconds?: number }
      closeBehavior?: 'server_may_finalize' | 'payer_must_close'
    }
    verifier?: {
      acceptAuthorizationModes?: Array<
        'swig_session' | 'regular_budget' | 'regular_unbounded'
      >
      voucherVerifier?: VoucherVerifier
      maxClockSkewSeconds?: number
    }
    transactionVerifier?: TransactionVerifier
    store?: Store.Store
  }
}
