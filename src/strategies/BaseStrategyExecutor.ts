import { Contract, Wallet, BigNumber } from 'ethers';
import { Logger } from '../utils/logger';
import {
  encodeRouterPath,
  encodeUniversalRouterInput,
} from '../utils/routerEncoding';
import { Web3Helper } from '../utils/web3';
import poolAbi from '../abis/pool';
import erc20Abi from '../abis/erc20Abi';
import quoterAbi from '../abis/quoter';
import { getTokenDecimals } from '../utils/tokenUtils';
import { formatUnits } from 'ethers/lib/utils';
import { tokenAddresses } from '../tokens';
import UNI_TRADER_ABI from '../abis/uniTrader';
import { ethers } from 'ethers';

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

export abstract class BaseStrategyExecutor {
  setLogger(logger: { log: (message: string) => void }) {
    Logger.setLogger(logger);
  }

  protected log(message: string) {
    Logger.log(message);
  }

  protected async getBalance(
    tokenAddress: string,
    walletAddress: string
  ): Promise<BigNumber> {
    const tokenContract = new Contract(
      tokenAddress,
      erc20Abi,
      Web3Helper.getProvider()
    );
    const balance = await tokenContract.balanceOf(walletAddress);
    if (tokenAddress === tokenAddresses['WETH']) {
      const nativeBalance = await Web3Helper.getProvider().getBalance(
        walletAddress
      );
      return nativeBalance.add(balance);
    }
    return balance;
  }

