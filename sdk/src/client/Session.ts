import type { TransactionSigner } from '@solana/kit';
import { type Challenge, Credential, Method, z } from 'mppx';

import * as Methods from '../Methods.js';
import type { SessionAuthorizer, SessionCredentialPayload } from '../session/Types.js';

type SessionAsset = {
    decimals: number;
    kind: 'sol' | 'spl';
    mint?: string;
    symbol?: string;
};

type SessionPricing = {
    amountPerUnit: string;
    meter: string;
    minDebit?: string;
    unit: string;
};

type SessionChallengeRequest = {
    asset: SessionAsset;
    channelProgram: string;
    network?: string;
    pricing?: SessionPricing;
    recipient: string;
    sessionDefaults?: {
        closeBehavior?: 'payer_must_close' | 'server_may_finalize';
        settleInterval?: { kind: string; minIncrement?: string; seconds?: number };
        suggestedDeposit?: string;
        ttlSeconds?: number;
    };
};

type ActiveChannel = {
    asset: SessionAsset;
    channelId: string;
    channelProgram: string;
    cumulativeAmount: bigint;
    depositAmount: bigint;
    network: string;
    recipient: string;
    sequence: number;
    serverNonce: string;
};

export const sessionContextSchema = z.object({
    action: z.optional(z.enum(['open', 'update', 'topup', 'close'])),
    additionalAmount: z.optional(z.string()),
    channelId: z.optional(z.string()),
    cumulativeAmount: z.optional(z.string()),
    depositAmount: z.optional(z.string()),
    openTx: z.optional(z.string()),
    sequence: z.optional(z.number()),
    topupTx: z.optional(z.string()),
});

export type SessionContext = z.infer<typeof sessionContextSchema>;

