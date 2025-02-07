import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { readFile } from 'fs/promises';
import path from 'path';
import { Config, Strategy } from './types/Strategy';
import { DCAStrategy, DCAExecutor } from './strategies/DCAStrategy';
import { GridStrategy, GridExecutor } from './strategies/GridStrategy';
import { CLIManager } from './cli/CLIManager';

const routerAddress = process.env.UNISWAP_V3_ROUTER_ADDRESS;
const routerAbi = process.env.UNISWAP_V3_ROUTER_ABI;

async function loadConfig(configPath: string = 'config.json'): Promise<Config> {
  const fullPath = path.resolve(process.cwd(), configPath);
  const data = await readFile(fullPath, 'utf8');
  return JSON.parse(data);
}

function createExecutor(strategy: Strategy) {
  switch (strategy.type) {
    case 'dca': {
      if (
        'action' in strategy &&
        'amount' in strategy &&
        'slippage' in strategy
      ) {
        return new DCAExecutor(strategy as DCAStrategy);
      }
      throw new Error('Invalid DCA strategy configuration');
    }
    case 'grid': {
      if (
        'totalSize' in strategy &&
        'entries' in strategy &&
        'profitTaking' in strategy &&
        'stopLoss' in strategy &&
        'maxPositions' in strategy
      ) {
        return new GridExecutor(strategy as GridStrategy);
      }
      throw new Error('Invalid Grid strategy configuration');
    }
    default:
      throw new Error(`Unknown strategy type: ${strategy.type}`);
  }
}

async function main() {
  const cli = new CLIManager();
  try {
    const config = await loadConfig('config.json');
    const providerUrl = process.env.PROVIDER_URL;
    const provider = new JsonRpcProvider(providerUrl);

    cli.log('Loading strategies...');

    for (const strategy of config.strategies) {
      try {
        const privateKey = process.env[strategy.privateKeyEnvKey];
        if (!privateKey) {
          cli.log(`No private key found for strategy: ${strategy.name}`);
          continue;
        }

        const wallet = new Wallet(privateKey, provider);
        const executor = createExecutor(strategy);

        // Register strategy with CLI
        cli.registerStrategy(executor);
        cli.log(`Registered strategy: ${strategy.name}`);

        // Set up status update interval
        setInterval(async () => {
          const status = await executor.getStatus();
          cli.updateStrategyState(strategy.name, status);
        }, 5000);
      } catch (error: unknown) {
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
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    cli.log(`Fatal error in bot execution: ${errorMessage}`);
    process.exit(1);
  }
}

main();
