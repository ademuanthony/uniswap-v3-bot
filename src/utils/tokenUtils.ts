import { Contract, Wallet } from 'ethers';
import erc20Abi from '../abis/erc20Abi';
import { GoogleGenerativeAI } from '@google/generative-ai';

import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const CheckResultSchema = z.object({
  mintingEnabled: z.boolean(),
  hiddenMintFunctions: z.boolean(),
  hasBuySellTax: z.boolean(),
  canBlacklist: z.boolean(),
  isSafe: z.boolean(),
  hasHoneypotCode: z.boolean(),
  hasBackdoors: z.boolean(),
  isProxyContract: z.boolean(),
  gasOptimizationIssues: z.boolean(),
  reentrancyVulnerability: z.boolean(),
  buyTaxPercentage: z.number().nullable(),
  sellTaxPercentage: z.number().nullable(),
  comments: z.string(),
})

export async function getTokenDecimals(
  tokenAddress: string,
  wallet: Wallet
): Promise<number> {
  const tokenContract = new Contract(tokenAddress, erc20Abi, wallet);
  return await tokenContract.decimals();
}

export async function approveToken(
  tokenAddress: string,
  spender: string,
  amount: bigint,
  wallet: Wallet
): Promise<void> {
  const tokenContract = new Contract(tokenAddress, erc20Abi, wallet);
  const currentAllowance = await tokenContract.allowance(
    wallet.address,
    spender
  );

  if (currentAllowance < amount) {
    console.log('Insufficient allowance. Approving tokens...');
    const approveTx = await tokenContract.approve(spender, amount);
    console.log(`Approval transaction submitted: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Approval transaction confirmed');
  }
}

export const SUPPORTED_CHAINS = {
  Ethereum: 1,
  BNBChain: 56,
};

export async function getTokenSourceCodea(
  chainId: number,
  tokenAddress: string
): Promise<any> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const url = `https://api.etherscan.io/v2/api?chainId=${chainId}&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;
  console.log(url);
  const response = await fetch(url);
  const data = await response.json();

  if (data.status === '0') {
    return '';
  }

  // remove the trailing { and } from the source code
  return JSON.parse(data.result[0].SourceCode);
}

interface EtherscanSourceCodeResponse {
  status: string;
  message: string;
  result: [{ SourceCode: string }];
}

function parseEtherscanSourceCode(
  response: EtherscanSourceCodeResponse
): string | null {
  if (response.status === '1' && response.result.length > 0) {
    try {
      // Attempt to parse the SourceCode as JSON.  If it's a single contract, it won't be valid JSON.
      const sourceCodeJson = JSON.parse(response.result[0].SourceCode);

      // Check if it's a multi-file contract (JSON format)
      if (
        typeof sourceCodeJson === 'object' &&
        sourceCodeJson !== null &&
        sourceCodeJson.sources
      ) {
        let combinedSource = '';
        for (const file in sourceCodeJson.sources) {
          combinedSource += sourceCodeJson.sources[file].content + '\n'; // Add newline for separation
        }
        return combinedSource;
      } else if (
        typeof sourceCodeJson === 'object' &&
        sourceCodeJson !== null &&
        sourceCodeJson.content
      ) {
        return sourceCodeJson.content;
      } else {
        // If not JSON, assume it's a single contract and return as is.  Clean up escaped characters.
        return response.result[0].SourceCode.replace(/\\r\\n/g, '\n').replace(
          /\\"/g,
          '"'
        );
      }
    } catch (jsonError) {
      // If JSON parsing fails, assume it's a single contract. Clean up escaped characters.
      return response.result[0].SourceCode.replace(/\\r\\n/g, '\n').replace(
        /\\"/g,
        '"'
      );
    }
  }
  return null;
}

// Example of fetching and parsing:
export async function getTokenSourceCode(
  chainId: number,
  tokenAddress: string
): Promise<string | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const url = `https://api.etherscan.io/v2/api?chainId=${chainId}&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data: EtherscanSourceCodeResponse = await response.json();
    let source = parseEtherscanSourceCode(data);
    return source;
  } catch (error) {
    console.error('Error fetching or parsing source code:', error);
    return null;
  }
}

export async function checkTokenSourceCode2(
  chainId: number,
  tokenAddress: string
): Promise<any> {
  const sourceCode = await getTokenSourceCode(chainId, tokenAddress);
  if (sourceCode === null || sourceCode === '') {
    return null;
  }
  const prompt = `Analyze the following Solidity smart contract and answer the following questions:

  1a. Is there a public \`mint\` function? (true/false)
  1b. Is there a \`_mint\` function that can be called externally (even if not directly public)? If so, explain how it could be used. (true/false)
  1c. Is there any function that increases the \`totalSupply\` without a corresponding transfer of tokens to an address? (true/false)
  If any of the above are true, provide the relevant function signatures and explain the potential risks.
  
  2. Hidden mint functions: Sometimes mint functions can be disguised. If true, show how it is called in comments (true/false)
  
  3a. Does the contract have buy/sell tax? (true/false)
  3b. If there is a buy/sell tax, what are the buy and sell tax percentages? Are these taxes fixed or can they be changed by the owner? If so, how?
  
  4a. Can addresses be completely blacklisted (prevented from trading entirely)? (true/false)
  4b. Can addresses be excluded from fees or rewards? If so, how and what are the implications? (true/false)
  
  5. Is the contract safe? (true/false)
  
  6a. Has honeypot code? Code that allows buys but not sells. (true/false)
  6b. Is there any code that would prevent users from selling the token, even if they can buy it? (true/false)
  
  7a. Can the owner rug pull (e.g., drain liquidity, mint and dump)? (true/false)
  7b. Can the owner pause trading? (true/false)
  7c. Can the owner change important contract parameters (e.g., fees, max supply) after deployment? If so, which ones? (true/false)
  
  8. Any other comments about the contract and explanation for your answers?
  
  9. Is the contract a proxy contract? If so, provide the address of the implementation contract. (true/false)
  
  10. Are there any obvious gas optimization issues that could make transactions unnecessarily expensive? (true/false)
  
  11. Is the contract vulnerable to reentrancy attacks? (true/false)
  
  
  Contract Source Code:
  ${sourceCode}
  
  Provide your answers using this JSON schema:
  
  CheckResult = {
  "mintingEnabled": boolean,
  "hiddenMintFunctions": boolean,
  "hasBuySellTax": boolean,
  "canBlacklist": boolean,
  "isSafe": boolean,
  "hasHoneypotCode": boolean,
  "hasBackdoors": boolean,
  "isProxyContract": boolean,
  "gasOptimizationIssues": boolean,
  "reentrancyVulnerability": boolean,
  "buyTaxPercentage": number | null, // Add for tax details
  "sellTaxPercentage": number | null, // Add for tax details
  "comments": string
  }
  
  Return CheckResult`;

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(geminiApiKey as string);

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
  });

  const result = await model.generateContent(prompt);

  let content = result.response.text();
  content = content.replace(/```json\n/, '').replace(/```\n/, '');
  return JSON.parse(content);
}

