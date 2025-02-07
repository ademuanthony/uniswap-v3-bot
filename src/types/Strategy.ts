import { Contract, Wallet } from 'ethers';

export interface BaseStrategy {
  name: string;
  type: string;
  privateKeyEnvKey: string;
  base_token: string;
  quote_token: string;
  interval: number; // Interval in seconds
  slippage?: number; // Optional slippage setting
}

// Default slippage values
export const DEFAULT_SLIPPAGE = {
  DCA: 0.5, // 0.5% default for DCA
  GRID_ENTRY: 0.1, // 0.1% for grid entry
  GRID_PROFIT: 0.1, // 0.1% for taking profit
  GRID_LOSS: 0.5, // 0.5% for stop loss
};

export interface Config {
  strategies: Strategy[];
}

export interface StrategyExecutor {
  execute(router: Contract, wallet: Wallet): Promise<void>;
  start(router: Contract, wallet: Wallet): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

export type Strategy = BaseStrategy & {
  execute(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
};
