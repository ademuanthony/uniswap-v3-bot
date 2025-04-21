import { Connection } from '@solana/web3.js';
import { Contract, Wallet, ethers } from 'ethers';

const ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

export class Web3Helper {
  static getProvider(): ethers.providers.JsonRpcProvider {
    if (!process.env.ETH_RPC) {
      throw new Error('ETH_RPC environment variable not set');
    }
    return new ethers.providers.JsonRpcProvider(process.env.ETH_RPC);
  }

  static getSolanaConnection(): Connection {
    if (!process.env.SOLANA_RPC) {
      throw new Error('SOLANA_RPC environment variable not set');
    }
    return new Connection(process.env.SOLANA_RPC);
  }

  static getWallet(privateKey: string): Wallet {
    return new Wallet(privateKey, this.getProvider());
  }

  static getRouter(wallet: Wallet): Contract {
    return new Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  }
} 