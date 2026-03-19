import { charge as charge_, type ChargeParameters } from './Charge.js';
import { session as session_ } from './Session.js';

export type { ChargeParameters, ChargeProgressEvent } from './Charge.js';
export type { SessionParameters, SessionProgressEvent } from './Session.js';

/**
 * Creates a Solana `charge` method for usage on the client.
 *
 * Intercepts 402 responses, sends a Solana transaction to pay the challenge,
 * and retries with the transaction signature as credential automatically.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/client'
 *
 * const method = solana.charge({ signer })
 * const mppx = Mppx.create({ methods: [method] })
 *
 * const response = await mppx.fetch('https://api.example.com/paid-content')
 * ```
 */
export const solana: {
    (parameters: ChargeParameters): ReturnType<typeof charge_>;
    charge: typeof charge_;
    session: typeof session_;
} = Object.assign((parameters: ChargeParameters) => charge_(parameters), {
    charge: charge_,
    session: session_,
});
