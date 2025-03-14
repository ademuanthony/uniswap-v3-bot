import { BigNumber, ethers } from 'ethers';
import { randomBytes } from 'crypto';
import { buildGroth16 } from 'snarkjs';
import { MerkleTree } from './merkleTree';
import { toFixedHex, parseWithdrawNote } from './tornado-utils';
import { buffPedersenHash } from './pedersen';
import { config } from './tornado.config';

// Contract ABIs
const TornadoProxyABI = [
  'function deposit(address _tornado, bytes32 _commitment) payable',
  'function deposit(address _tornado, bytes32 _commitment, address _token, uint256 _amount)',
  'function withdraw(address _tornado, bytes memory _proof, bytes32 _root, bytes32 _nullifierHash, address payable _recipient, address payable _relayer, uint256 _fee, uint256 _refund) external',
  'function isSpent(bytes32 _nullifierHash) public view returns (bool)',
];

const ERC20ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const InstanceABI = [
  'function getLastRoot() public view returns (bytes32)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
];

interface DepositParams {
  amount: string | number;
  currency: string; // 'eth' or token symbol
  nullifier?: string;
  secret?: string;
  provider: ethers.providers.Provider;
  signer: ethers.Signer;
}

interface DepositResult {
  txHash: string;
  note: string;
  commitment: string;
}

interface WithdrawParams {
  note: string;
  recipient: string;
  provider: ethers.providers.Provider;
  signer: ethers.Signer;
  relayer?: string;
  fee?: string;
}

interface WithdrawResult {
  txHash: string;
  recipient: string;
  amount: string;
  currency: string;
}

export async function deposit({
  amount,
  currency,
  nullifier,
  secret,
  provider,
  signer,
}: DepositParams): Promise<DepositResult> {
  try {
    // 1. Generate or use provided nullifier and secret
    const _nullifier = nullifier || '0x' + randomBytes(31).toString('hex');
    const _secret = secret || '0x' + randomBytes(31).toString('hex');

    // 2. Create commitment using Pedersen hash
    const preimage = Buffer.concat([
      Buffer.from(_nullifier.slice(2), 'hex'),
      Buffer.from(_secret.slice(2), 'hex'),
    ]);
    const commitment = buffPedersenHash(preimage);
    const commitmentHex = '0x' + commitment.toString('hex');

    // 3. Create note
    const note = `tornado-${currency.toLowerCase()}-${amount}-${1}-${_nullifier}${_secret}`;

    // 4. Get contract instances
    const tornadoProxy = new ethers.Contract(
      config.TORNADO_PROXY,
      TornadoProxyABI,
      signer
    );

    // 5. Get pool address for the amount
    const poolAddress =
      config.TOKEN_ADDRESSES[currency.toLowerCase()].pools[amount.toString()];
    if (!poolAddress) {
      throw new Error(`No pool found for ${currency} with amount ${amount}`);
    }

    // 6. Prepare deposit parameters
    const params = [poolAddress, commitmentHex, []]; // Empty array for optional encrypted note

    // 7. Handle token approval if not ETH
    if (currency.toLowerCase() !== 'eth') {
      const tokenAddress =
        config.TOKEN_ADDRESSES[currency.toLowerCase()].address;
      const token = new ethers.Contract(tokenAddress, ERC20ABI, signer);
      const decimals = await token.decimals();
      const amountBN = ethers.utils.parseUnits(amount.toString(), decimals);

      // Check and handle approval
      const allowance = await token.allowance(
        await signer.getAddress(),
        config.TORNADO_PROXY
      );
      if (allowance.lt(amountBN)) {
        const approveTx = await token.approve(config.TORNADO_PROXY, amountBN);
        await approveTx.wait();
      }
    }

    // 8. Estimate gas and prepare transaction
    const value =
      currency.toLowerCase() === 'eth'
        ? ethers.utils.parseEther(amount.toString())
        : BigNumber.from(0);

    const gasLimit = await tornadoProxy.estimateGas.deposit(...params, {
      value,
    });
    const gasPrice = await provider.getGasPrice();

    // 9. Send deposit transaction
    const tx = await tornadoProxy.deposit(...params, {
      value,
      gasLimit: gasLimit.mul(12).div(10), // Add 20% buffer
      gasPrice,
    });

    // 10. Wait for transaction confirmation
    const receipt = await tx.wait();

    return {
      txHash: receipt.transactionHash,
      note,
      commitment: commitmentHex,
    };
  } catch (error) {
    console.error('Deposit failed:', error);
    throw error;
  }
}

