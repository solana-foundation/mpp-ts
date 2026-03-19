import { createSolanaRpc, type MessagePartialSigner } from '@solana/kit'
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
import { DEFAULT_RPC_URLS } from '../../constants.js'

type SwigRoleActions = {
  canUseProgram?: (programId: string) => boolean
  solSpendLimit?: () => bigint | null
  tokenSpendLimit?: (mint: string) => bigint | null
}

type SwigAddressLike = {
  toBase58?: () => string
}

type SwigRoleAuthority = {
  publicKey?: SwigAddressLike
  ed25519PublicKey?: SwigAddressLike
  sessionKey?: SwigAddressLike
}

type SwigRole = {
  id: number
  actions?: SwigRoleActions
  authority?: SwigRoleAuthority
}

type SwigAccount = {
  findRoleById?: (id: number) => SwigRole | null
  findRoleBySessionKey?: (sessionKey: string) => SwigRole | null
  findRolesByEd25519SignerPk?: (signerPk: string) => SwigRole[]
}

export type BudgetSwigModule = {
  fetchSwig: (rpc: unknown, swigAddress: string) => Promise<SwigAccount>
}

type SwigOnChainRoleConfig = {
  swigAddress: string
  swigRoleId: number
  rpcUrl?: string
}

type ChannelProgress = {
  deposited: bigint
  lastCumulative: bigint
  lastSequence: number
  maxCumulativeAmount: bigint
  maxDepositAmount?: bigint
  swigRoleId?: number
}

export interface BudgetAuthorizerParameters {
  signer: MessagePartialSigner
  maxCumulativeAmount: string
  maxDepositAmount?: string
  validUntil?: string
  requireApprovalOnTopup?: boolean
  allowedPrograms?: string[]
  swig: SwigOnChainRoleConfig
  swigModule?: BudgetSwigModule
  buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string
  buildTopupTx?: (input: AuthorizeTopupInput) => Promise<string> | string
  buildCloseTx?: (input: AuthorizeCloseInput) => Promise<string> | string
}

/**
 * Session authorizer for `regular_budget` mode.
 *
 * Budget limits are fail-closed against a concrete on-chain Swig role:
 * - `authorizeOpen` reads role constraints from chain and clamps local limits.
 * - `authorizeUpdate`/`authorizeTopup`/`authorizeClose` require open-time state.
 * - Program access and spend caps are validated from Swig role actions.
 */
export class BudgetAuthorizer implements SessionAuthorizer {
  private readonly signer: MessagePartialSigner
  private readonly maxCumulativeAmount: bigint
  private readonly maxDepositAmount?: bigint
  private readonly validUntil?: string
  private readonly validUntilUnixMs?: number
  private readonly allowedPrograms?: Set<string>
  private readonly swig: SwigOnChainRoleConfig
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
  private swigLoaded = false
  private swigModule: BudgetSwigModule | null = null

  constructor(parameters: BudgetAuthorizerParameters) {
    if (!parameters.swig) {
      throw new Error(
        'BudgetAuthorizer requires `swig` configuration with on-chain role details',
      )
    }

    if (
      !Number.isInteger(parameters.swig.swigRoleId) ||
      parameters.swig.swigRoleId < 0
    ) {
      throw new Error('swig.swigRoleId must be a non-negative integer')
    }

    if (parameters.swig.swigAddress.trim().length === 0) {
      throw new Error('swig.swigAddress must be a non-empty string')
    }

    this.signer = parameters.signer
    this.maxCumulativeAmount = parseNonNegativeAmount(
      parameters.maxCumulativeAmount,
      'maxCumulativeAmount',
    )
    this.maxDepositAmount =
      parameters.maxDepositAmount !== undefined
        ? parseNonNegativeAmount(parameters.maxDepositAmount, 'maxDepositAmount')
        : undefined
    this.validUntil = parameters.validUntil
    this.validUntilUnixMs =
      parameters.validUntil !== undefined
        ? parseIsoTimestamp(parameters.validUntil, 'validUntil')
        : undefined
    this.allowedPrograms = parameters.allowedPrograms
      ? new Set(parameters.allowedPrograms)
      : undefined
    this.swig = {
      swigAddress: parameters.swig.swigAddress,
      swigRoleId: parameters.swig.swigRoleId,
      ...(parameters.swig.rpcUrl ? { rpcUrl: parameters.swig.rpcUrl } : {}),
    }
    if (parameters.swigModule) {
      this.swigModule = parameters.swigModule
      this.swigLoaded = true
    }
    this.buildOpenTx = parameters.buildOpenTx
    this.buildTopupTx = parameters.buildTopupTx
    this.buildCloseTx = parameters.buildCloseTx

    this.capabilities = {
      mode: 'regular_budget',
      ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
      maxCumulativeAmount: this.maxCumulativeAmount.toString(),
      ...(parameters.maxDepositAmount
        ? { maxDepositAmount: parameters.maxDepositAmount }
        : {}),
      ...(parameters.allowedPrograms
        ? { allowedPrograms: [...parameters.allowedPrograms] }
        : {}),
      allowedActions: ['open', 'update', 'topup', 'close'],
      requiresInteractiveApproval: {
        open: false,
        update: false,
        topup: parameters.requireApprovalOnTopup ?? false,
        close: false,
      },
    }
  }

