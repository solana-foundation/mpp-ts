import { Credential, Method, z } from 'mppx'
import type { TransactionSigner } from '@solana/kit'
import * as Methods from '../Methods.js'
import type { SessionAuthorizer, SessionCredentialPayload } from '../session/Types.js'

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

type SessionChallengeRequest = {
  recipient: string
  network?: string
  asset: SessionAsset
  channelProgram: string
  pricing?: SessionPricing
  sessionDefaults?: {
    suggestedDeposit?: string
    ttlSeconds?: number
    settleInterval?: { kind: string; minIncrement?: string; seconds?: number }
    closeBehavior?: 'server_may_finalize' | 'payer_must_close'
  }
}

type ActiveChannel = {
  channelId: string
  recipient: string
  network: string
  channelProgram: string
  asset: SessionAsset
  serverNonce: string
  depositAmount: bigint
  cumulativeAmount: bigint
  sequence: number
}

export const sessionContextSchema = z.object({
  action: z.optional(z.enum(['open', 'update', 'topup', 'close'])),
  channelId: z.optional(z.string()),
  cumulativeAmount: z.optional(z.string()),
  sequence: z.optional(z.number()),
  depositAmount: z.optional(z.string()),
  openTx: z.optional(z.string()),
  additionalAmount: z.optional(z.string()),
  topupTx: z.optional(z.string()),
})

export type SessionContext = z.infer<typeof sessionContextSchema>

