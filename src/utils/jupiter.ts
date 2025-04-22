// src/api/jupiter.ts
import {
  createJupiterApiClient,
  QuoteGetRequest,
  SwapPostRequest,
} from '@jup-ag/api';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import dotenv from 'dotenv';
import { jupiterRateLimiter } from './rateLimiter';

dotenv.config();

// Solana setup
const RPC_URL = process.env.SOLANA_RPC_ENDPOINT!;
const connection = new Connection(RPC_URL, 'confirmed');

// Jupiter API setup
const JUPITER_ENDPOINT =
  process.env.JUPITER_API_URL || 'https://jupiter-swap-api.quiknode.pro/'; // Use public or Metis endpoint

const jupiterApi = createJupiterApiClient({
  basePath: JUPITER_ENDPOINT,
});

export async function swapOnJupiter(
  wallet: Keypair,
  fromMint: string,
  toMint: string,
  amountInLamports: number
): Promise<{
  amountOut: number;
  txid: string;
}> {
  // Step 1: Quote
  const quoteRequest: QuoteGetRequest = {
    inputMint: fromMint,
    outputMint: toMint,
    amount: amountInLamports,
    slippageBps: 50, // 0.5%
    onlyDirectRoutes: false,
  };

  await jupiterRateLimiter.waitForSlot();
  const quoteResponse = (await jupiterApi.quoteGet(quoteRequest)) as any;
  if (!quoteResponse || !quoteResponse.outAmount) {
    throw new Error('No route found.');
  }

  const bestRoute = quoteResponse.data[0];

  // Step 2: Get transaction
  const swapRequest: SwapPostRequest = {
    swapRequest: {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  };

  await jupiterRateLimiter.waitForSlot();
  const swapResponse = await jupiterApi.swapPost(swapRequest);
  if (!swapResponse.swapTransaction) {
    throw new Error('Failed to get swap transaction.');
  }

  // Step 3: Decode, sign, and send
  const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const txid = await connection.sendTransaction(tx);

  return {
    amountOut: parseInt(bestRoute.outAmount),
    txid,
  };
}
