import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

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