export function session(parameters: SessionParameters) {
    const { signer, authorizer, autoOpen = true, autoTopup = false, settleOnLimitHit = false, onProgress } = parameters;

    let activeChannel: ActiveChannel | null = null;

    return Method.toClient(Methods.session, {
        context: sessionContextSchema,

        async createCredential({ challenge, context }) {
            const request = challenge.request as SessionChallengeRequest;
            const recipient = request.recipient;
            const network = request.network ?? 'mainnet-beta';
            const asset = request.asset;
            const channelProgram = request.channelProgram;
            const pricing = request.pricing;
            const sessionDefaults = request.sessionDefaults;

            onProgress?.({
                asset,
                network,
                recipient,
                type: 'challenge',
            });

            if (context?.action === 'topup') {
                return await handleTopupAction(challenge, context, authorizer, activeChannel, channelProgram, network);
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
                );

                activeChannel = null;
                return credential;
            }

            if (context?.action === 'open') {
                if (!context.channelId) {
                    throw new Error('channelId is required for open action');
                }

                if (!context.depositAmount) {
                    throw new Error('depositAmount is required for open action');
                }

                const channelId = context.channelId;
                const depositAmount = context.depositAmount;
                const parsedDepositAmount = parseNonNegativeAmount(depositAmount, 'context.depositAmount');
                const serverNonce = crypto.randomUUID();

                onProgress?.({ channelId, type: 'opening' });

                const openResult = await authorizer.authorizeOpen({
                    asset,
                    channelId,
                    channelProgram,
                    depositAmount,
                    network,
                    pricing,
                    recipient,
                    serverNonce,
                });

                const payer = resolveOpenPayer(openResult.voucher.voucher.payer, signer);

                const payload: SessionCredentialPayload = {
                    action: 'open',
                    authorizationMode: authorizer.getMode(),
                    channelId,
                    depositAmount,
                    openTx: context.openTx ?? openResult.openTx,
                    payer,
                    ...(openResult.expiresAt ? { expiresAt: openResult.expiresAt } : {}),
                    capabilities: {
                        ...(openResult.capabilities.maxCumulativeAmount
                            ? {
                                  maxCumulativeAmount: openResult.capabilities.maxCumulativeAmount,
                              }
                            : {}),
                        ...(openResult.capabilities.allowedActions
                            ? { allowedActions: openResult.capabilities.allowedActions }
                            : {}),
                    },
                    voucher: openResult.voucher,
                };

                activeChannel = {
                    asset: normalizeAsset(asset),
                    channelId,
                    channelProgram,
                    cumulativeAmount: parseNonNegativeAmount(
                        openResult.voucher.voucher.cumulativeAmount,
                        'voucher.cumulativeAmount',
                    ),
                    depositAmount: parsedDepositAmount,
                    network,
                    recipient,
                    sequence: assertNonNegativeSequence(openResult.voucher.voucher.sequence),
                    serverNonce: openResult.voucher.voucher.serverNonce,
                };

                onProgress?.({ channelId, type: 'opened' });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            if (context?.action === 'update') {
                const channelId = context.channelId ?? activeChannel?.channelId;
                if (!channelId) {
                    throw new Error('channelId is required for update action');
                }

                if (!activeChannel || activeChannel.channelId !== channelId) {
                    throw new Error('Cannot update a channel that is not active');
                }

                if (!context.cumulativeAmount) {
                    throw new Error('cumulativeAmount is required for update action');
                }

                if (context.sequence === undefined) {
                    throw new Error('sequence is required for update action');
                }

                const nextCumulativeAmount = parseNonNegativeAmount(
                    context.cumulativeAmount,
                    'context.cumulativeAmount',
                );
                const nextSequence = assertNonNegativeSequence(context.sequence);

                onProgress?.({
                    channelId,
                    cumulativeAmount: nextCumulativeAmount.toString(),
                    type: 'updating',
                });

                const updateResult = await authorizer.authorizeUpdate({
                    channelId,
                    channelProgram,
                    cumulativeAmount: nextCumulativeAmount.toString(),
                    meter: pricing?.meter ?? 'session',
                    network,
                    recipient,
                    sequence: nextSequence,
                    serverNonce: activeChannel.serverNonce,
                    units: pricing ? '1' : '0',
                });

                const payload: SessionCredentialPayload = {
                    action: 'update',
                    channelId,
                    voucher: updateResult.voucher,
                };

                activeChannel.cumulativeAmount = parseNonNegativeAmount(
                    updateResult.voucher.voucher.cumulativeAmount,
                    'voucher.cumulativeAmount',
                );
                activeChannel.sequence = assertNonNegativeSequence(updateResult.voucher.voucher.sequence);
                activeChannel.serverNonce = updateResult.voucher.voucher.serverNonce;

                onProgress?.({
                    channelId,
                    cumulativeAmount: activeChannel.cumulativeAmount.toString(),
                    type: 'updated',
                });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            const scopedActiveChannel =
                activeChannel &&
                matchesScope(activeChannel, {
                    asset,
                    channelProgram,
                    network,
                    recipient,
                })
                    ? activeChannel
                    : null;

            if (!scopedActiveChannel) {
                if (!autoOpen) {
                    throw new Error('No active session channel for challenge scope and autoOpen is disabled');
                }

                const channelId = crypto.randomUUID();
                const serverNonce = crypto.randomUUID();
                const depositAmount = sessionDefaults?.suggestedDeposit ?? '0';
                const parsedDepositAmount = parseNonNegativeAmount(depositAmount, 'sessionDefaults.suggestedDeposit');

                onProgress?.({ channelId, type: 'opening' });

                const openResult = await authorizer.authorizeOpen({
                    asset,
                    channelId,
                    channelProgram,
                    depositAmount,
                    network,
                    pricing,
                    recipient,
                    serverNonce,
                });

                const payer = resolveOpenPayer(openResult.voucher.voucher.payer, signer);

                const payload: SessionCredentialPayload = {
                    action: 'open',
                    authorizationMode: authorizer.getMode(),
                    channelId,
                    depositAmount,
                    openTx: openResult.openTx,
                    payer,
                    ...(openResult.expiresAt ? { expiresAt: openResult.expiresAt } : {}),
                    capabilities: {
                        ...(openResult.capabilities.maxCumulativeAmount
                            ? {
                                  maxCumulativeAmount: openResult.capabilities.maxCumulativeAmount,
                              }
                            : {}),
                        ...(openResult.capabilities.allowedActions
                            ? { allowedActions: openResult.capabilities.allowedActions }
                            : {}),
                    },
                    voucher: openResult.voucher,
                };

                activeChannel = {
                    asset: normalizeAsset(asset),
                    channelId,
                    channelProgram,
                    cumulativeAmount: parseNonNegativeAmount(
                        openResult.voucher.voucher.cumulativeAmount,
                        'voucher.cumulativeAmount',
                    ),
                    depositAmount: parsedDepositAmount,
                    network,
                    recipient,
                    sequence: assertNonNegativeSequence(openResult.voucher.voucher.sequence),
                    serverNonce: openResult.voucher.voucher.serverNonce,
                };

                onProgress?.({ channelId, type: 'opened' });

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            const debitIncrement = resolveDebitIncrement(pricing);
            const nextCumulativeAmount = scopedActiveChannel.cumulativeAmount + debitIncrement;
            const nextSequence = scopedActiveChannel.sequence + 1;

            if (nextCumulativeAmount > scopedActiveChannel.depositAmount) {
                if (!autoTopup) {
                    if (!settleOnLimitHit) {
                        throw new Error('Voucher cumulative amount exceeds tracked deposit and autoTopup is disabled');
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
                    );

                    activeChannel = null;
                    return closeCredential;
                }

                const additionalAmount = resolveAutoTopupAmount(
                    sessionDefaults?.suggestedDeposit,
                    nextCumulativeAmount,
                    scopedActiveChannel.depositAmount,
                );

                const topupResult = await authorizer.authorizeTopup({
                    additionalAmount: additionalAmount.toString(),
                    channelId: scopedActiveChannel.channelId,
                    channelProgram,
                    network,
                });

                scopedActiveChannel.depositAmount += additionalAmount;

                const payload: SessionCredentialPayload = {
                    action: 'topup',
                    additionalAmount: additionalAmount.toString(),
                    channelId: scopedActiveChannel.channelId,
                    topupTx: topupResult.topupTx,
                };

                return Credential.serialize({
                    challenge,
                    payload,
                });
            }

            onProgress?.({
                channelId: scopedActiveChannel.channelId,
                cumulativeAmount: nextCumulativeAmount.toString(),
                type: 'updating',
            });

            const updateResult = await authorizer.authorizeUpdate({
                channelId: scopedActiveChannel.channelId,
                channelProgram,
                cumulativeAmount: nextCumulativeAmount.toString(),
                meter: pricing?.meter ?? 'session',
                network,
                recipient,
                sequence: nextSequence,
                serverNonce: scopedActiveChannel.serverNonce,
                units: pricing ? '1' : '0',
            });

            const payload: SessionCredentialPayload = {
                action: 'update',
                channelId: scopedActiveChannel.channelId,
                voucher: updateResult.voucher,
            };

            scopedActiveChannel.cumulativeAmount = parseNonNegativeAmount(
                updateResult.voucher.voucher.cumulativeAmount,
                'voucher.cumulativeAmount',
            );
            scopedActiveChannel.sequence = assertNonNegativeSequence(updateResult.voucher.voucher.sequence);
            scopedActiveChannel.serverNonce = updateResult.voucher.voucher.serverNonce;

            onProgress?.({
                channelId: scopedActiveChannel.channelId,
                cumulativeAmount: scopedActiveChannel.cumulativeAmount.toString(),
                type: 'updated',
            });

            return Credential.serialize({
                challenge,
                payload,
            });
        },
    });
}

async function handleTopupAction(
    challenge: Challenge.Challenge,
    context: SessionContext,
    authorizer: SessionAuthorizer,
    activeChannel: ActiveChannel | null,
    channelProgram: string,
    network: string,
): Promise<string> {
    const channelId = context.channelId ?? activeChannel?.channelId;
    if (!channelId) {
        throw new Error('channelId is required for topup action');
    }
    if (!context.additionalAmount) {
        throw new Error('additionalAmount is required for topup action');
    }

    const additionalAmount = parseNonNegativeAmount(context.additionalAmount, 'context.additionalAmount');

    const topupResult = await authorizer.authorizeTopup({
        additionalAmount: additionalAmount.toString(),
        channelId,
        channelProgram,
        network,
    });

    if (activeChannel && activeChannel.channelId === channelId) {
        activeChannel.depositAmount += additionalAmount;
    }

    const payload: SessionCredentialPayload = {
        action: 'topup',
        additionalAmount: additionalAmount.toString(),
        channelId,
        topupTx: topupResult.topupTx,
    };

    return Credential.serialize({ challenge, payload });
}

async function handleCloseAction(
    challenge: Challenge.Challenge,
    context: SessionContext,
    authorizer: SessionAuthorizer,
    activeChannel: ActiveChannel | null,
    channelProgram: string,
    recipient: string,
    network: string,
    onProgress?: SessionParameters['onProgress'],
): Promise<string> {
    const channelId = context.channelId ?? activeChannel?.channelId;
    if (!channelId) {
        throw new Error('channelId is required for close action');
    }

    if (!activeChannel || activeChannel.channelId !== channelId) {
        throw new Error('Cannot close a channel that is not active');
    }

    const finalSequence = activeChannel.sequence + 1;

    onProgress?.({ channelId, type: 'closing' });

    const closeResult = await authorizer.authorizeClose({
        channelId,
        channelProgram,
        finalCumulativeAmount: activeChannel.cumulativeAmount.toString(),
        network,
        recipient,
        sequence: finalSequence,
        serverNonce: activeChannel.serverNonce,
    });

    const payload: SessionCredentialPayload = {
        action: 'close',
        channelId,
        ...(closeResult.closeTx ? { closeTx: closeResult.closeTx } : {}),
        voucher: closeResult.voucher,
    };

    onProgress?.({ channelId, type: 'closed' });

    return Credential.serialize({ challenge, payload });
}

function resolveDebitIncrement(pricing?: SessionPricing): bigint {
    if (pricing?.minDebit !== undefined) {
        return parseNonNegativeAmount(pricing.minDebit, 'pricing.minDebit');
    }

    if (pricing?.amountPerUnit !== undefined) {
        return parseNonNegativeAmount(pricing.amountPerUnit, 'pricing.amountPerUnit');
    }

    return 0n;
}

function resolveAutoTopupAmount(
    suggestedDeposit: string | undefined,
    nextCumulativeAmount: bigint,
    depositAmount: bigint,
): bigint {
    const shortfall = nextCumulativeAmount - depositAmount;
    if (shortfall <= 0n) {
        return 0n;
    }

    if (suggestedDeposit === undefined) {
        return shortfall;
    }

    const parsedSuggestedDeposit = parseNonNegativeAmount(suggestedDeposit, 'sessionDefaults.suggestedDeposit');
    return parsedSuggestedDeposit > shortfall ? parsedSuggestedDeposit : shortfall;
}

function matchesScope(
    active: ActiveChannel,
    scope: {
        asset: SessionAsset;
        channelProgram: string;
        network: string;
        recipient: string;
    },
): boolean {
    if (active.recipient !== scope.recipient) {
        return false;
    }

    if (active.network !== scope.network) {
        return false;
    }

    if (active.channelProgram !== scope.channelProgram) {
        return false;
    }

    return sameAsset(active.asset, scope.asset);
}

function sameAsset(left: SessionAsset, right: SessionAsset): boolean {
    return (
        left.kind === right.kind &&
        left.decimals === right.decimals &&
        (left.mint ?? '') === (right.mint ?? '') &&
        (left.symbol ?? '') === (right.symbol ?? '')
    );
}

function normalizeAsset(asset: SessionAsset): SessionAsset {
    return {
        decimals: asset.decimals,
        kind: asset.kind,
        ...(asset.mint ? { mint: asset.mint } : {}),
        ...(asset.symbol ? { symbol: asset.symbol } : {}),
    };
}

function assertNonNegativeSequence(value: number): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('voucher.sequence must be a non-negative integer');
    }

    return value;
}

