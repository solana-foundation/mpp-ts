import { charge as charge_, type ChargeParameters } from './Charge.js';
import { session as session_ } from './Session.js';

export type { ChargeParameters } from './Charge.js';
export type { SessionParameters } from './Session.js';

/**
 * Creates Solana payment methods for usage on the server.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   methods: [solana.charge({ recipient: '...', network: 'devnet' })],
 * })
 * ```
 */
export const solana: {
    (parameters: ChargeParameters): ReturnType<typeof charge_>;
    charge: typeof charge_;
    session: typeof session_;
} = Object.assign((parameters: ChargeParameters) => solana.charge(parameters), {
    charge: charge_,
    session: session_,
});
