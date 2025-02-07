import { Contract, ethers, JsonRpcProvider, parseUnits } from 'ethers';
import { readFile } from 'fs/promises';
import path from 'path';

// --- Types and Interfaces ---

interface Strategy {
  name: string;
  privateKeyEnvKey: string;
  base_token: string;
  quote_token: string;
  action: 'buy' | 'sell';
  amount: string; // Trade amount as a string (in human-readable form)
  interval: number; // Interval in seconds
  slippage: number; // Maximum acceptable slippage as a percentage (e.g., 0.5 for 0.5%)
}

interface Config {
  strategies: Strategy[];
}

// --- Utility: Load Config File ---

async function loadConfig(configPath: string = 'config.json'): Promise<Config> {
  const fullPath = path.resolve(process.cwd(), configPath);
  const data = await readFile(fullPath, 'utf8');
  return JSON.parse(data);
}

// --- Execute a Single Strategy ---

/**
 * Executes a Uniswap v3 token swap using exactInputSingle.
 *
 * For a "buy" action, we swap the quote token (e.g. USDC) for the base token (e.g. WBTC).
 * For a "sell" action, the swap is reversed.
 *
 * **Note:** Make sure the input token has been approved for spending by the router.
 *
 * @param strategy The DCA strategy configuration.
 * @param router The Uniswap v3 SwapRouter contract instance.
 * @param wallet The ethers.js Wallet instance.
 */
async function executeStrategy(
  strategy: Strategy,
  router: ethers.Contract,
  wallet: ethers.Wallet
) {
  console.log(
    `\n[${new Date().toISOString()}] Executing strategy: ${strategy.name}! Swapping ${strategy.amount} ${strategy.quote_token} for ${strategy.base_token}`
  );

  // --- Map Token Symbols to Contract Addresses ---
  const tokenAddresses: { [symbol: string]: string } = {
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC mainnet
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC mainnet
    // Add other tokens as needed.
  };

  // --- Determine Swap Direction Based on Action ---
  let tokenInSymbol: string;
  let tokenOutSymbol: string;
  if (strategy.action === 'buy') {
    // To buy the base token, spend the quote token.
    tokenInSymbol = strategy.quote_token.toUpperCase();
    tokenOutSymbol = strategy.base_token.toUpperCase();
  } else if (strategy.action === 'sell') {
    // To sell the base token, spend the base token to get the quote token.
    tokenInSymbol = strategy.base_token.toUpperCase();
    tokenOutSymbol = strategy.quote_token.toUpperCase();
  } else {
    console.error('Invalid action in strategy:', strategy.action);
    return;
  }

  const tokenIn = tokenAddresses[tokenInSymbol];
  const tokenOut = tokenAddresses[tokenOutSymbol];

  if (!tokenIn || !tokenOut) {
    console.error(
      'Token address not found for:',
      tokenInSymbol,
      tokenOutSymbol
    );
    return;
  }

  // --- Get Token Decimals ---
  const erc20Abi = ['function decimals() view returns (uint8)'];
  const tokenInContract = new Contract(
    tokenIn,
    erc20Abi,
    wallet
  );
  const tokenOutContract = new Contract(
    tokenOut,
    erc20Abi,
    wallet
  );

  let tokenInDecimals: number;
  let tokenOutDecimals: number;

  try {
    [tokenInDecimals, tokenOutDecimals] = await Promise.all([
      tokenInContract.decimals(),
      tokenOutContract.decimals(),
    ]);
  } catch (error) {
    console.error('Error fetching token decimals:', error);
    return;
  }

  // --- Parse the Trade Amount ---
  const amountIn = parseUnits(strategy.amount, tokenInDecimals);

  // --- Get Quote from Uniswap ---
  // Add quoter contract interface
  const quoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';
  const quoterAbi = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
  ];

  const quoter = new ethers.Contract(quoterAddress, quoterAbi, wallet);

  let expectedAmountOut;
  try {
    expectedAmountOut = await quoter.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      3000,
      amountIn,
      0
    );

    console.log(`Expected output amount: ${expectedAmountOut.toString()}`);
  } catch (error) {
    console.error('Error getting quote:', error);
    return;
  }

  // Calculate minimum output amount based on slippage
  const slippageFactor = 1 - strategy.slippage / 100;
  const amountOutMinimum = expectedAmountOut
    .mul(Math.floor(slippageFactor * 10000))
    .div(10000);

  console.log(
    `Minimum output amount (${
      strategy.slippage
    }% slippage): ${amountOutMinimum.toString()}`
  );

  // --- Set Deadline ---
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  // --- Uniswap v3 Fee Tier ---
  // For example, using the 0.3% fee tier (3000).
  const fee = 3000;

  // sqrtPriceLimitX96 set to 0 means no price limit.
  const sqrtPriceLimitX96 = 0;

  console.log(
    `Preparing to ${strategy.action} ${
      strategy.amount
    } (parsed as ${amountIn.toString()} in wei) of ${tokenInSymbol} for ${tokenOutSymbol} using fee tier ${fee}. Minimum output: ${amountOutMinimum.toString()}`
  );

  // --- Check and Set Token Approval ---
  const erc20ApprovalAbi = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];

  const tokenInWithApproval = new ethers.Contract(
    tokenIn,
    erc20ApprovalAbi,
    wallet
  );

  // Check current allowance
  const currentAllowance = await tokenInWithApproval.allowance(
    wallet.address,
    router.target
  );

  // If allowance is less than amountIn, approve more tokens
  if (currentAllowance < amountIn) {
    console.log('Insufficient allowance. Approving tokens...');
    try {
      const approveTx = await tokenInWithApproval.approve(
        router.target,
        ethers.MaxUint256 // Infinite approval - can be changed to amountIn for limited approval
      );
      console.log(`Approval transaction submitted: ${approveTx.hash}`);
      await approveTx.wait();
      console.log('Approval transaction confirmed');
    } catch (error) {
      console.error('Error approving tokens:', error);
      return;
    }
  } else {
    console.log('Sufficient allowance exists');
  }

  // --- Prepare Parameters for exactInputSingle ---
  const params = {
    tokenIn,
    tokenOut,
    fee,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96,
  };

  try {
    // Execute the swap via Uniswap v3 SwapRouter's exactInputSingle.
    const tx = await router.exactInputSingle(params, { gasLimit: 300000 });
    console.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
  } catch (error) {
    console.error('Error executing swap:', error);
  }
}

