import {
  address,
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
  type MessagePartialSigner,
} from '@solana/kit'
import type { SessionVoucher, SignedSessionVoucher } from './Types.js'

const DOMAIN_SEPARATOR = 'solana-mpp-session-voucher-v1:'
const textEncoder = new TextEncoder()
const base58Encoder = getBase58Encoder()
const base58Decoder = getBase58Decoder()

export function serializeVoucher(voucher: SessionVoucher): Uint8Array {
  const canonical = JSON.stringify(canonicalize(voucher))
  return textEncoder.encode(`${DOMAIN_SEPARATOR}${canonical}`)
}

export async function signVoucher(
  signer: MessagePartialSigner,
  voucher: SessionVoucher,
): Promise<SignedSessionVoucher> {
  const signable = createSignableMessage(serializeVoucher(voucher))
  const [signatureDictionary] = await signer.signMessages([signable])
  const signatureValue = signatureDictionary[signer.address]

  if (!signatureValue) {
    throw new Error('Signer did not produce a voucher signature')
  }

  return {
    voucher,
    signer: signer.address,
    signature: base58Decoder.decode(signatureValue),
    signatureType: 'ed25519',
  }
}

export async function verifyVoucherSignature(
  signed: SignedSessionVoucher,
): Promise<boolean> {
  if (
    signed.signatureType !== 'ed25519' &&
    signed.signatureType !== 'swig-session'
  ) {
    return false
  }

  try {
    const publicKey = await getPublicKeyFromAddress(address(signed.signer))
    const signature = signatureBytes(base58Encoder.encode(signed.signature))
    const serialized = serializeVoucher(signed.voucher)
    return await verifySignature(publicKey, signature, serialized)
  } catch {
    return false
  }
}

export function parseVoucherFromPayload(payload: any): SignedSessionVoucher {
  const maybeRoot = asRecord(payload, 'Session payload must be an object')
  const source = hasSignedVoucherEnvelope(maybeRoot)
    ? maybeRoot
    : asRecord(
        maybeRoot.voucher,
        'Payload must include a signed voucher in `voucher`',
      )

  const rawVoucher = asRecord(
    source.voucher,
    'Signed voucher must include `voucher` object',
  )

  const signatureTypeRaw = readString(source, 'signatureType')
  if (signatureTypeRaw !== 'ed25519' && signatureTypeRaw !== 'swig-session') {
    throw new Error(
      'Signed voucher `signatureType` must be "ed25519" or "swig-session"',
    )
  }

  const expiresAt = readOptionalString(rawVoucher, 'expiresAt')

  return {
    voucher: {
      channelId: readString(rawVoucher, 'channelId'),
      payer: readString(rawVoucher, 'payer'),
      recipient: readString(rawVoucher, 'recipient'),
      cumulativeAmount: readString(rawVoucher, 'cumulativeAmount'),
      sequence: readInteger(rawVoucher, 'sequence'),
      meter: readString(rawVoucher, 'meter'),
      units: readString(rawVoucher, 'units'),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      serverNonce: readString(rawVoucher, 'serverNonce'),
      chainId: readString(rawVoucher, 'chainId'),
      channelProgram: readString(rawVoucher, 'channelProgram'),
    },
    signer: readString(source, 'signer'),
    signature: readString(source, 'signature'),
    signatureType: signatureTypeRaw,
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}

    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item !== undefined) {
        normalized[key] = canonicalize(item)
      }
    }

    return normalized
  }

  return value
}

function hasSignedVoucherEnvelope(
  value: Record<string, unknown>,
): value is {
  voucher: unknown
  signer: unknown
  signature: unknown
  signatureType: unknown
} {
  return (
    'voucher' in value &&
    'signer' in value &&
    'signature' in value &&
    'signatureType' in value
  )
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }

  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`Expected string field: ${key}`)
  }
  return value
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected optional string field: ${key}`)
  }
  return value
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value)) {
    throw new Error(`Expected integer field: ${key}`)
  }
  return value as number
}
