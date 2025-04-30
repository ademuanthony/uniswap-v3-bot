// src/utils/moneroRpc.ts

import DigestClient from 'http-digest-client';
import dotenv from 'dotenv';

dotenv.config();

const client = new DigestClient(
  process.env.MONERO_RPC_USERNAME!,
  process.env.MONERO_RPC_PASSWORD!
);

const RPC_HOST = '127.0.0.1';
const RPC_PORT = 18083;
const RPC_PATH = '/json_rpc';

/**
 * Makes a Monero RPC call over digest-auth.
 * @param method RPC method name
 * @param params RPC method params (default: {})
 * @returns RPC result
 */
export function moneroRpcCall<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  const payload = {
    jsonrpc: '2.0',
    id: '0',
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    client.request({
      host: RPC_HOST,
      port: RPC_PORT,
      path: RPC_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, JSON.stringify(payload), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.result);
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
  });
}
