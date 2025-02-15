import { BigNumber } from 'ethers';
import { defaultAbiCoder, solidityPack } from 'ethers/lib/utils';

export function encodeRouterPath(
  tokens: string[],
  fees: number[]
): string {
  if (tokens.length <= 1 || tokens.length !== fees.length + 1) {
    throw new Error('Invalid tokens or fees length');
  }

  let path = '';
  for (let i = 0; i < tokens.length - 1; i++) {
    path += tokens[i].slice(2); // Remove '0x'
    path += solidityPack(['uint24'], [fees[i]]).slice(2);
  }
  path += tokens[tokens.length - 1].slice(2);

  return '0x' + path;
}

export function encodeUniversalRouterInput(params: {
  path: string;
  recipient: string;
  amountIn: BigNumber;
  minAmountOut: BigNumber;
}): string {
  // V3_SWAP_EXACT_IN command parameters
  return defaultAbiCoder.encode(
    ['bytes', 'address', 'uint256', 'uint256'],
    [
      params.path,
      params.recipient,
      params.amountIn,
      params.minAmountOut
    ]
  );
} 