export function session(parameters: session.Parameters) {
  const {
    signer,
    authorizer,
    autoOpen = true,
    autoTopup = false,
    settleOnLimitHit = false,
    onProgress,
  } = parameters

  let activeChannel: ActiveChannel | null = null

  return Method.toClient(Methods.session, {
    context: sessionContextSchema,

    async createCredential({ challenge, context }) {
      const request = challenge.request as SessionChallengeRequest
      const recipient = request.recipient
      const network = request.network ?? 'mainnet-beta'
      const asset = request.asset
      const channelProgram = request.channelProgram
      const pricing = request.pricing
      const sessionDefaults = request.sessionDefaults

      onProgress?.({
        type: 'challenge',
        recipient,
        network,
        asset,
      })

      if (context?.action === 'topup') {
        return handleTopupAction(
          challenge,
          context,
          authorizer,
          activeChannel,
          channelProgram,
          network,
        )
      }

      if (context?.action === 'close') {
        const credential = await handleCloseAction(
          challenge,
          context,
          authorizer,
          activeChannel,
          channelProgram,
          recipient,
          network,
          onProgress,
        )

        activeChannel = null
        return credential
      }

      if (context?.action === 'open') {
        if (!context.channelId) {
          throw new Error('channelId is required for open action')
        }

        if (!context.depositAmount) {
          throw new Error('depositAmount is required for open action')
        }

        const channelId = context.channelId
        const depositAmount = context.depositAmount
        const parsedDepositAmount = parseNonNegativeAmount(
          depositAmount,
          'context.depositAmount',
        )
        const serverNonce = crypto.randomUUID()

        onProgress?.({ type: 'opening', channelId })

        const openResult = await authorizer.authorizeOpen({
          channelId,
          recipient,
          asset,
          depositAmount,
          channelProgram,
          network,
          serverNonce,
          pricing,
        })

        const payer = resolveOpenPayer(openResult.voucher.voucher.payer, signer)

        const payload: SessionCredentialPayload = {
          action: 'open',
          channelId,
          payer,
          authorizationMode: authorizer.getMode(),
          depositAmount,
          openTx: context.openTx ?? openResult.openTx,
          ...(openResult.expiresAt ? { expiresAt: openResult.expiresAt } : {}),
          capabilities: {
            ...(openResult.capabilities.maxCumulativeAmount
              ? {
                  maxCumulativeAmount:
                    openResult.capabilities.maxCumulativeAmount,
                }
              : {}),
            ...(openResult.capabilities.allowedActions
              ? { allowedActions: openResult.capabilities.allowedActions }
              : {}),
          },
          voucher: openResult.voucher,
        }

        activeChannel = {
          channelId,
          recipient,
          network,
          channelProgram,
          asset: normalizeAsset(asset),
          serverNonce: openResult.voucher.voucher.serverNonce,
          depositAmount: parsedDepositAmount,
          cumulativeAmount: parseNonNegativeAmount(
            openResult.voucher.voucher.cumulativeAmount,
            'voucher.cumulativeAmount',
          ),
          sequence: assertNonNegativeSequence(openResult.voucher.voucher.sequence),
        }

        onProgress?.({ type: 'opened', channelId })

        return Credential.serialize({
          challenge,
          payload,
        })
      }

      if (context?.action === 'update') {
        const channelId = context.channelId ?? activeChannel?.channelId
        if (!channelId) {
          throw new Error('channelId is required for update action')
        }

        if (!activeChannel || activeChannel.channelId !== channelId) {
          throw new Error('Cannot update a channel that is not active')
        }

        if (!context.cumulativeAmount) {
          throw new Error('cumulativeAmount is required for update action')
        }

        if (context.sequence === undefined) {
          throw new Error('sequence is required for update action')
        }

        const nextCumulativeAmount = parseNonNegativeAmount(
          context.cumulativeAmount,
          'context.cumulativeAmount',
        )
        const nextSequence = assertNonNegativeSequence(context.sequence)

        onProgress?.({
          type: 'updating',
          channelId,
          cumulativeAmount: nextCumulativeAmount.toString(),
        })

        const updateResult = await authorizer.authorizeUpdate({
          channelId,
          cumulativeAmount: nextCumulativeAmount.toString(),
          sequence: nextSequence,
          meter: pricing?.meter ?? 'session',
          units: pricing ? '1' : '0',
          serverNonce: activeChannel.serverNonce,
          channelProgram,
          recipient,
          network,
        })

        const payload: SessionCredentialPayload = {
          action: 'update',
          channelId,
          voucher: updateResult.voucher,
        }

        activeChannel.cumulativeAmount = parseNonNegativeAmount(
          updateResult.voucher.voucher.cumulativeAmount,
          'voucher.cumulativeAmount',
        )
        activeChannel.sequence = assertNonNegativeSequence(
          updateResult.voucher.voucher.sequence,
        )
        activeChannel.serverNonce = updateResult.voucher.voucher.serverNonce

        onProgress?.({
          type: 'updated',
          channelId,
          cumulativeAmount: activeChannel.cumulativeAmount.toString(),
        })

        return Credential.serialize({
          challenge,
          payload,
        })
      }

      const scopedActiveChannel =
        activeChannel &&
        matchesScope(activeChannel, {
          recipient,
          network,
          asset,
          channelProgram,
        })
          ? activeChannel
          : null

      if (!scopedActiveChannel) {
        if (!autoOpen) {
          throw new Error(
            'No active session channel for challenge scope and autoOpen is disabled',
          )
        }

        const channelId = crypto.randomUUID()
        const serverNonce = crypto.randomUUID()
        const depositAmount = sessionDefaults?.suggestedDeposit ?? '0'
        const parsedDepositAmount = parseNonNegativeAmount(
          depositAmount,
          'sessionDefaults.suggestedDeposit',
        )

        onProgress?.({ type: 'opening', channelId })

        const openResult = await authorizer.authorizeOpen({
          channelId,
          recipient,
          asset,
          depositAmount,
          channelProgram,
          network,
          serverNonce,
          pricing,
        })

        const payer = resolveOpenPayer(openResult.voucher.voucher.payer, signer)

        const payload: SessionCredentialPayload = {
          action: 'open',
          channelId,
          payer,
          authorizationMode: authorizer.getMode(),
          depositAmount,
          openTx: openResult.openTx,
          ...(openResult.expiresAt ? { expiresAt: openResult.expiresAt } : {}),
          capabilities: {
            ...(openResult.capabilities.maxCumulativeAmount
              ? {
                  maxCumulativeAmount:
                    openResult.capabilities.maxCumulativeAmount,
                }
              : {}),
            ...(openResult.capabilities.allowedActions
              ? { allowedActions: openResult.capabilities.allowedActions }
              : {}),
          },
          voucher: openResult.voucher,
        }

        activeChannel = {
          channelId,
          recipient,
          network,
          channelProgram,
          asset: normalizeAsset(asset),
          serverNonce: openResult.voucher.voucher.serverNonce,
          depositAmount: parsedDepositAmount,
          cumulativeAmount: parseNonNegativeAmount(
            openResult.voucher.voucher.cumulativeAmount,
            'voucher.cumulativeAmount',
          ),
          sequence: assertNonNegativeSequence(openResult.voucher.voucher.sequence),
        }

        onProgress?.({ type: 'opened', channelId })

        return Credential.serialize({
          challenge,
          payload,
        })
      }

      const debitIncrement = resolveDebitIncrement(pricing)
      const nextCumulativeAmount =
        scopedActiveChannel.cumulativeAmount + debitIncrement
      const nextSequence = scopedActiveChannel.sequence + 1

      if (nextCumulativeAmount > scopedActiveChannel.depositAmount) {
        if (!autoTopup) {
          if (!settleOnLimitHit) {
            throw new Error(
              'Voucher cumulative amount exceeds tracked deposit and autoTopup is disabled',
            )
          }

          const closeCredential = await handleCloseAction(
            challenge,
            {
              action: 'close',
              channelId: scopedActiveChannel.channelId,
            },
            authorizer,
            scopedActiveChannel,
            channelProgram,
            recipient,
            network,
            onProgress,
          )

          activeChannel = null
          return closeCredential
        }

        const additionalAmount = resolveAutoTopupAmount(
          sessionDefaults?.suggestedDeposit,
          nextCumulativeAmount,
          scopedActiveChannel.depositAmount,
        )

        const topupResult = await authorizer.authorizeTopup({
          channelId: scopedActiveChannel.channelId,
          additionalAmount: additionalAmount.toString(),
          channelProgram,
          network,
        })

        scopedActiveChannel.depositAmount += additionalAmount

        const payload: SessionCredentialPayload = {
          action: 'topup',
          channelId: scopedActiveChannel.channelId,
          additionalAmount: additionalAmount.toString(),
          topupTx: topupResult.topupTx,
        }

        return Credential.serialize({
          challenge,
          payload,
        })
      }

      onProgress?.({
        type: 'updating',
        channelId: scopedActiveChannel.channelId,
        cumulativeAmount: nextCumulativeAmount.toString(),
      })

      const updateResult = await authorizer.authorizeUpdate({
        channelId: scopedActiveChannel.channelId,
        cumulativeAmount: nextCumulativeAmount.toString(),
        sequence: nextSequence,
        meter: pricing?.meter ?? 'session',
        units: pricing ? '1' : '0',
        serverNonce: scopedActiveChannel.serverNonce,
        channelProgram,
        recipient,
        network,
      })

      const payload: SessionCredentialPayload = {
        action: 'update',
        channelId: scopedActiveChannel.channelId,
        voucher: updateResult.voucher,
      }

      scopedActiveChannel.cumulativeAmount = parseNonNegativeAmount(
        updateResult.voucher.voucher.cumulativeAmount,
        'voucher.cumulativeAmount',
      )
      scopedActiveChannel.sequence = assertNonNegativeSequence(
        updateResult.voucher.voucher.sequence,
      )
      scopedActiveChannel.serverNonce = updateResult.voucher.voucher.serverNonce

      onProgress?.({
        type: 'updated',
        channelId: scopedActiveChannel.channelId,
        cumulativeAmount: scopedActiveChannel.cumulativeAmount.toString(),
      })

      return Credential.serialize({
        challenge,
        payload,
      })
    },
  })
}