// --- Main Bot Function ---

async function main() {
  // Load the configuration file.
  const config = await loadConfig('config.json');
  const strategies = config.strategies;

  // --- Setup Ethers.js Provider and Wallet ---
  // Supply your provider URL and private key via environment variables or replace the placeholders.
  const providerUrl = process.env.PROVIDER_URL;
  const provider = new JsonRpcProvider(providerUrl);

  // --- Connect to the Uniswap v3 SwapRouter ---
  // Uniswap v3 SwapRouter address on mainnet.
  const uniswapV3RouterAddress = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
  // Minimal ABI including only the exactInputSingle function.
  const uniswapV3RouterAbi = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  ];

  // --- Schedule Each Strategy ---
  strategies.forEach((strategy) => {
    console.log(
      `Scheduling strategy "${strategy.name}" every ${strategy.interval} seconds.`
    );
    setInterval(async () => {
      const privateKey = process.env[strategy.privateKeyEnvKey];
      if (!privateKey) {
        console.error(
          `No private key found in environment variables for strategy: ${strategy.name}`
        );
        return;
      }

      const wallet = new ethers.Wallet(privateKey, provider);
      const router = new ethers.Contract(
        uniswapV3RouterAddress,
        uniswapV3RouterAbi,
        wallet
      );
      await executeStrategy(strategy, router, wallet);
    }, strategy.interval * 1000);
  });

  console.log('Uniswap v3 DCA Bot is running. Press Ctrl+C to exit.');
}

main().catch((error) => {
  console.error('Fatal error in bot execution:', error);
  process.exit(1);
});
