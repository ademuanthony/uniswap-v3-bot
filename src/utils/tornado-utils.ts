import { randomBytes } from 'crypto';
import BN from 'bn.js';
import { buffPedersenHash } from './pedersen';
import { ethers } from 'ethers';
import { buildGroth16 } from 'snarkjs';
import { MerkleTree } from './merkleTree';
import { config } from './tornado.config';

// Contract ABIs
const TornadoProxyABI = [
  'function withdraw(address _tornado, bytes memory _proof, bytes32 _root, bytes32 _nullifierHash, address payable _recipient, address payable _relayer, uint256 _fee, uint256 _refund) external',
  'function isSpent(bytes32 _nullifierHash) public view returns (bool)',
];

const InstanceABI = [
  'function getLastRoot() public view returns (bytes32)',
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
];

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

const CUT_LENGTH = 31;

export interface ParsedNote {
  secret: bigint;
  nullifier: bigint;
  commitment: Buffer;
  nullifierBuff: Buffer;
  nullifierHash: bigint;
  commitmentHex: string;
  nullifierHex: string;
  netId?: string;
  amount?: string;
  currency?: string;
}

export interface WithdrawNote {
  currency: string;
  amount: string;
  netId: string;
  nullifier: ethers.BigNumber;
  secret: ethers.BigNumber;
  nullifierHash: string;
  commitment: string;
}

export function parseNote(note: string): ParsedNote {
  const [, currency, amount, netId, hexNote] = note.split('-');

  return {
    ...parseHexNote(hexNote),
    netId,
    amount,
    currency,
  };
}

export function parseHexNote(hexNote: string): ParsedNote {
  const buffNote = Buffer.from(hexNote.slice(2), 'hex');
  const commitment = buffPedersenHash(buffNote);

  const nullifierBuff = buffNote.slice(0, CUT_LENGTH);
  const nullifierHash = BigInt(buffPedersenHash(nullifierBuff).toString('hex'));
  const nullifier = BigInt(
    leInt2Buff(buffNote.slice(0, CUT_LENGTH)).toString()
  );

  const secret = BigInt(
    leInt2Buff(buffNote.slice(CUT_LENGTH, CUT_LENGTH * 2)).toString()
  );

  return {
    secret,
    nullifier,
    commitment,
    nullifierBuff,
    nullifierHash,
    commitmentHex: toFixedHex(commitment),
    nullifierHex: toFixedHex(nullifierHash),
  };
}

export function parseWithdrawNote(noteString: string): WithdrawNote {
  try {
    const [prefix, currency, amount, netId, noteHex] = noteString.split('-');

    if (prefix !== 'tornado') {
      throw new Error('Invalid note prefix');
    }

    const buf = Buffer.from(noteHex, 'hex');
    const nullifier = ethers.BigNumber.from(
      '0x' + buf.slice(0, 31).toString('hex')
    );
    const secret = ethers.BigNumber.from(
      '0x' + buf.slice(31, 62).toString('hex')
    );

    // Generate nullifier hash using pedersen
    const nullifierBuf = Buffer.from(
      nullifier.toHexString().slice(2).padStart(62, '0'),
      'hex'
    );
    const nullifierHash = buffPedersenHash(nullifierBuf);

    // Generate commitment
    const commitmentBuf = Buffer.concat([
      Buffer.from(nullifier.toHexString().slice(2).padStart(62, '0'), 'hex'),
      Buffer.from(secret.toHexString().slice(2).padStart(62, '0'), 'hex'),
    ]);
    const commitment = buffPedersenHash(commitmentBuf);

    return {
      currency,
      amount,
      netId,
      nullifier,
      secret,
      nullifierHash: toFixedHex(nullifierHash),
      commitment: toFixedHex(commitment),
    };
  } catch (err) {
    const error = err as Error;
    throw new Error(`Invalid note format: ${error.message}`);
  }
}

export function leInt2Buff(value: Buffer): BN {
  return new BN(value, 16, 'le');
}

export function randomBN(nbytes: number = 31): BN {
  return leInt2Buff(randomBytes(nbytes));
}

export function toFixedHex(
  value: Buffer | bigint | string | number,
  length: number = 32
): string {
  if (value instanceof Buffer) {
    return '0x' + value.toString('hex').padStart(length * 2, '0');
  }
  if (typeof value === 'number') {
    return '0x' + value.toString(16).padStart(length * 2, '0');
  }
  const bigIntValue = typeof value === 'string' ? BigInt(value) : value;
  return (
    '0x' +
    (typeof bigIntValue === 'bigint'
      ? bigIntValue.toString(16)
      : bigIntValue.toString()
    ).padStart(length * 2, '0')
  );
}

export interface EncryptedMessage {
  version?: string;
  nonce: string;
  ephemPublicKey: string;
  ciphertext: string;
}

export function packEncryptedMessage(
  encryptedMessage: EncryptedMessage
): string {
  const nonceBuf = Buffer.from(encryptedMessage.nonce, 'base64');
  const ephemPublicKeyBuf = Buffer.from(
    encryptedMessage.ephemPublicKey,
    'base64'
  );
  const ciphertextBuf = Buffer.from(encryptedMessage.ciphertext, 'base64');

  const messageBuff = Buffer.concat([
    Buffer.alloc(24 - nonceBuf.length),
    nonceBuf,
    Buffer.alloc(32 - ephemPublicKeyBuf.length),
    ephemPublicKeyBuf,
    ciphertextBuf,
  ]);

  return '0x' + messageBuff.toString('hex');
}

export function unpackEncryptedMessage(
  encryptedMessage: string
): EncryptedMessage {
  const hexMessage = encryptedMessage.startsWith('0x')
    ? encryptedMessage.slice(2)
    : encryptedMessage;
  const messageBuff = Buffer.from(hexMessage, 'hex');

  const nonceBuf = messageBuff.slice(0, 24);
  const ephemPublicKeyBuf = messageBuff.slice(24, 56);
  const ciphertextBuf = messageBuff.slice(56);

  return {
    version: 'x25519-xsalsa20-poly1305',
    nonce: nonceBuf.toString('base64'),
    ephemPublicKey: ephemPublicKeyBuf.toString('base64'),
    ciphertext: ciphertextBuf.toString('base64'),
  };
}

export interface DepositEvent {
  leafIndex: number;
}

export function checkCommitments(events: DepositEvent[] = []): void {
  events.forEach(({ leafIndex }, i) => {
    if (leafIndex !== i) {
      console.error(`Missing deposit event for deposit #${i}`);
      throw new Error('Failed to fetch all deposit events');
    }
  });
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
      config.TOKEN_ADDRESSES[parsedNote.currency].pools[parsedNote.amount];

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