  getMode() {
    return 'regular_budget' as const
  }

  getCapabilities(): AuthorizerCapabilities {
    return this.capabilities
  }

  async authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    // Pin this channel's effective limits from on-chain role metadata.
    const onChainConstraints = await this.resolveOnChainConstraints(input)

    const deposit = parseNonNegativeAmount(input.depositAmount, 'depositAmount')
    const maxDepositAmount =
      onChainConstraints.maxDepositAmount ?? this.maxDepositAmount
    if (maxDepositAmount !== undefined && deposit > maxDepositAmount) {
      throw new Error(
        `Open deposit exceeds maxDepositAmount (${maxDepositAmount.toString()})`,
      )
    }

    const openTx = await this.resolveOpenTx(input)

    const voucher = await signVoucher(this.signer, {
      channelId: input.channelId,
      payer: this.signer.address,
      recipient: input.recipient,
      cumulativeAmount: '0',
      sequence: 0,
      meter: input.pricing?.meter ?? 'session',
      units: '0',
      ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    this.channels.set(input.channelId, {
      deposited: deposit,
      lastCumulative: 0n,
      lastSequence: 0,
      maxCumulativeAmount:
        onChainConstraints.maxCumulativeAmount ?? this.maxCumulativeAmount,
      ...(maxDepositAmount !== undefined ? { maxDepositAmount } : {}),
      swigRoleId: onChainConstraints.swigRoleId,
    })

    return {
      openTx,
      voucher,
      capabilities: this.getCapabilities(),
      ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
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
    if (!progress) {
      throw new Error(
        `Unknown channel ${input.channelId}. Call authorizeOpen before authorizeUpdate.`,
      )
    }

    const maxCumulativeAmount = progress.maxCumulativeAmount

    if (cumulativeAmount > maxCumulativeAmount) {
      throw new Error(
        `Cumulative amount exceeds maxCumulativeAmount (${maxCumulativeAmount.toString()})`,
      )
    }

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
      ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    this.channels.set(input.channelId, {
      deposited: progress.deposited,
      lastCumulative: cumulativeAmount,
      lastSequence: input.sequence,
      maxCumulativeAmount,
      ...(progress.maxDepositAmount !== undefined
        ? { maxDepositAmount: progress.maxDepositAmount }
        : {}),
      ...(progress.swigRoleId !== undefined
        ? { swigRoleId: progress.swigRoleId }
        : {}),
    })

    return { voucher }
  }

  async authorizeTopup(input: AuthorizeTopupInput): Promise<AuthorizedTopup> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    const additionalAmount = parseNonNegativeAmount(
      input.additionalAmount,
      'additionalAmount',
    )
    const progress = this.channels.get(input.channelId)
    if (!progress) {
      throw new Error(
        `Unknown channel ${input.channelId}. Call authorizeOpen before authorizeTopup.`,
      )
    }

    const nextDeposited = progress.deposited + additionalAmount
    const maxDepositAmount =
      progress.maxDepositAmount ?? this.maxDepositAmount

    if (
      maxDepositAmount !== undefined &&
      nextDeposited > maxDepositAmount
    ) {
      throw new Error(
        `Topup exceeds maxDepositAmount (${maxDepositAmount.toString()})`,
      )
    }

    const topupTx = await this.resolveTopupTx(input)

    this.channels.set(input.channelId, {
      deposited: nextDeposited,
      lastCumulative: progress.lastCumulative,
      lastSequence: progress.lastSequence,
      maxCumulativeAmount: progress.maxCumulativeAmount,
      ...(maxDepositAmount !== undefined ? { maxDepositAmount } : {}),
      ...(progress.swigRoleId !== undefined
        ? { swigRoleId: progress.swigRoleId }
        : {}),
    })

    return { topupTx }
  }

  async authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose> {
    this.assertNotExpired()
    this.assertProgramAllowed(input.channelProgram)

    const finalCumulativeAmount = parseNonNegativeAmount(
      input.finalCumulativeAmount,
      'finalCumulativeAmount',
    )

    const progress = this.channels.get(input.channelId)
    if (!progress) {
      throw new Error(
        `Unknown channel ${input.channelId}. Call authorizeOpen before authorizeClose.`,
      )
    }

    const maxCumulativeAmount = progress.maxCumulativeAmount

    if (finalCumulativeAmount > maxCumulativeAmount) {
      throw new Error(
        `Final cumulative amount exceeds maxCumulativeAmount (${maxCumulativeAmount.toString()})`,
      )
    }

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
      ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
      serverNonce: input.serverNonce,
      chainId: normalizeChainId(input.network),
      channelProgram: input.channelProgram,
    })

