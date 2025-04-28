import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

const fs = require('fs');

import bs58 from 'bs58';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export const getTokenBalance = async (
  connection: Connection,
  tokenMint: PublicKey,
  walletAddress: PublicKey
): Promise<number> => {
  try {
    const ata = await getAssociatedTokenAddress(tokenMint, walletAddress);
    const info = await getAccount(connection, ata);
    return Number(info.amount);
  } catch (err) {
    // console.log(err)
  }

  return 0;
};

export const getSolBalance = async (
  connection: Connection,
  walletAddress: PublicKey
): Promise<number> => {
  const balance = await connection.getBalance(walletAddress);
  return balance;
};


export function getSolanaWallet(walletPrivateKey: string): Keypair {
  // most likely someone pasted the private key in binary format
  if (walletPrivateKey.startsWith('[')) {
    return Keypair.fromSecretKey(JSON.parse(walletPrivateKey));
  }

  // most likely someone pasted mnemonic
  if (walletPrivateKey.split(' ').length > 1) {
    const seed = mnemonicToSeedSync(walletPrivateKey, '');
    const path = `m/44'/501'/0'/0'`; // we assume it's first path
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
  }

  // most likely someone pasted base58 encoded private key
  return Keypair.fromSecretKey(bs58.decode(walletPrivateKey));
}

export const getSimulatedUnits = async (connection: Connection, tx: VersionedTransaction) => {
  const simulation = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  if (simulation.value.err) {
    console.log('getSimulatedUnits', simulation.value.err)
    return undefined
  }
  return simulation.value.unitsConsumed
}

export const importWallet = (filePath: string) => {
  const walletString = fs.readFileSync(filePath, 'utf-8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(walletString)));
};

