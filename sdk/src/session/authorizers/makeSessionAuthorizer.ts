import type { MessagePartialSigner } from '@solana/kit'
import type { SessionAuthorizer, SessionPolicyProfile } from '../Types.js'
import {
  BudgetAuthorizer,
  type BudgetAuthorizerParameters,
} from './BudgetAuthorizer.js'
import {
  SwigSessionAuthorizer,
  type SwigWalletAdapter,
} from './SwigSessionAuthorizer.js'
import {
  UnboundedAuthorizer,
  type UnboundedAuthorizerParameters,
} from './UnboundedAuthorizer.js'

export interface MakeSessionAuthorizerParameters {
  profile: SessionPolicyProfile
  signer?: MessagePartialSigner
  swigWallet?: SwigWalletAdapter
  rpcUrl?: string
  allowedPrograms?: string[]
  buildOpenTx?: (input: Parameters<NonNullable<BudgetAuthorizerParameters['buildOpenTx']>>[0]) => Promise<string> | string
  buildTopupTx?: (
    input: Parameters<NonNullable<BudgetAuthorizerParameters['buildTopupTx']>>[0],
  ) => Promise<string> | string
  buildCloseTx?: (
    input: Parameters<NonNullable<BudgetAuthorizerParameters['buildCloseTx']>>[0],
  ) => Promise<string> | string
}

/**
 * Factory that maps session policy profiles to concrete authorizer classes.
 */
export function makeSessionAuthorizer(
  parameters: MakeSessionAuthorizerParameters,
): SessionAuthorizer {
  const { profile } = parameters

  switch (profile.profile) {
    case 'wallet-budget': {
      const signer = requireSigner(parameters.signer, profile.profile)

      // Budget mode is Swig-role-backed and intentionally fail-closed.
      if (!parameters.swigWallet?.swigAddress) {
        throw new Error(
          'makeSessionAuthorizer requires `swigWallet.swigAddress` for profile "wallet-budget"',
        )
      }

      if (parameters.swigWallet.swigRoleId === undefined) {
        throw new Error(
          'makeSessionAuthorizer requires `swigWallet.swigRoleId` for profile "wallet-budget"',
        )
      }

      return new BudgetAuthorizer({
        signer,
        maxCumulativeAmount: profile.maxCumulativeAmount,
        ...(profile.maxDepositAmount
          ? { maxDepositAmount: profile.maxDepositAmount }
          : {}),
        ...(profile.validUntil ? { validUntil: profile.validUntil } : {}),
        requireApprovalOnTopup: profile.requireApprovalOnTopup,
        ...(parameters.allowedPrograms
          ? { allowedPrograms: parameters.allowedPrograms }
          : {}),
        swig: {
          swigAddress: parameters.swigWallet.swigAddress,
          swigRoleId: parameters.swigWallet.swigRoleId,
          ...(parameters.rpcUrl ? { rpcUrl: parameters.rpcUrl } : {}),
        },
        ...(parameters.buildOpenTx ? { buildOpenTx: parameters.buildOpenTx } : {}),
        ...(parameters.buildTopupTx
          ? { buildTopupTx: parameters.buildTopupTx }
          : {}),
        ...(parameters.buildCloseTx
          ? { buildCloseTx: parameters.buildCloseTx }
          : {}),
      })
    }

    case 'wallet-manual': {
      const signer = requireSigner(parameters.signer, profile.profile)
      const authorizerParameters: UnboundedAuthorizerParameters = {
        signer,
        ...(parameters.allowedPrograms
          ? { allowedPrograms: parameters.allowedPrograms }
          : {}),
        ...(parameters.buildOpenTx ? { buildOpenTx: parameters.buildOpenTx } : {}),
        ...(parameters.buildTopupTx
          ? { buildTopupTx: parameters.buildTopupTx }
          : {}),
        ...(parameters.buildCloseTx
          ? { buildCloseTx: parameters.buildCloseTx }
          : {}),
        requiresInteractiveApproval: {
          update: profile.requireApprovalOnEveryUpdate,
        },
      }

      return new UnboundedAuthorizer(authorizerParameters)
    }

    case 'swig-time-bound': {
      if (!parameters.swigWallet) {
        throw new Error(
          'makeSessionAuthorizer requires `swigWallet` for profile "swig-time-bound"',
        )
      }

      return new SwigSessionAuthorizer({
        wallet: parameters.swigWallet,
        policy: profile,
        ...(parameters.rpcUrl ? { rpcUrl: parameters.rpcUrl } : {}),
        ...(parameters.allowedPrograms
          ? { allowedPrograms: parameters.allowedPrograms }
          : {}),
        ...(parameters.buildOpenTx ? { buildOpenTx: parameters.buildOpenTx } : {}),
        ...(parameters.buildTopupTx
          ? { buildTopupTx: parameters.buildTopupTx }
          : {}),
        ...(parameters.buildCloseTx
          ? { buildCloseTx: parameters.buildCloseTx }
          : {}),
      })
    }
  }
}

function requireSigner(
  signer: MessagePartialSigner | undefined,
  profile: SessionPolicyProfile['profile'],
): MessagePartialSigner {
  if (!signer) {
    throw new Error(
      `makeSessionAuthorizer requires \`signer\` for profile "${profile}"`,
    )
  }
  return signer
}
