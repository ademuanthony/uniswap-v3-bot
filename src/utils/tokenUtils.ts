import { Contract, Wallet } from 'ethers';
import erc20Abi from '../abis/erc20Abi';


export async function getTokenDecimals(tokenAddress: string, wallet: Wallet): Promise<number> {
  const tokenContract = new Contract(tokenAddress, erc20Abi, wallet);
  return await tokenContract.decimals();
}

export async function getTokenBalance(tokenAddress: string, wallet: Wallet): Promise<bigint> {
  const tokenContract = new Contract(tokenAddress, erc20Abi, wallet);
  return await tokenContract.balanceOf(wallet.address);
}

export async function approveToken(
  tokenAddress: string,
  spender: string,
  amount: bigint,
  wallet: Wallet
): Promise<void> {
  const tokenContract = new Contract(tokenAddress, erc20Abi, wallet);
  const currentAllowance = await tokenContract.allowance(wallet.address, spender);

  if (currentAllowance < amount) {
    console.log('Insufficient allowance. Approving tokens...');
    const approveTx = await tokenContract.approve(spender, amount);
    console.log(`Approval transaction submitted: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Approval transaction confirmed');
  }
} 