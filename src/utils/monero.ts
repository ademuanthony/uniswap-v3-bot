import {
  MoneroWalletRpc,
  connectToWalletRpc,
} from 'monero-ts';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.MONERO_RPC_URL || 'http://127.0.0.1:18083';
const RPC_USERNAME = process.env.MONERO_RPC_USERNAME || 'walletuser';
const RPC_PASSWORD = process.env.MONERO_RPC_PASSWORD || 'walletpass';

let walletClient: MoneroWalletRpc | null = null;

export async function connectWallet() {
  if (!walletClient) {
    walletClient = await connectToWalletRpc(RPC_URL, RPC_USERNAME, RPC_PASSWORD);
  }
  return walletClient;
}


interface CreateWalletParams {
  filename: string;
  language: string; // mnemonic seed language (e.g., "English")
  password: string;
}

export async function createMoneroWallet(params: CreateWalletParams) {
  const client = await connectWallet();
  const wallet = await client.createWallet({
    path: params.filename,
    password: params.password,
    language: params.language,
  });
  console.log(`✅ Wallet created: ${params.filename}`);
  return wallet;
}

export async function openWallet(filename: string, password: string) {
  const client = await connectWallet();
  const wallet = await client.openWallet(filename, password);
  console.log(`✅ Wallet opened: ${filename}`);

  const addressResp = await wallet.getPrimaryAddress();
  const seedResp = await wallet.getSeed();
  const viewKeyResp = await wallet.getPrivateViewKey();

  return {
    address: addressResp,
    seed: seedResp,
    viewKey: viewKeyResp,
  };
}

export async function getXmrBalance(filename: string, password: string): Promise<{ balance: bigint; unlockedBalance: bigint }> {
  const client = await connectWallet();
  const wallet = await client.openWallet(filename, password);
  const balance = await wallet.getBalance();
  const unlockedBalance = await wallet.getUnlockedBalance();
  return {
    balance,
    unlockedBalance,
  };
}

export async function estimateXmrFee(
  walletFilename: string,
  password: string,
  destinationAddress: string,
  amountXMR: bigint
): Promise<{
  estimatedFeeXMR: bigint;
}> {
  try {
    const client = await connectWallet();
    const wallet = await client.openWallet(walletFilename, password);
    const tx = await wallet.createTx({
      accountIndex: 0,
      address: destinationAddress,
      amount: amountXMR,
    });
    const estimatedFee = tx.getFee();
    return { estimatedFeeXMR: estimatedFee };
  } catch (error: any) {
    console.error('Fee estimation failed:', error.message);
    throw error;
  }
}

export async function transferXMR(
  walletFilename: string,
  password: string,
  destinationAddress: string,
  amountXMR: bigint
) {
  try {
    const client = await connectWallet();
    const wallet = await client.openWallet(walletFilename, password);
    const tx = await wallet.createTx({
      accountIndex: 0,
      address: destinationAddress,
      amount: amountXMR,
    });
    const result = await wallet.relayTx(tx);
    return {
      txid: result,
      fee: tx.getFee(),
    };
  } catch (error: any) {
    console.error('Transfer failed:', error.message);
    throw error;
  }
}
