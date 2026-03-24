import type { TransactionPartialSigner } from '@solana/kit';

import { coSignBase64Transaction } from '../utils/transactions.js';

/**
 * Create a TransactionHandler for session open and topUp operations.
 *
 * Follows the charge intent's pull-mode pattern:
 * 1. Optionally co-sign as fee payer
 * 2. Simulate to catch errors before broadcast
 * 3. Broadcast via sendTransaction
 * 4. Poll getSignatureStatuses for confirmation
 * 5. Verify the confirmed transaction targets the expected channel program
 * 6. Return the confirmed signature
 */
export function createSessionTransactionHandler(params: {
    channelProgram: string;
    rpcUrl: string;
    signer?: TransactionPartialSigner;
}): {
    handleOpen: (channelId: string, transaction: string, deposit: string) => Promise<string>;
    handleTopUp: (channelId: string, transaction: string, amount: string) => Promise<string>;
} {
    const { channelProgram, rpcUrl, signer } = params;

    async function processTransaction(
        channelId: string,
        clientTxBase64: string,
        label: string,
    ): Promise<string> {
        let txToSend = clientTxBase64;

        if (signer) {
            txToSend = await coSignBase64Transaction(signer, clientTxBase64);
        }

        await simulateTransaction(rpcUrl, txToSend);
        const signature = await broadcastTransaction(rpcUrl, txToSend);
        await waitForConfirmation(rpcUrl, signature);

        const tx = await fetchTransaction(rpcUrl, signature);
        if (!tx) {
            throw new Error(`${label} transaction not found after confirmation: ${signature}`);
        }
        if (tx.meta?.err) {
            throw new Error(`${label} transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
        }

        verifyProgramInvoked(tx, channelProgram, label);

        return signature;
    }

    return {
        async handleOpen(channelId, transaction, _deposit) {
            return processTransaction(channelId, transaction, 'Open');
        },
        async handleTopUp(channelId, transaction, _amount) {
            return processTransaction(channelId, transaction, 'TopUp');
        },
    };
}

function verifyProgramInvoked(tx: ParsedTransaction, channelProgram: string, label: string): void {
    const instructions = tx.transaction.message.instructions;
    const invokesProgram = instructions.some(
        (ix: { programId?: string }) => ix.programId === channelProgram,
    );
    if (!invokesProgram) {
        throw new Error(
            `${label} transaction does not invoke the expected channel program ${channelProgram}`,
        );
    }
}

type ParsedTransaction = {
    meta: { err: unknown } | null;
    transaction: {
        message: {
            instructions: Array<{ programId?: string }>;
        };
    };
};

async function fetchTransaction(rpcUrl: string, signature: string): Promise<ParsedTransaction | null> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'getTransaction',
            params: [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as { error?: { message: string }; result?: ParsedTransaction | null };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    return data.result ?? null;
}

async function simulateTransaction(rpcUrl: string, base64Tx: string): Promise<void> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'simulateTransaction',
            params: [base64Tx, { commitment: 'confirmed', encoding: 'base64' }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as {
        error?: { message: string };
        result?: { value?: { err: unknown; logs?: string[] } };
    };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    const simErr = data.result?.value?.err;
    if (simErr) {
        const logs = data.result?.value?.logs ?? [];
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simErr)}. Logs: ${logs.join('; ')}`);
    }
}

async function broadcastTransaction(rpcUrl: string, base64Tx: string): Promise<string> {
    const response = await fetch(rpcUrl, {
        body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'sendTransaction',
            params: [base64Tx, { encoding: 'base64', skipPreflight: false }],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const data = (await response.json()) as { error?: { message: string }; result?: string };
    if (data.error) throw new Error(`RPC error: ${data.error.message}`);
    if (!data.result) throw new Error('No signature returned from sendTransaction');
    return data.result;
}

async function waitForConfirmation(rpcUrl: string, signature: string, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const response = await fetch(rpcUrl, {
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'getSignatureStatuses',
                params: [[signature]],
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        });
        const data = (await response.json()) as {
            result?: { value: ({ confirmationStatus: string; err: unknown } | null)[] };
        };
        const status = data.result?.value?.[0];
        if (status) {
            if (status.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return;
            }
        }
        await new Promise(r => setTimeout(r, 2_000));
    }
    throw new Error('Transaction confirmation timeout');
}
