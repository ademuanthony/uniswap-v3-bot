import { Contract, Wallet } from 'ethers';

export interface BaseStrategy {
  name: string;
  key: string; // Add this - unique identifier for commands
  type: string;
  privateKeyEnvKey: string;
  base_token: string;
  quote_token: string;
  interval: number; // Interval in seconds
  slippage?:
    | number
    | {
        swap: number;
        position: number;
      };
}

// Default slippage values
export const DEFAULT_SLIPPAGE = {
  DCA: 0.5, // 0.5% default for DCA
  GRID_ENTRY: 0.1, // 0.1% for grid entry
  GRID_PROFIT: 0.1, // 0.1% for taking profit
  GRID_LOSS: 0.5, // 0.5% for stop loss
  LP_SWAP: 0.05, // 0.05% for swap
  LP_POSITION: 0.05, // 0.05% for position
};

export interface Config {
  strategies: Strategy[];
}

export interface StrategyExecutor {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  getName(): string;
  getWalletPrivateKey(): string;
  getKey(): string;
  getStatus(): Promise<any>;
  getDisplayInfo(): string[];
  handleCommand(action: string, args: string[]): Promise<string>;
  setLogger(logger: { log: (message: string) => void }): void;
}

export type Strategy = BaseStrategy & {
  execute(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
};

export interface LPStrategy extends BaseStrategy {
  type: 'lp';
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Name: string;
  token1Name: string;
  chainId: number;
  fee: number;
  priceRange: {
    lowerBoundPercent: number; // e.g., -10 means 10% below current price
    upperBoundPercent: number; // e.g., 15 means 15% above current price
  };
  amount0Desired: string;
  amount1Desired: string;
  initialTickLower?: number;
  initialTickUpper?: number;
  slippage?: {
    swap: number;
    position: number;
  };
  autoCompound: {
    enabled: boolean;
    threshold: number;
    maxGasFee: string;
    interval: number;
    minFeesForCompound: string;
  };
  rebalance: {
    enabled: boolean;
    threshold: number;
  };
}

export interface LPPosition {
  tokenId: number;
  liquidity: bigint;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  inRange: boolean;
  lastCompounded: number;
  timestamp: number;
  entryPrice: bigint;
}