export async function withdraw({
  note,
  recipient,
  provider,
  signer,
  relayer,
  fee = '0',
}: WithdrawParams): Promise<WithdrawResult> {
  try {
    // 1. Parse the note
    const parsedNote = parseWithdrawNote(note);

    // 2. Build merkle tree and get root
    const { tree, root } = await buildMerkleTree({
      currency: parsedNote.currency,
      amount: parsedNote.amount,
      provider,
    });

    // 3. Check if note has been spent
    const isSpent = await checkNullifierSpent(
      parsedNote.nullifierHash,
      provider
    );
    if (isSpent) {
      throw new Error('Note has already been spent');
    }

    // 4. Generate SNARK proof
    const { proof, args } = await generateProof({
      root,
      nullifierHash: parsedNote.nullifierHash,
      recipient,
      relayer: relayer || ethers.constants.AddressZero,
      fee,
      nullifier: parsedNote.nullifier,
      secret: parsedNote.secret,
      tree,
      pathElements: tree.path(tree.indexOf(parsedNote.commitment)).pathElements,
      pathIndices: tree.path(tree.indexOf(parsedNote.commitment)).pathIndices,
    });

    // 5. Get contract instance
    const tornadoProxy = new ethers.Contract(
      config.TORNADO_PROXY,
      TornadoProxyABI,
      signer
    );

    // 6. Get pool address
    const poolAddress =
      config.TOKEN_ADDRESSES[parsedNote.currency]?.pools[parsedNote.amount];
    if (!poolAddress) {
      throw new Error(
        `No pool found for ${parsedNote.currency} with amount ${parsedNote.amount}`
      );
    }

    // 7. Prepare withdraw parameters
    const withdrawParams = [
      poolAddress,
      proof,
      ...args, // root, nullifierHash, recipient, relayer, fee, refund
    ];

    // 8. Estimate gas and prepare transaction
    const gasLimit = await tornadoProxy.estimateGas.withdraw(...withdrawParams);
    const gasPrice = await provider.getGasPrice();
  
    // 9. Send withdrawal transaction
    const tx = await tornadoProxy.withdraw(...withdrawParams, {
      gasLimit: gasLimit.mul(12).div(10), // Add 20% buffer
      gasPrice,
    });

    // 10. Wait for confirmation
    const receipt = await tx.wait();

    return {
      txHash: receipt.transactionHash,
      recipient,
      amount: parsedNote.amount,
      currency: parsedNote.currency,
    };
  } catch (error) {
    console.error('Withdrawal failed:', error);
    throw error;
  }
}

async function buildMerkleTree({
  currency,
  amount,
  provider,
}: {
  currency: string;
  amount: string;
  provider: ethers.providers.Provider;
}): Promise<{ tree: MerkleTree; root: string }> {
  // Get pool address
  const poolAddress = config.TOKEN_ADDRESSES[currency]?.pools[amount];
  if (!poolAddress) {
    throw new Error(`No pool found for ${currency} with amount ${amount}`);
  }

  const pool = new ethers.Contract(poolAddress, InstanceABI, provider);

  // Get deposit events
  const filter = pool.filters.Deposit();
  const events = await pool.queryFilter(filter);

  // Build merkle tree from commitments
  const leaves = events.map((e) => {
    if (!e.args) throw new Error('Invalid event format');
    return e.args.commitment;
  });

  const tree = new MerkleTree(20, leaves); // Depth 20 for Tornado Cash

  // Get current root from contract
  const root = await pool.getLastRoot();

  // Verify root matches
  if (root !== tree.root()) {
    throw new Error('Generated tree root does not match contract root');
  }

  return { tree, root };
}

async function checkNullifierSpent(
  nullifierHash: string,
  provider: ethers.providers.Provider
): Promise<boolean> {
  const tornadoProxy = new ethers.Contract(
    config.TORNADO_PROXY,
    TornadoProxyABI,
    provider
  );
  return await tornadoProxy.isSpent(nullifierHash);
}

async function generateProof({
  root,
  nullifierHash,
  recipient,
  relayer,
  fee,
  nullifier,
  secret,
  tree,
  pathElements,
  pathIndices,
}: {
  root: string;
  nullifierHash: string;
  recipient: string;
  relayer: string;
  fee: string;
  nullifier: ethers.BigNumber;
  secret: ethers.BigNumber;
  tree: MerkleTree;
  pathElements: string[];
  pathIndices: number[];
}): Promise<{ proof: any; args: string[] }> {
  // Prepare circuit inputs
  const input = {
    root: ethers.BigNumber.from(root),
    nullifierHash: ethers.BigNumber.from(nullifierHash),
    recipient: ethers.BigNumber.from(recipient),
    relayer: ethers.BigNumber.from(relayer),
    fee: ethers.BigNumber.from(fee),
    nullifier,
    secret,
    pathElements,
    pathIndices,
  };

  // Generate SNARK proof
  const { proof } = await buildGroth16().prove(input);

  // Prepare arguments for contract
  const args = [
    toFixedHex(root),
    toFixedHex(nullifierHash),
    toFixedHex(recipient, 20),
    toFixedHex(relayer, 20),
    toFixedHex(fee),
    toFixedHex(0), // refund amount, usually 0
  ];

  return { proof, args };
}
