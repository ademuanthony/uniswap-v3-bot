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
    case 'dca':
      return new DCAExecutor(strategy as DCAStrategy);
    case 'grid':
      return new GridExecutor(strategy as GridStrategy);
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

  config.strategies.forEach((strategy) => {
    console.log(
      `Scheduling strategy "${strategy.name}" every ${strategy.interval} seconds.`
    );

    const executor = createExecutor(strategy);

    setInterval(async () => {
      try {
        const privateKey = process.env[strategy.privateKeyEnvKey];
        if (!privateKey) {
          throw new Error(`No private key found for strategy: ${strategy.name}`);
        }

        const wallet = new Wallet(privateKey, provider);
        const router = new Contract(
          uniswapV3RouterAddress,
          uniswapV3RouterAbi,
          wallet
        );

        await executor.execute(router, wallet);
      } catch (error) {
        console.error(`Error executing strategy ${strategy.name}:`, error);
      }
    }, strategy.interval * 1000);
  });

  console.log('Uniswap v3 Bot is running. Press Ctrl+C to exit.');
}

main().catch((error) => {
  console.error('Fatal error in bot execution:', error);
  process.exit(1);
}); 