export async function checkTokenSourceCode(
  chainId: number,
  tokenAddress: string
): Promise<any> {
  const sourceCode = await getTokenSourceCode(chainId, tokenAddress);
  if (sourceCode === null || sourceCode === '') {
    return null;
  }
  const systemPrompt = `Analyze the following Solidity smart contract and answer the following questions:

  1a. Is there a public \`mint\` function? (true/false)
  1b. Is there a \`_mint\` function that can be called externally (even if not directly public)? If so, explain how it could be used. (true/false)
  1c. Is there any function that increases the \`totalSupply\` without a corresponding transfer of tokens to an address? (true/false)
  If any of the above are true, provide the relevant function signatures and explain the potential risks.

  2. Is there any assembly code in the contract? (true/false)
  2. Hidden mint functions: Sometimes mint functions can be disguised. If true, show how it is called in comments (true/false)
  
  3a. Does the contract have buy/sell tax? (true/false)
  3b. If there is a buy/sell tax, what are the buy and sell tax percentages? Are these taxes fixed or can they be changed by the owner? If so, how?
  
  4a. Can addresses be completely blacklisted (prevented from trading entirely)? (true/false)
  4b. Can addresses be excluded from fees or rewards? If so, how and what are the implications? (true/false)
  
  5. Is the contract safe? (true/false)
  
  6a. Has honeypot code? Code that allows buys but not sells. (true/false)
  6b. Is there any code that would prevent users from selling the token, even if they can buy it? (true/false)
  
  7a. Can the owner rug pull (e.g., drain liquidity, mint and dump)? (true/false)
  7b. Can the owner pause trading? (true/false)
  7c. Can the owner change important contract parameters (e.g., fees, max supply) after deployment? If so, which ones? (true/false)
  
  8. Any other comments about the contract and explanation for your answers?
  
  9. Is the contract a proxy contract? If so, provide the address of the implementation contract. (true/false)
  
  10. Are there any obvious gas optimization issues that could make transactions unnecessarily expensive? (true/false)
  
  11. Is the contract vulnerable to reentrancy attacks? (true/false)
  
  Provide your answers using this JSON schema:
  
  CheckResult = {
  "mintingEnabled": boolean,
  "hiddenMintFunctions": boolean,
  "hasBuySellTax": boolean,
  "hasAssemblyCode": boolean,
  "canBlacklist": boolean,
  "isSafe": boolean,
  "hasHoneypotCode": boolean,
  "hasBackdoors": boolean,
  "isProxyContract": boolean,
  "gasOptimizationIssues": boolean,
  "reentrancyVulnerability": boolean,
  "buyTaxPercentage": number | null, // Add for tax details
  "sellTaxPercentage": number | null, // Add for tax details
  "comments": string
  }
  
  Return CheckResult`;

  const client = new OpenAI({
    apiKey: process.env.GROK_API_KEY,
    baseURL: "https://api.x.ai/v1",
  });
  
  const completion = await client.beta.chat.completions.parse({
    model: "grok-2-1212",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sourceCode },
    ],
    response_format: zodResponseFormat(CheckResultSchema, "CheckResult"),
  });
  
  const result = completion.choices[0].message.parsed;
  return result;
}