    const closeTx = await this.resolveCloseTx(input)

    this.channels.set(input.channelId, {
      deposited: progress.deposited,
      lastCumulative: finalCumulativeAmount,
      lastSequence: input.sequence,
      maxCumulativeAmount,
      ...(progress.maxDepositAmount !== undefined
        ? { maxDepositAmount: progress.maxDepositAmount }
        : {}),
      ...(progress.swigRoleId !== undefined
        ? { swigRoleId: progress.swigRoleId }
        : {}),
    })

    return {
      voucher,
      ...(closeTx ? { closeTx } : {}),
    }
  }

  private assertNotExpired() {
    if (
      this.validUntilUnixMs !== undefined &&
      Date.now() > this.validUntilUnixMs
    ) {
      throw new Error('Budget authorizer policy has expired')
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

  private async resolveOnChainConstraints(
    input: AuthorizeOpenInput,
  ): Promise<{
    maxCumulativeAmount: bigint
    maxDepositAmount: bigint
    swigRoleId: number
  }> {
    // Budget mode requires Swig action metadata at runtime.
    await this.ensureSwigInstalled()

    const swigModule = this.swigModule
    if (!swigModule) {
      throw new Error('Swig SDK was not loaded before budget role validation')
    }

    const rpc = createSolanaRpc(this.resolveRpcUrl(input.network))
    const swig = await swigModule.fetchSwig(rpc, this.swig.swigAddress)
    const role = this.resolveSwigRole(swig)
    const actions = role.actions

    if (!actions) {
      throw new Error(
        `Swig role ${role.id} does not expose action metadata for budget validation`,
      )
    }

    if (!actions.canUseProgram) {
      throw new Error(
        `Swig role ${role.id} does not expose canUseProgram() for program authorization checks`,
      )
    }

    if (!actions.canUseProgram(input.channelProgram)) {
      throw new Error(
        `Swig role ${role.id} does not allow channel program ${input.channelProgram}`,
      )
    }

    const onChainLimit = this.resolveOnChainSpendLimit(actions, input)
    if (onChainLimit === null) {
      throw new Error(
        `Swig role ${role.id} has uncapped ${input.asset.kind.toUpperCase()} spending; BudgetAuthorizer requires an on-chain spend cap`,
      )
    }

    return {
      maxCumulativeAmount: minBigInt(this.maxCumulativeAmount, onChainLimit),
      maxDepositAmount:
        this.maxDepositAmount !== undefined
          ? minBigInt(this.maxDepositAmount, onChainLimit)
          : onChainLimit,
      swigRoleId: role.id,
    }
  }

  private resolveSwigRole(swig: SwigAccount): SwigRole {
    // Role ID is required by construction, so this path is deterministic.
    if (!swig.findRoleById) {
      throw new Error(
        'Swig account object does not expose findRoleById() required for configured swigRoleId',
      )
    }

    const role = swig.findRoleById(this.swig.swigRoleId)
    if (!role) {
      throw new Error(
        `Unable to locate Swig role ${this.swig.swigRoleId} for signer ${this.signer.address}`,
      )
    }

    if (swig.findRolesByEd25519SignerPk) {
      const signerRoles = swig.findRolesByEd25519SignerPk(this.signer.address)
      const roleMatchesSigner = signerRoles.some(
        (signerRole) => signerRole.id === role.id,
      )

      if (roleMatchesSigner) {
        return role
      }
    }

    if (swig.findRoleBySessionKey) {
      const sessionRole = swig.findRoleBySessionKey(this.signer.address)
      if (sessionRole?.id === role.id) {
        return role
      }
    }

    const authorityAddresses = collectAuthorityAddresses(role.authority)
    if (authorityAddresses.includes(this.signer.address)) {
      return role
    }

    throw new Error(
      `Configured Swig role ${role.id} does not match signer ${this.signer.address}`,
    )
  }

  private resolveOnChainSpendLimit(
    actions: SwigRoleActions,
    input: AuthorizeOpenInput,
  ): bigint | null {
    if (input.asset.kind === 'spl') {
      if (!input.asset.mint) {
        throw new Error('asset.mint is required for SPL budget validation')
      }

      if (!actions.tokenSpendLimit) {
        throw new Error(
          'Swig role does not expose tokenSpendLimit() for SPL budget validation',
        )
      }

      return actions.tokenSpendLimit(input.asset.mint)
    }

    if (!actions.solSpendLimit) {
      throw new Error(
        'Swig role does not expose solSpendLimit() for SOL budget validation',
      )
    }

    return actions.solSpendLimit()
  }

  private resolveRpcUrl(network: string): string {
    return (
      this.swig.rpcUrl ??
      DEFAULT_RPC_URLS[network] ??
      DEFAULT_RPC_URLS['mainnet-beta']
    )
  }

  private async ensureSwigInstalled() {
    if (this.swigLoaded) {
      return
    }

    try {
      const swigPackageName = '@swig-wallet/kit'
      const module = (await import(swigPackageName)) as Partial<BudgetSwigModule>
      if (typeof module.fetchSwig !== 'function') {
        throw new Error(
          'Installed `@swig-wallet/kit` does not export fetchSwig() at runtime',
        )
      }

      this.swigModule = {
        fetchSwig: module.fetchSwig,
      }
      this.swigLoaded = true
    } catch {
      throw new Error(
        'BudgetAuthorizer with `swig` config requires optional dependency `@swig-wallet/kit`. Install it with `npm install @swig-wallet/kit`.',
      )
    }
  }

  private async resolveOpenTx(input: AuthorizeOpenInput): Promise<string> {
    if (!this.buildOpenTx) {
      throw new Error(
        'BudgetAuthorizer requires `buildOpenTx` to authorize open requests',
      )
    }

    return await this.buildOpenTx(input)
  }

  private async resolveTopupTx(input: AuthorizeTopupInput): Promise<string> {
    if (!this.buildTopupTx) {
      throw new Error(
        'BudgetAuthorizer requires `buildTopupTx` to authorize topup requests',
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

function collectAuthorityAddresses(authority: SwigRoleAuthority | undefined): string[] {
  if (!authority) {
    return []
  }

  // Some Swig authority variants expose only one of these fields.
  const candidates = [
    authority.publicKey,
    authority.ed25519PublicKey,
    authority.sessionKey,
  ]

  return candidates
    .map((candidate) => candidate?.toBase58?.())
    .filter((candidate): candidate is string => !!candidate)
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

function minBigInt(a: bigint, b: bigint): bigint {
  return a <= b ? a : b
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
