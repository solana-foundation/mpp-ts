/**
 * Compact binary voucher format for on-chain Ed25519 verification.
 *
 * The JCS JSON voucher is variable-length. For on-chain settle/close
 * transactions, the Ed25519 precompile instruction needs the signed message
 * bytes. This binary format provides a fixed-size representation that the
 * on-chain program can reconstruct from instruction args and account state.
 *
 * Layout:
 *   [0..32]   channel PDA (32 bytes)
 *   [32..40]  cumulative_amount (u64 LE)
 *   [40..48]  expiry (i64 LE, 0 if no expiry)
 *
 * Total: 48 bytes
 *
 * The on-chain program reconstructs these bytes from instruction args +
 * the channel account key, then validates that the Ed25519 precompile
 * instruction verified a signature over these exact bytes.
 */

import type { Address } from '@solana/kit';

export const BINARY_VOUCHER_SIZE = 48;

export interface BinaryVoucherFields {
    channel: Address;
    cumulativeAmount: bigint;
    expiry: bigint;
}

function addressToBytes(addressValue: Address): Uint8Array {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = 0n;
    for (const char of addressValue) {
        const index = alphabet.indexOf(char);
        if (index === -1) throw new Error(`Invalid base58 character: ${char}`);
        num = num * 58n + BigInt(index);
    }
    const bytes = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
    }
    return bytes;
}

function bytesToAddress(bytes: Uint8Array): Address {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = 0n;
    for (const byte of bytes) {
        num = num * 256n + BigInt(byte);
    }
    let encoded = '';
    while (num > 0n) {
        const remainder = Number(num % 58n);
        encoded = alphabet[remainder] + encoded;
        num /= 58n;
    }
    for (const byte of bytes) {
        if (byte === 0) {
            encoded = '1' + encoded;
        } else {
            break;
        }
    }
    return encoded as Address;
}

export function serializeBinaryVoucher(fields: BinaryVoucherFields): Uint8Array {
    const buf = new Uint8Array(BINARY_VOUCHER_SIZE);
    const view = new DataView(buf.buffer);

    buf.set(addressToBytes(fields.channel), 0);
    view.setBigUint64(32, fields.cumulativeAmount, true);
    view.setBigInt64(40, fields.expiry, true);

    return buf;
}

export function deserializeBinaryVoucher(data: Uint8Array): BinaryVoucherFields {
    if (data.length !== BINARY_VOUCHER_SIZE) {
        throw new Error(
            `Invalid binary voucher length: expected ${BINARY_VOUCHER_SIZE}, got ${data.length}`,
        );
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    return {
        channel: bytesToAddress(data.slice(0, 32)),
        cumulativeAmount: view.getBigUint64(32, true),
        expiry: view.getBigInt64(40, true),
    };
}