async function handleTopupAction(
  challenge: any,
  context: SessionContext,
  authorizer: SessionAuthorizer,
  activeChannel: ActiveChannel | null,
  channelProgram: string,
  network: string,
): Promise<string> {
  const channelId = context.channelId ?? activeChannel?.channelId
  if (!channelId) {
    throw new Error('channelId is required for topup action')
  }
  if (!context.additionalAmount) {
    throw new Error('additionalAmount is required for topup action')
  }

  const additionalAmount = parseNonNegativeAmount(
    context.additionalAmount,
    'context.additionalAmount',
  )

  const topupResult = await authorizer.authorizeTopup({
    channelId,
    additionalAmount: additionalAmount.toString(),
    channelProgram,
    network,
  })

  if (activeChannel && activeChannel.channelId === channelId) {
    activeChannel.depositAmount += additionalAmount
  }

  const payload: SessionCredentialPayload = {
    action: 'topup',
    channelId,
    additionalAmount: additionalAmount.toString(),
    topupTx: topupResult.topupTx,
  }

  return Credential.serialize({ challenge, payload })
}

async function handleCloseAction(
  challenge: any,
  context: SessionContext,
  authorizer: SessionAuthorizer,
  activeChannel: ActiveChannel | null,
  channelProgram: string,
  recipient: string,
  network: string,
  onProgress?: session.Parameters['onProgress'],
): Promise<string> {
  const channelId = context.channelId ?? activeChannel?.channelId
  if (!channelId) {
    throw new Error('channelId is required for close action')
  }

  if (!activeChannel || activeChannel.channelId !== channelId) {
    throw new Error('Cannot close a channel that is not active')
  }

  const finalSequence = activeChannel.sequence + 1

  onProgress?.({ type: 'closing', channelId })

  const closeResult = await authorizer.authorizeClose({
    channelId,
    finalCumulativeAmount: activeChannel.cumulativeAmount.toString(),
    sequence: finalSequence,
    serverNonce: activeChannel.serverNonce,
    channelProgram,
    recipient,
    network,
  })

  const payload: SessionCredentialPayload = {
    action: 'close',
    channelId,
    ...(closeResult.closeTx ? { closeTx: closeResult.closeTx } : {}),
    voucher: closeResult.voucher,
  }

  onProgress?.({ type: 'closed', channelId })

  return Credential.serialize({ challenge, payload })
}

