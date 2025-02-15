import { Contract, Wallet, ethers } from 'ethers';

const ROUTER_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

export const UNIVERSAL_ROUTER_ADDRESS = {
  sepolia: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
  mainnet: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B'
};

export const QUOTER_V2_ADDRESS = {
  sepolia: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
};

export class Web3Helper {
  static getProvider(): ethers.providers.JsonRpcProvider {
    if (!process.env.ETH_RPC) {
      throw new Error('ETH_RPC environment variable not set');
    }
    return new ethers.providers.JsonRpcProvider(process.env.ETH_RPC);
  }

  static getWallet(privateKey: string): Wallet {
    return new Wallet(privateKey, this.getProvider());
  }

  static getRouter(wallet: Wallet): Contract {
    return new Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  }
} 