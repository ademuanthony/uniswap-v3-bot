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

async function rpcCall(method: string, params: object = {}) {
  console.log(`RPC call: ${method} ${JSON.stringify({ RPC_AUTH, RPC_URL })}`);
  const DigestFetch = (await import('digest-fetch')).default;
  const client = new DigestFetch(RPC_AUTH.username, RPC_AUTH.password);
  const response = await client.fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '0',
      method,
      params,
    }),
  });

  const json = await response.json();

  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function createMoneroWallet(params: CreateWalletParams) {
  try {
    const { filename, language, password } = params;

    await rpcCall('create_wallet', { filename, language, password });
    console.log('Wallet created successfully!');
    console.log('Wallet filename:', filename);

    const walletInfo = await openWallet(filename, password);
    console.log('Address:', walletInfo.address);
    console.log('Seed (mnemonic):', walletInfo.seed);
    console.log('View key:', walletInfo.viewKey);
  } catch (err: any) {
    console.error('Wallet creation error:', err.message);
  }
}

export async function openWallet(filename: string, password: string) {
  await rpcCall('open_wallet', { filename, password });

  const addressResp = await rpcCall('get_address');
  const seedResp = await rpcCall('query_key', { key_type: 'mnemonic' });
  const viewKeyResp = await rpcCall('query_key', { key_type: 'view_key' });

  return {
    address: addressResp.address,
    seed: seedResp.key,
    viewKey: viewKeyResp.key,
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
    await rpcCall('open_wallet', { filename: walletFilename, password });

    const result = await rpcCall('transfer', {
      destinations: [
        {
          amount: Math.floor(amountXMR * 1e12),
          address: destinationAddress,
        },
      ],
      priority: 2,
      ring_size: 16,
      do_not_relay: true,
    });

    const estimatedFee = result.fee / 1e12;
    console.log(`Estimated Fee: ${estimatedFee} XMR`);
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
  amountXMR: number
) {
  try {
    await rpcCall('open_wallet', { filename: walletFilename, password });

    const result = await rpcCall('transfer', {
      destinations: [
        {
          amount: Math.floor(amountXMR * 1e12),
          address: destinationAddress,
        },
      ],
      priority: 2,
      ring_size: 16,
    });

    console.log('Transfer successful!');
    console.log('Transaction ID (txid):', result.tx_hash);
    console.log('Fee (XMR):', result.fee / 1e12);

    return {
      txid: result.tx_hash,
      fee: result.fee / 1e12,
    };
  } catch (error: any) {
    console.error('Transfer failed:', error.message);
    throw error;
  }
}

export async function getXmrBalance(address: string): Promise<{
  balance: number;
  unlockedBalance: number;
}> {
  try {
    const result = await rpcCall('get_balance', { address });
    return {
      balance: result.balance / 1e12,
      unlockedBalance: result.unlocked_balance / 1e12,
    };
  } catch (error: any) {
    console.error('Error fetching balance:', error.message);
    throw error;
  }
}
