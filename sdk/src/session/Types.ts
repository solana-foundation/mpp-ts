export type AuthorizationMode =
  | 'swig_session'
  | 'regular_budget'
  | 'regular_unbounded'

export interface SessionVoucher {
  channelId: string
  payer: string
  recipient: string
  cumulativeAmount: string
  sequence: number
  meter: string
  units: string
  expiresAt?: string
  serverNonce: string
  chainId: string
  channelProgram: string
}

export interface SignedSessionVoucher {
  voucher: SessionVoucher
  signer: string
  signature: string
  signatureType: 'ed25519' | 'swig-session'
}

export interface ChannelState {
  channelId: string
  payer: string
  recipient: string
  asset: { kind: 'sol' | 'spl'; mint?: string; decimals: number }
  escrowedAmount: string
  settledAmount: string
  lastAuthorizedAmount: string
  openSlot: number
  expiresAtUnix: number | null
  status: 'open' | 'closing' | 'closed' | 'expired'
  authorizationMode: AuthorizationMode
  authority: {
    wallet: string
    delegatedSessionKey?: string
    swigRoleId?: number
  }
  serverNonce: string
  lastSequence: number
  createdAt: string
}

export type SessionCredentialPayload =
  | {
      action: 'open'
      channelId: string
      payer: string
      authorizationMode: AuthorizationMode
      depositAmount: string
      openTx: string
      expiresAt?: string
      capabilities?: {
        maxCumulativeAmount?: string
        allowedActions?: string[]
      }
      voucher: SignedSessionVoucher
    }
  | {
      action: 'update'
      channelId: string
      voucher: SignedSessionVoucher
    }
  | {
      action: 'topup'
      channelId: string
      additionalAmount: string
      topupTx: string
    }
  | {
      action: 'close'
      channelId: string
      closeTx?: string
      voucher: SignedSessionVoucher
    }

export interface VoucherVerifier {
  verify(voucher: SignedSessionVoucher, channel: ChannelState): Promise<boolean>
}

export interface SessionAuthorizer {
  getMode(): AuthorizationMode
  authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen>
  authorizeUpdate(input: AuthorizeUpdateInput): Promise<AuthorizedUpdate>
  authorizeTopup(input: AuthorizeTopupInput): Promise<AuthorizedTopup>
  authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose>
  getCapabilities(): AuthorizerCapabilities
}

export interface AuthorizeOpenInput {
  channelId: string
  recipient: string
  asset: { kind: 'sol' | 'spl'; mint?: string; decimals: number }
  depositAmount: string
  channelProgram: string
  network: string
  serverNonce: string
  pricing?: { unit: string; amountPerUnit: string; meter: string }
}

export interface AuthorizedOpen {
  openTx: string
  voucher: SignedSessionVoucher
  capabilities: AuthorizerCapabilities
  expiresAt?: string
}

export interface AuthorizeUpdateInput {
  channelId: string
  cumulativeAmount: string
  sequence: number
  meter: string
  units: string
  serverNonce: string
  channelProgram: string
  recipient: string
  network: string
}

export interface AuthorizedUpdate {
  voucher: SignedSessionVoucher
}

export interface AuthorizeTopupInput {
  channelId: string
  additionalAmount: string
  channelProgram: string
  network: string
}

export interface AuthorizedTopup {
  topupTx: string
}

export interface AuthorizeCloseInput {
  channelId: string
  finalCumulativeAmount: string
  sequence: number
  serverNonce: string
  channelProgram: string
  recipient: string
  network: string
}

export interface AuthorizedClose {
  voucher: SignedSessionVoucher
  closeTx?: string
}

export interface AuthorizerCapabilities {
  mode: AuthorizationMode
  expiresAt?: string
  maxCumulativeAmount?: string
  maxDepositAmount?: string
  allowedPrograms?: string[]
  allowedActions?: Array<'open' | 'update' | 'topup' | 'close'>
  requiresInteractiveApproval: {
    open: boolean
    update: boolean
    topup: boolean
    close: boolean
  }
}

export type SessionPolicyProfile =
  | {
      profile: 'swig-time-bound'
      ttlSeconds: number
      spendLimit?: string
      depositLimit?: string
      autoTopup?: {
        enabled: boolean
        triggerBelow: string
        amount: string
      }
    }
  | {
      profile: 'wallet-budget'
      maxCumulativeAmount: string
      maxDepositAmount?: string
      validUntil?: string
      requireApprovalOnTopup?: boolean
    }
  | {
      profile: 'wallet-manual'
      requireApprovalOnEveryUpdate: boolean
    }
