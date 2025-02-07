import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { readFile } from 'fs/promises';
import path from 'path';
import { Config, Strategy } from './types/Strategy';
import { DCAStrategy, DCAExecutor } from './strategies/DCAStrategy';
import { GridStrategy, GridExecutor } from './strategies/GridStrategy';

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
        'gridSize' in strategy &&
        'profitTarget' in strategy &&
        'stopLoss' in strategy &&
        'maxGrids' in strategy &&
        'retracementWait' in strategy
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
  const config = await loadConfig('config.json');
  const providerUrl = process.env.PROVIDER_URL;
  const provider = new JsonRpcProvider(providerUrl);

  const uniswapV3RouterAddress = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
  const uniswapV3RouterAbi = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  ];

  for (const strategy of config.strategies) {
    try {
      const privateKey = process.env[strategy.privateKeyEnvKey];
      if (!privateKey) {
        console.error(`No private key found for strategy: ${strategy.name}`);
        continue;
      }

      const wallet = new Wallet(privateKey, provider);
      const router = new Contract(
        uniswapV3RouterAddress,
        uniswapV3RouterAbi,
        wallet
      );

      const executor = createExecutor(strategy);
      await executor.start(router, wallet);
      console.log(`Started strategy: ${strategy.name}`);
    } catch (error) {
      console.error(`Failed to start strategy ${strategy.name}:`, error);
    }
  }

  console.log('Uniswap v3 Bot is running. Press Ctrl+C to exit.');
}

main().catch((error) => {
  console.error('Fatal error in bot execution:', error);
  process.exit(1);
});
