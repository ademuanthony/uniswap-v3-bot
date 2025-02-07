import { Contract, Wallet } from 'ethers';

export interface BaseStrategy {
  name: string;
  privateKeyEnvKey: string;
  base_token: string;
  quote_token: string;
  interval: number; // Interval in seconds
}

export interface Config {
  strategies: Strategy[];
}

export interface StrategyExecutor {
  execute(router: Contract, wallet: Wallet): Promise<void>;
}

export type Strategy = {
  type: string;
} & BaseStrategy;