function parseNonNegativeAmount(value: string, field: string): bigint {
    let amount: bigint;
    try {
        amount = BigInt(value);
    } catch {
        throw new Error(`${field} must be a valid integer string`);
    }

    if (amount < 0n) {
        throw new Error(`${field} must be non-negative`);
    }

    return amount;
}

function resolveOpenPayer(voucherPayer: string, signer?: TransactionSigner): string {
    if (signer && signer.address !== voucherPayer) {
        throw new Error(`Open voucher payer ${voucherPayer} does not match signer address ${signer.address}`);
    }

    return voucherPayer;
}

export type SessionParameters = {
    authorizer: SessionAuthorizer;
    autoOpen?: boolean;
    autoTopup?: boolean;
    onProgress?: (event: SessionProgressEvent) => void;
    settleOnLimitHit?: boolean;
    signer?: TransactionSigner;
};

export type SessionProgressEvent =
    | { asset: SessionAsset; network: string; recipient: string; type: 'challenge' }
    | { channelId: string; cumulativeAmount: string; type: 'updated' }
    | { channelId: string; cumulativeAmount: string; type: 'updating' }
    | { channelId: string; type: 'closed' }
    | { channelId: string; type: 'closing' }
    | { channelId: string; type: 'opened' }
    | { channelId: string; type: 'opening' };
