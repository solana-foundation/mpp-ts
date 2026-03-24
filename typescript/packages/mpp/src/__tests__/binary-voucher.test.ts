import { describe, expect, it } from 'vitest';

import {
    BINARY_VOUCHER_SIZE,
    deserializeBinaryVoucher,
    serializeBinaryVoucher,
    type BinaryVoucherFields,
} from '../session/BinaryVoucher.js';

import type { Address } from '@solana/kit';

const TEST_CHANNEL = '11111111111111111111111111111112' as Address;

function makeTestVoucher(overrides?: Partial<BinaryVoucherFields>): BinaryVoucherFields {
    return {
        channel: TEST_CHANNEL,
        cumulativeAmount: 1_000_000n,
        expiry: 1700000000n,
        ...overrides,
    };
}

describe('BinaryVoucher', () => {
    describe('serialize / deserialize roundtrip', () => {
        it('roundtrips a typical voucher', () => {
            const original = makeTestVoucher();
            const bytes = serializeBinaryVoucher(original);
            expect(bytes.length).toBe(BINARY_VOUCHER_SIZE);

            const parsed = deserializeBinaryVoucher(bytes);
            expect(parsed.channel).toBe(original.channel);
            expect(parsed.cumulativeAmount).toBe(original.cumulativeAmount);
            expect(parsed.expiry).toBe(original.expiry);
        });

        it('handles zero values', () => {
            const voucher = makeTestVoucher({
                cumulativeAmount: 0n,
                expiry: 0n,
            });
            const parsed = deserializeBinaryVoucher(serializeBinaryVoucher(voucher));
            expect(parsed.cumulativeAmount).toBe(0n);
            expect(parsed.expiry).toBe(0n);
        });

        it('handles maximum u64 cumulative amount', () => {
            const maxU64 = (1n << 64n) - 1n;
            const voucher = makeTestVoucher({ cumulativeAmount: maxU64 });
            const parsed = deserializeBinaryVoucher(serializeBinaryVoucher(voucher));
            expect(parsed.cumulativeAmount).toBe(maxU64);
        });

        it('handles negative expiry (i64)', () => {
            const voucher = makeTestVoucher({ expiry: -1000n });
            const parsed = deserializeBinaryVoucher(serializeBinaryVoucher(voucher));
            expect(parsed.expiry).toBe(-1000n);
        });
    });

    describe('size', () => {
        it('produces exactly 48 bytes', () => {
            const bytes = serializeBinaryVoucher(makeTestVoucher());
            expect(bytes.length).toBe(48);
        });
    });

    describe('validation', () => {
        it('rejects wrong length', () => {
            expect(() => deserializeBinaryVoucher(new Uint8Array(100))).toThrow(
                'Invalid binary voucher length',
            );
        });

        it('rejects empty buffer', () => {
            expect(() => deserializeBinaryVoucher(new Uint8Array(0))).toThrow(
                'Invalid binary voucher length',
            );
        });
    });

    describe('deterministic serialization', () => {
        it('produces identical bytes for identical inputs', () => {
            const voucher = makeTestVoucher();
            const bytes1 = serializeBinaryVoucher(voucher);
            const bytes2 = serializeBinaryVoucher(voucher);
            expect(bytes1).toEqual(bytes2);
        });

        it('produces different bytes for different cumulative amounts', () => {
            const bytes1 = serializeBinaryVoucher(makeTestVoucher({ cumulativeAmount: 100n }));
            const bytes2 = serializeBinaryVoucher(makeTestVoucher({ cumulativeAmount: 200n }));
            expect(bytes1).not.toEqual(bytes2);
        });
    });
});
