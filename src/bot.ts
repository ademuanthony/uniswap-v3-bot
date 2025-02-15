import { readFile } from 'fs/promises';
import path from 'path';
import { Config, Strategy, LPStrategy } from './types/Strategy';
import { DCAStrategy, DCAExecutor } from './strategies/DCAStrategy';
import { GridStrategy, GridExecutor } from './strategies/GridStrategy';
import { CLIManager } from './cli/CLIManager';
import { LPExecutor } from './strategies/LPStrategy';
import dotenv from 'dotenv';
import { Logger } from './utils/logger';
import { BTCBridgeExecutor } from './strategies/BTCBridgeStrategy';
import { BTCBridgeStrategy } from './strategies/BTCBridgeStrategy';
import { Wallet } from 'ethers';

dotenv.config();

async function loadConfig(configPath: string = 'config.json'): Promise<Config> {
  const fullPath = path.resolve(process.cwd(), configPath);
  const data = await readFile(fullPath, 'utf8');
  return JSON.parse(data);
}

function createExecutor(strategy: Strategy) {
  switch (strategy.type) {
    case 'dca': {
      if (
        'amount' in strategy &&
        'slippage' in strategy &&
        'interval' in strategy &&
        'base_token' in strategy &&
        'quote_token' in strategy &&
        'privateKeyEnvKey' in strategy
      ) {
        return new DCAExecutor(strategy as DCAStrategy);
      }
      throw new Error('Invalid DCA strategy configuration');
    }
    case 'grid': {
      if (
        'base_token' in strategy &&
        'quote_token' in strategy &&
        'totalSize' in strategy &&
        'entries' in strategy &&
        'profitTaking' in strategy &&
        'stopLoss' in strategy &&
        'maxPositions' in strategy &&
        'privateKeyEnvKey' in strategy &&
        'key' in strategy &&
        'name' in strategy &&
        'interval' in strategy
      ) {
        return new GridExecutor(strategy as GridStrategy);
      }
      throw new Error('Invalid Grid strategy configuration');
    }
    case 'lp': {
      if (
        'token0' in strategy &&
        'token1' in strategy &&
        'fee' in strategy &&
        'token0Symbol' in strategy &&
        'token1Symbol' in strategy &&
        'token0Name' in strategy &&
        'token1Name' in strategy &&
        'chainId' in strategy &&
        'priceRange' in strategy &&
        'amount0Desired' in strategy &&
        'amount1Desired' in strategy &&
        'autoCompound' in strategy &&
        'rebalance' in strategy
      ) {
        return new LPExecutor(strategy as LPStrategy);
      }
      throw new Error('Invalid LP strategy configuration');
    }
    case 'btc-bridge': {
      if (
        'amount' in strategy &&
        'interval' in strategy &&
        'btcFeeRate' in strategy &&
        'privateKeyEnvKey' in strategy
      ) {
        return new BTCBridgeExecutor(strategy as BTCBridgeStrategy);
      }
      throw new Error('Invalid BTC Bridge strategy configuration');
    }
    default:
      throw new Error(`Unknown strategy type: ${strategy.type}`);
  }
}

async function main() {
  const cli = new CLIManager();
  try {
    // const pk = process.env['PRIVATE_KEY'];
    // const wallet = new Wallet(pk as string);

    // console.log(wallet.address);
    // if (wallet) process.exit(0);

    const config = await loadConfig('config.json');
    Logger.setLogger(cli); // Set global logger

    // Add cleanup handlers
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);

    cli.log('Loading strategies...');

    for (const strategy of config.strategies) {
      try {
        const privateKey = process.env[strategy.privateKeyEnvKey];
        if (!privateKey) {
          cli.log(`No private key found for strategy: ${strategy.name}`);
          continue;
        }

        const executor = createExecutor(strategy);
        executor.setLogger(cli);
        await cli.registerStrategy(executor);
        cli.log(`Registered strategy: ${strategy.name}`);

        // Set up status update interval
        setInterval(async () => {
          const status = await executor.getStatus();
          await cli.updateStrategyState(strategy.name, status);
        }, 5000);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        cli.log(
          `Failed to initialize strategy ${strategy.name}: ${errorMessage}`
        );
      }
    }

    cli.log('Bot initialization complete. Use commands to control strategies.');
    cli.log(
      'Available commands: start <strategy>, stop <strategy>, status <strategy>'
    );
  } catch (error: unknown) {
    cleanup();
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    cli.log(`Fatal error in bot execution: ${errorMessage}`);
    process.exit(1);
  }
}

function cleanup() {
  Logger.restoreConsole();
}

main();