  protected async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    wallet: Wallet
  ) {
    const quoterAddress = process.env.QUOTER_ADDRESS as string;
    const quoter = new Contract(quoterAddress, quoterAbi, wallet);

    const quote = await quoter.callStatic.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      3000,
      amountIn,
      0
    );

    return { expectedAmountOut: quote };
  }

  protected async getPoolAddress(
    token0Address: string,
    token1Address: string,
    fee: number,
    wallet: Wallet
  ): Promise<string> {
    const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS as string;
    const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, wallet);
    if (token0Address.toLowerCase() > token1Address.toLowerCase()) {
      [token0Address, token1Address] = [token1Address, token0Address];
    }
    const poolAddress = await factory.getPool(
      token0Address,
      token1Address,
      fee
    );
    return poolAddress;
  }

  protected async executeSwap(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: BigNumber;
    slippage: number;
    wallet: Wallet;
  }) {
    const trader = new Contract(
      process.env.UNI_TRADER as string,
      UNI_TRADER_ABI,
      params.wallet
    );

    const poolAddress = await this.getPoolAddress(
      params.tokenIn,
      params.tokenOut,
      3000,
      params.wallet
    );
    const poolContract = new Contract(poolAddress, poolAbi, params.wallet);

    const token0 = await poolContract.token0();
    const zeroToOne = params.tokenIn === token0;

    const { expectedAmountOut } = await this.getQuote(
      params.tokenIn,
      params.tokenOut,
      params.amountIn,
      params.wallet
    );

    const slippageBps = params.slippage * 100;
    const amountOutMinimum = expectedAmountOut
      .mul(BigNumber.from(10000 - slippageBps))
      .div(10000);

    // Check and approve token if needed
    const tokenContract = new Contract(params.tokenIn, erc20Abi, params.wallet);
    const allowance = await tokenContract.allowance(
      params.wallet.address,
      trader.address
    );
    if (allowance.lt(params.amountIn)) {
      const approvalTx = await tokenContract.approve(
        trader.address,
        params.amountIn
      );
      await approvalTx.wait();
    }

    const swapData = this.encodeSwapData({
      amountIn: params.amountIn,
      amountOutMin: amountOutMinimum,
      poolAddress,
      zeroToOne,
      poolVersion: 0x03
    });

    let value;
    if (params.tokenIn === tokenAddresses['WETH']) {
      value = params.amountIn;
    }

    // Execute the swap
    const tx = await trader.swapExactInput(swapData, { value });
    this.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    this.log(`Transaction confirmed in block ${receipt.blockNumber}`);

    return receipt;
  }

  protected encodeSwapData(params: {
    amountIn: BigNumber;
    amountOutMin: BigNumber;
    poolAddress: string;
    zeroToOne: boolean;
    poolVersion: number;
  }): string {
    // Encode amounts to 32 bytes each
    const amountInBytes = ethers.utils.zeroPad(
      ethers.utils.arrayify(params.amountIn),
      32
    );

    const amountOutMinBytes = ethers.utils.zeroPad(
      ethers.utils.arrayify(params.amountOutMin),
      32
    );

    // Get pool address bytes (20 bytes)
    const poolAddressBytes = ethers.utils.arrayify(params.poolAddress);

    // Create a single byte for the direction
    const directionByte = new Uint8Array(1);
    directionByte[0] = params.zeroToOne ? 0x01 : 0x00;
    let a = 0x01;

    const poolVersionByte = new Uint8Array(1);
    poolVersionByte[0] = params.poolVersion;

    // Concatenate everything: amountIn (32) + amountOutMin (32) + poolAddress (20) + direction (1) + poolVersion (1)
    return ethers.utils.hexlify(
      ethers.utils.concat([
        amountInBytes,
        amountOutMinBytes,
        poolAddressBytes,
        directionByte,
        poolVersionByte
      ])
    );
  }

  protected async executeSwap2(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: BigNumber;
    slippage: number;
    wallet: Wallet;
  }) {
    const WETH_ADDRESS = process.env.WETH_ADDRESS as string;
    const token0Decimals = await getTokenDecimals(
      params.tokenIn,
      params.wallet
    );

    this.log(
      `Swapping ${formatUnits(params.amountIn, token0Decimals)} of token ${
        params.tokenIn
      }`
    );
    this.log(`To token ${params.tokenOut} with slippage ${params.slippage}`);

    const router = Web3Helper.getRouter(params.wallet);
    let needsWrap = false;
    let needsUnwrap = false;

    // Check if we're dealing with ETH/WETH
    if (params.tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      needsWrap = true;
    } else if (params.tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      needsUnwrap = true;
    }

    const tokenContract = new Contract(params.tokenIn, erc20Abi, params.wallet);

    // Check token balance and allowance
    const [balance, allowance] = await Promise.all([
      needsWrap
        ? params.wallet.getBalance()
        : tokenContract.balanceOf(params.wallet.address),
      tokenContract.allowance(params.wallet.address, router.address),
    ]);

    if (balance.lt(params.amountIn)) {
      throw new Error(
        `Insufficient balance for swap. Required: ${params.amountIn.toString()}, Available: ${balance.toString()}`
      );
    }

    // Approve only if needed
    if (allowance.lt(params.amountIn)) {
      const approvalTx = await tokenContract.approve(
        router.address,
        params.amountIn
      );
      await approvalTx.wait();
    }

    // Get quote and encode swap data
    const { expectedAmountOut } = await this.getQuote(
      params.tokenIn,
      params.tokenOut,
      params.amountIn,
      params.wallet
    );

    const slippageBps = params.slippage * 100;
    const amountOutMinimum = expectedAmountOut
      .mul(BigNumber.from(10000 - slippageBps))
      .div(10000);

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    // Execute swap
    const swapParams = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: 3000,
      recipient: needsUnwrap ? router.address : params.wallet.address,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0,
    };

    const value = needsWrap ? params.amountIn : 0;
    const tx = await router.exactInputSingle(swapParams, { value });

    this.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    this.log(`Transaction confirmed in block ${receipt.blockNumber}`);

    // Handle unwrapping WETH if needed
    if (needsUnwrap) {
      const weth = new Contract(
        WETH_ADDRESS,
        ['function withdraw(uint256 amount)'],
        params.wallet
      );
      const unwrapTx = await weth.withdraw(amountOutMinimum);
      await unwrapTx.wait();
    }

    return receipt;
  }

  private async getQuoteFromPool(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    fee: number,
    wallet: Wallet
  ): Promise<BigNumber> {
    const poolFactory = new Contract(
      process.env.FACTORY_ADDRESS as string,
      [
        'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
      ],
      wallet
    );

    const pool = await poolFactory.getPool(tokenIn, tokenOut, fee);
    const poolContract = new Contract(pool, poolAbi, wallet);

    // Get current price from slot0
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    // Calculate price from sqrtPriceX96
    const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;

    // Calculate expected output
    // For token0 -> token1: amountOut = amountIn * price
    // Calculate expected output
    // For token0 -> token1: amountOut = amountIn * price
    // For token1 -> token0: amountOut = amountIn / price
    const isToken0ToToken1 = tokenIn.toLowerCase() < tokenOut.toLowerCase();

    let expectedAmountOut: BigNumber;
    if (isToken0ToToken1) {
      expectedAmountOut = amountIn
        .mul(BigNumber.from(Math.floor(price * 1e6)))
        .div(1e6);
    } else {
      expectedAmountOut = amountIn
        .mul(1e6)
        .div(BigNumber.from(Math.floor(price * 1e6)));
    }

    this.log(`Expected amount out from pool: ${expectedAmountOut.toString()}`);

    return expectedAmountOut;
  }

  private async getUniversalRouterQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    slippage: number,
    fee: number,
    wallet: Wallet
  ) {
    // Get quote first
    const expectedAmountOut = await this.getQuoteFromPool(
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      wallet
    );

    const minAmountOut = expectedAmountOut
      .mul(BigNumber.from(Math.floor((1 - slippage) * 10000)))
      .div(10000);

    // Encode path and inputs
    const path = encodeRouterPath([tokenIn, tokenOut], [3000]);

    const inputs = encodeUniversalRouterInput({
      path,
      recipient: wallet.address,
      amountIn,
      minAmountOut,
    });

    return {
      expectedAmountOut,
      swapData: {
        commands: '0x01', // V3_SWAP_EXACT_IN command
        inputs: [inputs],
      },
    };
  }
}
