import { Contract, Wallet, BigNumber } from 'ethers';
import { Logger } from '../utils/logger';
import {
  encodeRouterPath,
  encodeUniversalRouterInput,
} from '../utils/routerEncoding';
import { UNIVERSAL_ROUTER_ADDRESS } from '../utils/web3';
import poolAbi from '../abis/pool';
import erc20Abi from '../abis/erc20Abi';

export abstract class BaseStrategyExecutor {
  setLogger(logger: { log: (message: string) => void }) {
    Logger.setLogger(logger);
  }

  protected log(message: string) {
    Logger.log(message);
  }

  protected async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: BigNumber,
    wallet: Wallet
  ) {
    const { expectedAmountOut } = await this.getUniversalRouterQuote(
      tokenIn,
      tokenOut,
      amountIn,
      0,
      3000,
      wallet
    );

    return { expectedAmountOut };
  }

  protected async executeSwap(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: BigNumber;
    slippage: number;
    wallet: Wallet;
  }) {
    const network = 'sepolia';
    const UNIVERSAL_ROUTER = UNIVERSAL_ROUTER_ADDRESS[network];

    this.log(
      `Swapping ${params.amountIn.toString()} of token ${params.tokenIn}`
    );
    this.log(`To token ${params.tokenOut} with slippage ${params.slippage}`);
    this.log(`Using Universal Router at ${UNIVERSAL_ROUTER}`);

    const UNIVERSAL_ROUTER_ABI = [
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable returns ()',
    ];

    const router = new Contract(
      UNIVERSAL_ROUTER,
      UNIVERSAL_ROUTER_ABI,
      params.wallet
    );

    // Check token balance and allowance
    const tokenContract = new Contract(
      params.tokenIn,
      erc20Abi,
      params.wallet
    );

    const [balance, allowance] = await Promise.all([
      tokenContract.balanceOf(params.wallet.address),
      tokenContract.allowance(params.wallet.address, router.address),
    ]);

    this.log(`Balance: ${balance.toString()}`);
    this.log(`Allowance: ${allowance.toString()}`);

    if (balance.lt(params.amountIn)) {
      throw new Error(
        `Insufficient balance for swap. Required: ${params.amountIn.toString()}, Available: ${balance.toString()}`
      );
    }

    // Approve only if needed
    if (allowance.lt(params.amountIn)) {
      this.log(
        `Approving Universal Router to spend ${params.amountIn.toString()}`
      );
      const approvalTx = await tokenContract.approve(
        router.address,
        params.amountIn
      );
      await approvalTx.wait();
      this.log('Approval confirmed');
    }

    // Get quote and encode swap data
    const { expectedAmountOut, swapData } = await this.getUniversalRouterQuote(
      params.tokenIn,
      params.tokenOut,
      params.amountIn,
      params.slippage,
      3000,
      params.wallet
    );

    this.log(`Expected amount out: ${expectedAmountOut.toString()} wei`);

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    const tx = await router.execute(
      swapData.commands,
      swapData.inputs,
      deadline,
      { gasLimit: 300000 }
    );

    this.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    this.log(`Transaction confirmed in block ${receipt.blockNumber}`);
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
    const poolContract = new Contract(
      pool,
      poolAbi,
      wallet
    );

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
