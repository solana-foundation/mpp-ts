// Mainnet USDC mint — Surfpool clones it from the datasource network.
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDC_DECIMALS = 6
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

// Swig on-chain program used as session channel program namespace.
export const SESSION_CHANNEL_PROGRAM =
  'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB'

// Swig demo pricing is intentionally tiny for repeatable local testing.
// Values are in USDC base units (6 decimals).
export const SWIG_SESSION_PRICE_BASE_UNITS = '10000' // 0.01 USDC
export const SWIG_SESSION_SUGGESTED_DEPOSIT_BASE_UNITS = '30000' // 0.03 USDC
