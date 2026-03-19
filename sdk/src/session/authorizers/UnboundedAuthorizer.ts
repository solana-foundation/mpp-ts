import type { MessagePartialSigner } from '@solana/kit'
import {
  type AuthorizeCloseInput,
  type AuthorizeOpenInput,
  type AuthorizeTopupInput,
  type AuthorizeUpdateInput,
  type AuthorizerCapabilities,
  type AuthorizedClose,
  type AuthorizedOpen,
  type AuthorizedTopup,
  type AuthorizedUpdate,
  type SessionAuthorizer,
} from '../Types.js'
import { signVoucher } from '../Voucher.js'

type ChannelProgress = {
  lastCumulative: bigint
  lastSequence: number
}

export interface UnboundedAuthorizerParameters {
  signer: MessagePartialSigner
  allowedPrograms?: string[]
  expiresAt?: string
  requiresInteractiveApproval?: Partial<
    AuthorizerCapabilities['requiresInteractiveApproval']
  >
  buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string
  buildTopupTx?: (input: AuthorizeTopupInput) => Promise<string> | string
  buildCloseTx?: (input: AuthorizeCloseInput) => Promise<string> | string
}

export class UnboundedAuthorizer implements SessionAuthorizer {
  private readonly signer: MessagePartialSigner
  private readonly allowedPrograms?: Set<string>
  private readonly expiresAt?: string
  private readonly expiresAtUnixMs?: number
  private readonly buildOpenTx?: (
    input: AuthorizeOpenInput,
  ) => Promise<string> | string
  private readonly buildTopupTx?: (
    input: AuthorizeTopupInput,
  ) => Promise<string> | string
  private readonly buildCloseTx?: (
    input: AuthorizeCloseInput,
  ) => Promise<string> | string
  private readonly channels = new Map<string, ChannelProgress>()
  private readonly capabilities: AuthorizerCapabilities

  constructor(parameters: UnboundedAuthorizerParameters) {
    this.signer = parameters.signer
    this.allowedPrograms = parameters.allowedPrograms
      ? new Set(parameters.allowedPrograms)
      : undefined
    this.expiresAt = parameters.expiresAt
    this.expiresAtUnixMs =
      parameters.expiresAt !== undefined
        ? parseIsoTimestamp(parameters.expiresAt, 'expiresAt')
        : undefined
    this.buildOpenTx = parameters.buildOpenTx
    this.buildTopupTx = parameters.buildTopupTx
    this.buildCloseTx = parameters.buildCloseTx

    const requiresInteractiveApproval = {
      open: parameters.requiresInteractiveApproval?.open ?? false,
      update: parameters.requiresInteractiveApproval?.update ?? false,
      topup: parameters.requiresInteractiveApproval?.topup ?? false,
      close: parameters.requiresInteractiveApproval?.close ?? false,
    }

    this.capabilities = {
      mode: 'regular_unbounded',
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      ...(parameters.allowedPrograms
        ? { allowedPrograms: [...parameters.allowedPrograms] }
        : {}),
      allowedActions: ['open', 'update', 'topup', 'close'],
      requiresInteractiveApproval,
    }
  }

  getMode() {
    return 'regular_unbounded' as const
  }

  getCapabilities(): AuthorizerCapabilities {
    return this.capabilities
  }

  async authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    const openTx = await this.resolveOpenTx(input)

