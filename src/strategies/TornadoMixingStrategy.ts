import { BaseStrategy, StrategyExecutor } from '../types/Strategy';
import { BaseStrategyExecutor } from './BaseStrategyExecutor';
import { Web3Helper } from '../utils/web3';
import { ethers } from 'ethers';
import { deposit, withdraw } from '../utils/tornado';
import fs from 'fs';
import path from 'path';

export interface TornadoMixingStrategy extends BaseStrategy {
  type: 'tornado-mixer';
  amount: string;
  currency: string;
  interval: number; // Base interval in seconds
  privateKeyEnvKey: string;
  relayerUrls: string[]; // List of relayer URLs to choose from
}

interface Note {
  noteString: string;
  timestamp: number;
  scheduledWithdrawalTime: number;
  amount: string;
  currency: string;
  txHash: string;
  processed?: boolean;
}

export class TornadoMixingExecutor
  extends BaseStrategyExecutor
  implements StrategyExecutor
{
  private strategy: TornadoMixingStrategy;
  private _isRunning: boolean = false;
  private depositInterval?: NodeJS.Timeout;
  private withdrawalProcessor?: NodeJS.Timeout;
  private notesDir = './.data/tornado_notes';
  private processedDir = './.data/tornado_notes/processed';
  private totalMixed: number = 0;

  constructor(strategy: TornadoMixingStrategy) {
    super();
    this.strategy = strategy;
    this.initStorage();
  }

  private initStorage() {
    if (!fs.existsSync(this.notesDir)) {
      fs.mkdirSync(this.notesDir, { recursive: true });
    }
    if (!fs.existsSync(this.processedDir)) {
      fs.mkdirSync(this.processedDir, { recursive: true });
    }
  }

  protected override log(message: string) {
    super.log(`[${this.strategy.key}] ${message}`);
  }

  private getRandomInterval(
    baseInterval: number,
    variationPercent: number
  ): number {
    const variation = baseInterval * (variationPercent / 100);
    const min = baseInterval - variation;
    const max = baseInterval + variation;
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  private getRandomWithdrawalTime(): number {
    const baseInterval = this.strategy.interval * 2; // Double the deposit interval
    const variation = baseInterval * 0.63; // 63% variation
    const min = baseInterval - variation;
    const max = baseInterval + variation;
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    return Date.now() + delay * 1000; // Convert to timestamp
  }

  private async executeDeposit(): Promise<void> {
    try {
      const provider = new ethers.providers.JsonRpcProvider(
        process.env.ETH_RPC
      );
      const signer = new ethers.Wallet(this.getWalletPrivateKey(), provider);

      const result = await deposit({
        amount: this.strategy.amount,
        currency: this.strategy.currency,
        provider,
        signer,
      });

      const note: Note = {
        noteString: result.note,
        timestamp: Date.now(),
        scheduledWithdrawalTime: this.getRandomWithdrawalTime(),
        amount: this.strategy.amount,
        currency: this.strategy.currency,
        txHash: result.txHash,
        processed: false,
      };

      // Save note to file
      const fileName = `note-${Date.now()}.json`;
      fs.writeFileSync(
        path.join(this.notesDir, fileName),
        JSON.stringify(note, null, 2)
      );

      this.log(
        `Deposit successful. Note saved to ${fileName}. Scheduled withdrawal at ${new Date(
          note.scheduledWithdrawalTime
        ).toISOString()}`
      );
      this.scheduleNextDeposit();
    } catch (error) {
      this.log(
        `Deposit failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.scheduleNextDeposit();
    }
  }

  private async processScheduledWithdrawals(): Promise<void> {
    try {
      const now = Date.now();
      const notes = fs
        .readdirSync(this.notesDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({
          fileName: file,
          note: JSON.parse(
            fs.readFileSync(path.join(this.notesDir, file), 'utf8')
          ) as Note,
        }))
        .filter(
          ({ note }) => !note.processed && note.scheduledWithdrawalTime <= now
        );

      for (const { fileName, note } of notes) {
        await this.processWithdrawal(note, fileName);
      }
    } catch (error) {
      this.log(
        `Error in withdrawal processor: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async processWithdrawal(note: Note, fileName: string) {
    try {
      // Generate a random recipient wallet
      const recipientWallet = ethers.Wallet.createRandom();

      // Select a random relayer
      const relayer =
        this.strategy.relayerUrls[
          Math.floor(Math.random() * this.strategy.relayerUrls.length)
        ];

      const provider = new ethers.providers.JsonRpcProvider(
        process.env.ETH_RPC
      );
      const signer = new ethers.Wallet(
        this.getWalletPrivateKey(),
        provider
      );

      const result = await withdraw({
        note: note.noteString,
        recipient: recipientWallet.address,
        provider,
        signer,
        relayer,
        fee: '0.001',
      });

      // Create a timestamped directory for this withdrawal
      const withdrawalTime = Date.now();
      const withdrawalDir = path.join(
        this.processedDir,
        withdrawalTime.toString()
      );
      fs.mkdirSync(withdrawalDir, { recursive: true });

      // Move and update the note file
      note.processed = true;
      fs.writeFileSync(
        path.join(withdrawalDir, `note-${fileName}`),
        JSON.stringify(
          {
            ...note,
            withdrawalTxHash: result.txHash,
            withdrawalTime,
            recipientAddress: recipientWallet.address,
          },
          null,
          2
        )
      );

      // Save recipient wallet info in the same directory
      fs.writeFileSync(
        path.join(withdrawalDir, 'wallet.json'),
        JSON.stringify(
          {
            address: recipientWallet.address,
            privateKey: recipientWallet.privateKey,
            withdrawalTxHash: result.txHash,
            withdrawalTime,
            originalNote: fileName,
          },
          null,
          2
        )
      );

      // Remove original note file
      fs.unlinkSync(path.join(this.notesDir, fileName));

      this.totalMixed += Number(note.amount);
      this.log(
        `Scheduled withdrawal successful to ${recipientWallet.address}. Files saved in ${withdrawalDir}`
      );
    } catch (error) {
      this.log(
        `Scheduled withdrawal failed for note ${fileName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    
    
  }

  private scheduleNextDeposit() {
    const nextInterval = this.getRandomInterval(this.strategy.interval, 59);
    this.depositInterval = setTimeout(
      () => this.executeDeposit(),
      nextInterval * 1000
    );
    this.log(`Next deposit scheduled in ${nextInterval} seconds`);
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.scheduleNextDeposit();

    // Start withdrawal processor
    this.withdrawalProcessor = setInterval(
      () => this.processScheduledWithdrawals(),
      60000
    ); // Check every minute
  }

  stop(): void {
    if (this.depositInterval) {
      clearTimeout(this.depositInterval);
    }
    if (this.withdrawalProcessor) {
      clearInterval(this.withdrawalProcessor);
    }
    this._isRunning = false;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  public async getStatus(): Promise<any> {
    const unprocessedNotes = fs
      .readdirSync(this.notesDir)
      .filter((file) => file.endsWith('.json')).length;

    const processedNotes = fs
      .readdirSync(this.processedDir)
      .filter((file) => file.startsWith('processed-')).length;

    return {
      name: this.strategy.name,
      status: this.isRunning() ? 'Running' : 'Stopped',
      unprocessedNotes,
      processedNotes,
      totalMixed: this.totalMixed,
      currency: this.strategy.currency,
      lastUpdate: new Date().toISOString(),
    };
  }

  public getName(): string {
    return this.strategy.name;
  }

  public getWalletPrivateKey(): string {
    return process.env[this.strategy.privateKeyEnvKey] as string;
  }

  public getKey(): string {
    return this.strategy.key;
  }

  public async getDisplayInfo(): Promise<string[]> {
    const wallet = Web3Helper.getWallet(this.getWalletPrivateKey());
    return [
      `Type: Tornado Mixer`,
      `Key: ${this.strategy.key}`,
      `Wallet: ${wallet.address}`,
      `Amount per mix: ${this.strategy.amount} ${this.strategy.currency}`,
      `Total mixed: ${this.totalMixed} ${this.strategy.currency}`,
      `Base interval: ${this.strategy.interval}s`,
      `Deposit variation: ±59%`,
      `Withdrawal variation: ±63%`,
      `Active notes: ${
        fs.readdirSync(this.notesDir).filter((f) => f.endsWith('.json')).length
      }`,
      `Processed notes: ${
        fs
          .readdirSync(this.processedDir)
          .filter((f) => f.startsWith('processed-')).length
      }`,
    ];
  }

  public async handleCommand(action: string, args: string[]): Promise<string> {
    switch (action.toLowerCase()) {
      case 'status':
        return JSON.stringify(await this.getStatus(), null, 2);
      case 'deposit':
        await this.executeDeposit();
        return 'Deposit command received';
      case 'withdraw':
        return this.handleWithdrawalCommand(args);
      default:
        return `Unknown command: ${action}. Available commands: status, withdraw`;
    }
  }

  private async handleWithdrawalCommand(args: string[]): Promise<string> {
    let noteFile = args[0];
    if (!noteFile.endsWith('.json')) {
      noteFile = `${noteFile}.json`;
    }
    const note = JSON.parse(fs.readFileSync(path.join(this.notesDir, noteFile), 'utf8')) as Note;
    await this.processWithdrawal(note, noteFile);
    return `Withdrawal command received for note ${noteFile}`;
  }
}