function resolveDebitIncrement(pricing?: SessionPricing): bigint {
  if (pricing?.minDebit !== undefined) {
    return parseNonNegativeAmount(pricing.minDebit, 'pricing.minDebit')
  }

  if (pricing?.amountPerUnit !== undefined) {
    return parseNonNegativeAmount(pricing.amountPerUnit, 'pricing.amountPerUnit')
  }

  return 0n
}

function resolveAutoTopupAmount(
  suggestedDeposit: string | undefined,
  nextCumulativeAmount: bigint,
  depositAmount: bigint,
): bigint {
  const shortfall = nextCumulativeAmount - depositAmount
  if (shortfall <= 0n) {
    return 0n
  }

  if (suggestedDeposit === undefined) {
    return shortfall
  }

  const parsedSuggestedDeposit = parseNonNegativeAmount(
    suggestedDeposit,
    'sessionDefaults.suggestedDeposit',
  )
  return parsedSuggestedDeposit > shortfall
    ? parsedSuggestedDeposit
    : shortfall
}

function matchesScope(
  active: ActiveChannel,
  scope: {
    recipient: string
    network: string
    asset: SessionAsset
    channelProgram: string
  },
): boolean {
  if (active.recipient !== scope.recipient) {
    return false
  }

  if (active.network !== scope.network) {
    return false
  }

  if (active.channelProgram !== scope.channelProgram) {
    return false
  }

  return sameAsset(active.asset, scope.asset)
}

function sameAsset(left: SessionAsset, right: SessionAsset): boolean {
  return (
    left.kind === right.kind &&
    left.decimals === right.decimals &&
    (left.mint ?? '') === (right.mint ?? '') &&
    (left.symbol ?? '') === (right.symbol ?? '')
  )
}

function normalizeAsset(asset: SessionAsset): SessionAsset {
  return {
    kind: asset.kind,
    decimals: asset.decimals,
    ...(asset.mint ? { mint: asset.mint } : {}),
    ...(asset.symbol ? { symbol: asset.symbol } : {}),
  }
}

function assertNonNegativeSequence(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('voucher.sequence must be a non-negative integer')
  }

  return value
}

function parseNonNegativeAmount(value: string, field: string): bigint {
  let amount: bigint
  try {
    amount = BigInt(value)
  } catch {
    throw new Error(`${field} must be a valid integer string`)
  }

  if (amount < 0n) {
    throw new Error(`${field} must be non-negative`)
  }

  return amount
}

function resolveOpenPayer(voucherPayer: string, signer?: TransactionSigner): string {
  if (signer && signer.address !== voucherPayer) {
    throw new Error(
      `Open voucher payer ${voucherPayer} does not match signer address ${signer.address}`,
    )
  }

  return voucherPayer
}

export declare namespace session {
  type Parameters = {
    signer?: TransactionSigner
    authorizer: SessionAuthorizer
    autoOpen?: boolean
    autoTopup?: boolean
    settleOnLimitHit?: boolean
    onProgress?: (event: ProgressEvent) => void
  }

  type ProgressEvent =
    | { type: 'challenge'; recipient: string; network: string; asset: SessionAsset }
    | { type: 'opening'; channelId: string }
    | { type: 'opened'; channelId: string }
    | { type: 'updating'; channelId: string; cumulativeAmount: string }
    | { type: 'updated'; channelId: string; cumulativeAmount: string }
    | { type: 'closing'; channelId: string }
    | { type: 'closed'; channelId: string }
}