    const voucher = await signVoucher(this.signer, {
      channelId: input.channelId,
      payer: this.signer.address,
      recipient: input.recipient,
      cumulativeAmount: '0',
      sequence: 0,
      meter: input.pricing?.meter ?? 'session',
      units: '0',
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    this.channels.set(input.channelId, {
      lastCumulative: 0n,
      lastSequence: 0,
    })

    return {
      openTx,
      voucher,
      capabilities: this.getCapabilities(),
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
    }
  }

  async authorizeUpdate(input: AuthorizeUpdateInput): Promise<AuthorizedUpdate> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    const cumulativeAmount = parseNonNegativeAmount(
      input.cumulativeAmount,
      'cumulativeAmount',
    )

    const progress = this.channels.get(input.channelId)
    this.assertMonotonic(
      input.channelId,
      input.sequence,
      cumulativeAmount,
      progress,
    )

    const voucher = await signVoucher(this.signer, {
      channelId: input.channelId,
      payer: this.signer.address,
      recipient: input.recipient,
      cumulativeAmount: cumulativeAmount.toString(),
      sequence: input.sequence,
      meter: input.meter,
      units: input.units,
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    this.channels.set(input.channelId, {
      lastCumulative: cumulativeAmount,
      lastSequence: input.sequence,
    })

    return { voucher }
  }

  async authorizeTopup(input: AuthorizeTopupInput): Promise<AuthorizedTopup> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)
    parseNonNegativeAmount(input.additionalAmount, 'additionalAmount')

    return {
      topupTx: await this.resolveTopupTx(input),
    }
  }

  async authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    const finalCumulativeAmount = parseNonNegativeAmount(
      input.finalCumulativeAmount,
      'finalCumulativeAmount',
    )

    const progress = this.channels.get(input.channelId)
    this.assertMonotonic(
      input.channelId,
      input.sequence,
      finalCumulativeAmount,
      progress,
    )

    const voucher = await signVoucher(this.signer, {
      channelId: input.channelId,
      payer: this.signer.address,
      recipient: input.recipient,
      cumulativeAmount: finalCumulativeAmount.toString(),
      sequence: input.sequence,
      meter: 'close',
      units: '0',
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    const closeTx = await this.resolveCloseTx(input)

    this.channels.set(input.channelId, {
      lastCumulative: finalCumulativeAmount,
      lastSequence: input.sequence,
    })

    return {
      voucher,
      ...(closeTx ? { closeTx } : {}),
    }
  }

  private assertNotExpired() {
    if (this.expiresAtUnixMs !== undefined && Date.now() > this.expiresAtUnixMs) {
      throw new Error('Unbounded authorizer policy has expired')
    }
  }

  private assertProgramAllowed(channelProgram: string) {
    if (!this.allowedPrograms) {
      return
    }

    if (!this.allowedPrograms.has(channelProgram)) {
      throw new Error(`Channel program is not allowed: ${channelProgram}`)
    }
  }

  private assertMonotonic(
    channelId: string,
    sequence: number,
    cumulativeAmount: bigint,
    progress: ChannelProgress | undefined,
  ) {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error('Sequence must be a non-negative integer')
    }

    if (!progress) {
      return
    }

    if (sequence <= progress.lastSequence) {
      throw new Error(
        `Sequence must increase for channel ${channelId}. Last=${progress.lastSequence}, received=${sequence}`,
      )
    }

    if (cumulativeAmount < progress.lastCumulative) {
      throw new Error(
        `Cumulative amount must not decrease for channel ${channelId}. Last=${progress.lastCumulative.toString()}, received=${cumulativeAmount.toString()}`,
      )
    }
  }

  private async resolveOpenTx(input: AuthorizeOpenInput): Promise<string> {
    if (!this.buildOpenTx) {
      throw new Error(
        'UnboundedAuthorizer requires `buildOpenTx` to authorize open requests',
      )
    }

    return await this.buildOpenTx(input)
  }

  private async resolveTopupTx(input: AuthorizeTopupInput): Promise<string> {
    if (!this.buildTopupTx) {
      throw new Error(
        'UnboundedAuthorizer requires `buildTopupTx` to authorize topup requests',
      )
    }

    return await this.buildTopupTx(input)
  }

  private async resolveCloseTx(
    input: AuthorizeCloseInput,
  ): Promise<string | undefined> {
    if (!this.buildCloseTx) {
      return undefined
    }

    return await this.buildCloseTx(input)
  }
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

function parseIsoTimestamp(value: string, field: string): number {
  const unixMs = Date.parse(value)
  if (Number.isNaN(unixMs)) {
    throw new Error(`${field} must be a valid ISO timestamp`)
  }
  return unixMs
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
