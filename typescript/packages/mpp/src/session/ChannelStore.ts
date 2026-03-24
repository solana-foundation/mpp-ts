import { Store } from 'mppx';

import type { ChannelState } from './Types.js';

const CHANNEL_KEY_PREFIX = 'solana-session:channel:';
const storeCache = new WeakMap<Store.Store, ChannelStore>();

export interface ChannelStore {
    getChannel(channelId: string): Promise<ChannelState | null>;
    updateChannel(
        channelId: string,
        updater: (current: ChannelState | null) => ChannelState | null,
    ): Promise<ChannelState | null>;
}

export function fromStore(store: Store.Store): ChannelStore {
    const cached = storeCache.get(store);
    if (cached) {
        return cached;
    }

    const locks = new Map<string, Promise<void>>();

    async function update(
        channelId: string,
        updater: (current: ChannelState | null) => ChannelState | null,
    ): Promise<ChannelState | null> {
        const key = toStoreKey(channelId);

        while (locks.has(key)) {
            await locks.get(key);
        }

        let release!: () => void;
        locks.set(
            key,
            new Promise<void>(resolve => {
                release = resolve;
            }),
        );

        try {
            const current = await store.get<ChannelState | null>(key);
            const next = updater(current);

            if (next) {
                await store.put(key, next);
            } else {
                await store.delete(key);
            }

            return next;
        } finally {
            locks.delete(key);
            release();
        }
    }

    const channelStore: ChannelStore = {
        async getChannel(channelId) {
            return await store.get<ChannelState | null>(toStoreKey(channelId));
        },
        async updateChannel(channelId, updater) {
            return await update(channelId, updater);
        },
    };

    storeCache.set(store, channelStore);
    return channelStore;
}

export async function deductFromChannel(
    store: ChannelStore,
    channelId: string,
    amount: bigint,
): Promise<{ channel: ChannelState; ok: boolean }> {
    if (amount < 0n) {
        throw new Error('Deduction amount must be non-negative');
    }

    let deducted = false;

    const channel = await store.updateChannel(channelId, current => {
        deducted = false;

        if (!current) {
            return null;
        }

        const spentAmount = parseAtomicAmount(current.spentAmount, 'spentAmount');
        const acceptedCumulative = parseAtomicAmount(current.acceptedCumulative, 'acceptedCumulative');
        const escrowedAmount = parseAtomicAmount(current.escrowedAmount, 'escrowedAmount');

        const spendCeiling = acceptedCumulative < escrowedAmount ? acceptedCumulative : escrowedAmount;
        const nextSpentAmount = spentAmount + amount;

        if (nextSpentAmount > spendCeiling) {
            return current;
        }

        deducted = true;
        return {
            ...current,
            spentAmount: nextSpentAmount.toString(),
        };
    });

    if (!channel) {
        throw new Error('channel not found');
    }

    return {
        channel,
        ok: deducted,
    };
}

function toStoreKey(channelId: string): string {
    return `${CHANNEL_KEY_PREFIX}${channelId}`;
}

function parseAtomicAmount(value: string, field: string): bigint {
    try {
        return BigInt(value);
    } catch {
        throw new Error(`Invalid atomic amount in ${field}: ${value}`);
    }
}
