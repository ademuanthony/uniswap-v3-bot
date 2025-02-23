import { Contract, Wallet, BigNumber } from 'ethers';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import {
  NewTokenStrategy,
  StrategyExecutor,
  NewTokenPosition,
} from '../types/Strategy';
import { checkTokenSourceCode } from '../utils/tokenUtils';
import { SUPPORTED_CHAINS } from '../utils/tokenUtils';
import { Web3Helper } from '../utils/web3';
import { parseUnits } from 'ethers/lib/utils';
import { DataSource, PoolInfo, PriceInfo } from '../utils/datasource/types';
import { Web3DataSource } from '../utils/datasource/web3DataSource';

interface TokenSafetyCheck {
  mintingEnabled: boolean;
  hiddenMintFunctions: boolean;
  hasBuySellTax: boolean;
  canBlacklist: boolean;
  isSafe: boolean;
  hasHoneypotCode: boolean;
  hasBackdoors: boolean;
  buyTaxPercentage: number;
  sellTaxPercentage: number;
}

export class NewTokenExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: NewTokenStrategy;
  private _isRunning: boolean = false;
  private interval?: NodeJS.Timeout;
  private positions: Map<string, NewTokenPosition> = new Map();
  private lastCheckTimestamp: number;
  private dataSource: DataSource;

  constructor(strategy: NewTokenStrategy) {
    super();
    this.strategy = strategy;
    this.lastCheckTimestamp = Date.now();
    this.dataSource = new Web3DataSource(
      Web3Helper.getProvider(),
      this.strategy.base_token
    );
    this.dataSource.setListener({
      onNewPool: this.handleNewPool.bind(this),
      onPriceUpdate: this.handlePriceUpdate.bind(this),
    });
  }

  protected override log(message: string) {
    super.log(`[${this.strategy.key}] ${message}`);
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;

    // Subscribe to new pools
    this.dataSource.subscribeToNewPools();

    // Start monitoring existing positions
    for (const [tokenAddress] of this.positions) {
      this.dataSource.subscribeToPriceUpdates(tokenAddress);
    }
  }

  private async handlePriceUpdate(priceInfo: PriceInfo): Promise<void> {
    console.log(
      'Price update received for',
      priceInfo.tokenAddress,
      priceInfo.price
    );
    const position = this.positions.get(priceInfo.tokenAddress);
    if (!position) return;

    const entryPrice = BigNumber.from(position.entryPrice);
    const priceIncrease = BigNumber.from(Math.floor(priceInfo.price * 1e6))
      .mul(100)
      .div(entryPrice);

    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());

    if (!position.firstTargetHit && priceIncrease.gte(250)) {
      await this.takePartialProfit(
        priceInfo.tokenAddress,
        position,
        75,
        wallet
      );
      position.firstTargetHit = true;
      position.remainingAmount = BigNumber.from(position.amount)
        .mul(25)
        .div(100)
        .toString();
      this.positions.set(priceInfo.tokenAddress, position);
    } else if (position.firstTargetHit && priceIncrease.gte(1000)) {
      await this.takeFullProfit(priceInfo.tokenAddress, position, wallet);
      this.positions.delete(priceInfo.tokenAddress);
      this.dataSource.unsubscribeFromPriceUpdates(priceInfo.tokenAddress);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  private async isTokenSafe(
    tokenAddress: string
  ): Promise<TokenSafetyCheck | null> {
    try {
      const safetyCheck = await checkTokenSourceCode(
        SUPPORTED_CHAINS.BNBChain,
        tokenAddress
      );

      if (!safetyCheck) return null;

      // Check if token passes our safety criteria
      if (
        safetyCheck.mintingEnabled ||
        safetyCheck.hiddenMintFunctions ||
        safetyCheck.canBlacklist ||
        !safetyCheck.isSafe ||
        safetyCheck.hasHoneypotCode ||
        safetyCheck.hasBackdoors ||
        safetyCheck.buyTaxPercentage > this.strategy.safetyChecks.maxBuyTax ||
        safetyCheck.sellTaxPercentage > this.strategy.safetyChecks.maxSellTax
      ) {
        return null;
      }

      return safetyCheck;
    } catch (error) {
      this.log(`Error checking token safety: ${error}`);
      return null;
    }
  }

  private async checkAndEnterPosition(
    tokenAddress: string,
    wallet: Wallet
  ): Promise<void> {
    // Check if we already have a position in this token
    if (this.positions.has(tokenAddress)) {
      return;
    }

    // Check token safety
    const safetyCheck = await this.isTokenSafe(tokenAddress);
    if (!safetyCheck) {
      this.log(`Token ${tokenAddress} failed safety checks`);
      return;
    }

    // Check liquidity
    const liquidityCheck = await this.checkLiquidity(tokenAddress);
    if (!liquidityCheck) {
      this.log(`Token ${tokenAddress} has insufficient liquidity`);
      return;
    }

    // Enter position
    await this.enterPosition(tokenAddress, wallet);
  }

  private async checkLiquidity(
    tokenAddress: string,
  ): Promise<boolean> {
    const liquidity = await this.dataSource.getTokenLiquidity(
      tokenAddress,
      this.strategy.base_token
    );

    if (!liquidity) return false;
    this.log(`Liquidity: ${liquidity}`);

    const minLiquidity = parseFloat(this.strategy.safetyChecks.minLiquidity);
    return liquidity >= minLiquidity;
  }

  private async enterPosition(
    tokenAddress: string,
    wallet: Wallet
  ): Promise<void> {
    try {
      const amount = parseUnits(this.strategy.initialBuyAmount, 18); // Assuming BNB/BUSD decimals

      // Execute buy
      await this.executeSwap({
        tokenIn: this.strategy.base_token,
        tokenOut: tokenAddress,
        amountIn: amount,
        slippage: this.strategy.maxSlippage,
        wallet,
      });

      // Get entry price
      const { expectedAmountOut: entryPrice } = await this.getQuote(
        this.strategy.base_token,
        tokenAddress,
        parseUnits('1', 18),
        wallet
      );

      // Record position
      this.positions.set(tokenAddress, {
        tokenAddress,
        entryPrice: entryPrice.toString(),
        amount: amount.toString(),
        timestamp: Date.now(),
        firstTargetHit: false,
        remainingAmount: null,
      });

      this.log(`Entered position in ${tokenAddress} at price ${entryPrice}`);
    } catch (error) {
      this.log(`Error entering position: ${error}`);
    }
  }

  private async checkAndManagePositions(wallet: Wallet): Promise<void> {
    for (const [tokenAddress, position] of this.positions.entries()) {
      try {
        // Get current price from Bitquery
        const currentPrice = await this.dataSource.getTokenPrice(
          tokenAddress,
          this.strategy.base_token
        );

        if (!currentPrice) {
          this.log(`Could not get price for token ${tokenAddress}`);
          continue;
        }

        const entryPrice = BigNumber.from(position.entryPrice);
        const priceIncrease = BigNumber.from(Math.floor(currentPrice * 1e6))
          .mul(100)
          .div(entryPrice);

        // Check first target (2.5x)
        if (!position.firstTargetHit && priceIncrease.gte(250)) {
          await this.takePartialProfit(tokenAddress, position, 75, wallet);
          position.firstTargetHit = true;
          position.remainingAmount = BigNumber.from(position.amount)
            .mul(25)
            .div(100)
            .toString();
          this.positions.set(tokenAddress, position);
        }
        // Check final target (10x)
        else if (position.firstTargetHit && priceIncrease.gte(1000)) {
          await this.takeFullProfit(tokenAddress, position, wallet);
          this.positions.delete(tokenAddress);
        }
      } catch (error) {
        this.log(`Error managing position ${tokenAddress}: ${error}`);
      }
    }
  }

  private async takePartialProfit(
    tokenAddress: string,
    position: NewTokenPosition,
    percentageToSell: number,
    wallet: Wallet
  ): Promise<void> {
    try {
      const amount = BigNumber.from(position.amount)
        .mul(percentageToSell)
        .div(100);

      await this.executeSwap({
        tokenIn: tokenAddress,
        tokenOut: this.strategy.base_token,
        amountIn: amount,
        slippage: this.strategy.maxSlippage,
        wallet,
      });

      this.log(`Took ${percentageToSell}% profit on ${tokenAddress}`);
    } catch (error) {
      this.log(`Error taking partial profit: ${error}`);
    }
  }

  private async takeFullProfit(
    tokenAddress: string,
    position: NewTokenPosition,
    wallet: Wallet
  ): Promise<void> {
    try {
      const amount = BigNumber.from(position.remainingAmount);

      await this.executeSwap({
        tokenIn: tokenAddress,
        tokenOut: this.strategy.base_token,
        amountIn: amount,
        slippage: this.strategy.maxSlippage,
        wallet,
      });

      this.log(`Took full profit on ${tokenAddress}`);
    } catch (error) {
      this.log(`Error taking full profit: ${error}`);
    }
  }

  private async checkNewPools(): Promise<void> {
    try {
      const newPools = await this.dataSource.getNewPools(
        this.lastCheckTimestamp
      );
      this.lastCheckTimestamp = Date.now();

      for (const pool of newPools) {
        // Only consider pools with our base token
        if (
          pool.token0.address.toLowerCase() ===
            this.strategy.base_token.toLowerCase() ||
          pool.token1.address.toLowerCase() ===
            this.strategy.base_token.toLowerCase()
        ) {
          const tokenAddress =
            pool.token0.address.toLowerCase() ===
            this.strategy.base_token.toLowerCase()
              ? pool.token1.address
              : pool.token0.address;

          this.log(`New pool detected for token: ${tokenAddress}`);
          await this.checkAndEnterPosition(
            tokenAddress,
            Web3Helper.getWallet(this.getWalletPrivateKey())
          );
        }
      }
    } catch (error) {
      this.log(`Error checking new pools: ${error}`);
    }
  }

  async execute(): Promise<void> {
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());

    // Check for new pools
    await this.checkNewPools();

    // Manage existing positions
    await this.checkAndManagePositions(wallet);
  }

  public getName(): string {
    return this.strategy.name;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.strategy.privateKeyEnvKey] as string;
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public async getStatus(): Promise<any> {
    const positions = Array.from(this.positions.values()).map((pos) => ({
      tokenAddress: pos.tokenAddress,
      entryPrice: pos.entryPrice,
      amount: pos.amount,
      firstTargetHit: pos.firstTargetHit,
      remainingAmount: pos.remainingAmount,
      timestamp: new Date(pos.timestamp).toISOString(),
    }));

    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      positions,
      lastUpdate: new Date().toISOString(),
    };
  }

  public async getDisplayInfo(): Promise<string[]> {
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    const activePositions = this.positions.size;

    return [
      `Type: New Token Trading`,
      `Initial Buy Amount: ${this.strategy.initialBuyAmount} ${this.strategy.base_token}`,
      `Active Positions: ${activePositions}`,
      `First Target: 2.5x (Sell 75%)`,
      `Final Target: 10x (Sell Remaining)`,
      `Wallet: ${wallet.address}`,
      `Max Slippage: ${this.strategy.maxSlippage}%`,
      `Max Buy Tax: ${this.strategy.safetyChecks.maxBuyTax}%`,
      `Max Sell Tax: ${this.strategy.safetyChecks.maxSellTax}%`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    switch (action.toLowerCase()) {
      case 'positions':
        return JSON.stringify(Array.from(this.positions.values()), null, 2);
      case 'enter':
        if (args.length !== 1) return 'Usage: enter <tokenAddress>';
        await this.checkAndEnterPosition(
          args[0],
          Web3Helper.getWallet(this.getWalletPrivateKey())
        );
        return `Attempted to enter position for token ${args[0]}`;
      default:
        return `Unknown command: ${action}. Available commands: positions, enter <tokenAddress>`;
    }
  }

  private async handleNewPool(pool: PoolInfo): Promise<void> {
    // Only consider pools with our base token
    if (
      pool.token0.address.toLowerCase() ===
        this.strategy.base_token.toLowerCase() ||
      pool.token1.address.toLowerCase() ===
        this.strategy.base_token.toLowerCase()
    ) {
      const tokenAddress =
        pool.token0.address.toLowerCase() ===
        this.strategy.base_token.toLowerCase()
          ? pool.token1.address
          : pool.token0.address;

      this.log(`New pool detected for token: ${tokenAddress}`);
      await this.checkAndEnterPosition(
        tokenAddress,
        Web3Helper.getWallet(this.getWalletPrivateKey())
      );
    }
  }
}
