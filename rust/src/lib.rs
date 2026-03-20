//! Solana payment method for the Machine Payments Protocol.
//!
//! This crate implements the `charge` intent for Solana, supporting
//! native SOL and SPL token transfers with two settlement modes:
//!
//! - **Pull mode** (`type="transaction"`): Client signs, server broadcasts.
//! - **Push mode** (`type="signature"`): Client broadcasts, server verifies.
//!
//! # Features
//!
//! - `server` — Server-side verification (enabled by default)
//! - `client` — Client-side transaction building (enabled by default)

pub mod protocol;

#[cfg(feature = "client")]
pub mod client;

pub mod error;

// Re-export crates callers need to use with the charge builder.
pub use solana_keychain;
pub use solana_rpc_client;
