// createXmrWallet.ts
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.MONERO_RPC_URL!;
const RPC_AUTH = {
  username: process.env.MONERO_RPC_USERNAME!,
  password: process.env.MONERO_RPC_PASSWORD!,
};

interface CreateWalletParams {
  filename: string;
  language: string; // mnemonic seed language (e.g., "English")
  password: string;
}

export async function createMoneroWallet(params: CreateWalletParams) {
  try {
    const { filename, language, password } = params;

    const response = await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'create_wallet',
        params: {
          filename,
          language,
          password,
        },
      },
      { auth: RPC_AUTH }
    );

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    console.log('Wallet created successfully!');
    console.log('Wallet filename:', filename);

    // Now open the newly created wallet to get its details
    const walletInfo = await openWallet(filename, password);
    console.log('Address:', walletInfo.address);
    console.log('Seed (mnemonic):', walletInfo.seed);
    console.log('View key:', walletInfo.viewKey);
  } catch (err: any) {
    console.error('Wallet creation error:', err.message);
  }
}

export async function openWallet(filename: string, password: string) {
  // Open wallet
  await axios.post(
    RPC_URL,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'open_wallet',
      params: { filename, password },
    },
    { auth: RPC_AUTH }
  );

  // Get address
  const addressResp = await axios.post(
    RPC_URL,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_address',
    },
    { auth: RPC_AUTH }
  );

  // Get mnemonic seed
  const seedResp = await axios.post(
    RPC_URL,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'query_key',
      params: { key_type: 'mnemonic' },
    },
    { auth: RPC_AUTH }
  );

  // Get view key
  const viewKeyResp = await axios.post(
    RPC_URL,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'query_key',
      params: { key_type: 'view_key' },
    },
    { auth: RPC_AUTH }
  );

  return {
    address: addressResp.data.result.address,
    seed: seedResp.data.result.key,
    viewKey: viewKeyResp.data.result.key,
  };
}

export async function estimateXmrFee(
  walletFilename: string,
  password: string,
  destinationAddress: string,
  amountXMR: number
): Promise<{
  estimatedFeeXMR: number;
}> {
  try {
    // First open the wallet
    await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'open_wallet',
        params: { filename: walletFilename, password },
      },
      { auth: RPC_AUTH }
    );

    // Then prepare a transfer with `do_not_relay: true`
    const response = await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'transfer',
        params: {
          destinations: [
            {
              amount: Math.floor(amountXMR * 1e12), // Convert XMR to atomic units (piconero)
              address: destinationAddress,
            },
          ],
          priority: 2, // Normal priority (default is 2)
          ring_size: 16,
          do_not_relay: true, // <--- KEY to only estimate, not send
        },
      },
      { auth: RPC_AUTH }
    );

    const result = response.data.result;
    const estimatedFee = result.fee / 1e12; // Fee is returned in atomic units

    console.log(`Estimated Fee: ${estimatedFee} XMR`);

    return {
      estimatedFeeXMR: estimatedFee,
    };
  } catch (error: any) {
    console.error('Fee estimation failed:', error.response?.data || error.message);
    throw error;
  }
}

export async function transferXMR(
  walletFilename: string,
  password: string,
  destinationAddress: string,
  amountXMR: number
) {
  try {
    // First open the wallet
    await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'open_wallet',
        params: { filename: walletFilename, password },
      },
      { auth: RPC_AUTH }
    );

    // Then perform the transfer
    const response = await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'transfer',
        params: {
          destinations: [
            {
              amount: Math.floor(amountXMR * 1e12), // Convert XMR to atomic units (piconero)
              address: destinationAddress,
            },
          ],
          priority: 2, // Normal priority
          ring_size: 16,
        },
      },
      { auth: RPC_AUTH }
    );

    const result = response.data.result;
    console.log('Transfer successful!');
    console.log('Transaction ID (txid):', result.tx_hash);
    console.log('Fee (XMR):', result.fee / 1e12);

    return {
      txid: result.tx_hash,
      fee: result.fee / 1e12,
    };
  } catch (error: any) {
    console.error('Transfer failed:', error.response?.data || error.message);
    throw error;
  }
}

export async function getXmrBalance(address: string): Promise<{
  balance: number;
  unlockedBalance: number;
}> {
  try {
    const response = await axios.post(
      RPC_URL,
      {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_balance',
        params: { address },
      },
      { auth: RPC_AUTH }
    );

    const result = response.data.result;

    const balance = result.balance / 1e12;       // Available balance
    const unlockedBalance = result.unlocked_balance / 1e12; // Spendable balance (unlocked)
    
    return {
      balance,
      unlockedBalance,
    };
  } catch (error: any) {
    console.error('Error fetching balance:', error.response?.data || error.message);
    throw error;
  }
}
