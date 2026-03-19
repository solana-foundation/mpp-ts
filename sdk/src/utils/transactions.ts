import {
  getTransactionDecoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageCodec,
  getTransactionLifetimeConstraintFromCompiledTransactionMessage,
  assertIsTransactionWithinSizeLimit,
  type TransactionPartialSigner,
  type Base64EncodedWireTransaction,
} from '@solana/kit'

/**
 * Decode a base64 wire transaction, co-sign it with a TransactionPartialSigner,
 * and return the co-signed base64 wire transaction.
 *
 * This bridges the gap between Kit's `partiallySignTransaction` (which takes
 * raw CryptoKeyPair[]) and the wider `TransactionPartialSigner` interface
 * (Keychain, Privy, Turnkey, AWS KMS, etc.).
 */
export async function coSignBase64Transaction(
  signer: TransactionPartialSigner,
  clientTxBase64: string,
): Promise<Base64EncodedWireTransaction> {
  // 1. Decode wire bytes → Transaction
  const txBytes = getBase64Codec().encode(clientTxBase64)
  const tx = getTransactionDecoder().decode(txBytes)

  // 2. Reconstruct lifetime from compiled message
  //    (decoded wire transactions lose the type-level lifetime constraint)
  const compiled = getCompiledTransactionMessageCodec().decode(tx.messageBytes)
  const lifetimeConstraint =
    await getTransactionLifetimeConstraintFromCompiledTransactionMessage(compiled)
  const txWithLifetime = { ...tx, lifetimeConstraint }

  // 3. Validate
  assertIsTransactionWithinSizeLimit(txWithLifetime)

  // 4. Partial-sign via the signer interface
  const [sigDict] = await signer.signTransactions([txWithLifetime])
  if (!sigDict?.[signer.address]) {
    throw new Error(
      `Co-signer ${signer.address} returned no signature for its address`,
    )
  }

  // 5. Merge signatures and return
  const cosigned = Object.freeze({
    ...txWithLifetime,
    signatures: Object.freeze({
      ...txWithLifetime.signatures,
      ...sigDict,
    }),
  })

  return getBase64EncodedWireTransaction(cosigned)
}
