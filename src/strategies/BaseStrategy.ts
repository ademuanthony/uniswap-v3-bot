import { Strategy } from '../types/Strategy';

export abstract class BaseStrategy implements Strategy {
  protected _isRunning: boolean = false;
  protected stopRequested: boolean = false;

  constructor(
    public readonly name: string,
    public readonly type: string,
    public readonly privateKeyEnvKey: string,
    public readonly base_token: string,
    public readonly quote_token: string,
    public readonly interval: number
  ) {}

  public abstract execute(): Promise<void>;

  public isRunning(): boolean {
    return this._isRunning;
  }

  public stop(): void {
    console.log(`Stopping strategy: ${this.name}`);
    this.stopRequested = true;
    this._isRunning = false;
  }

  public async start(): Promise<void> {
    this._isRunning = true;
    this.stopRequested = false;

    while (this._isRunning && !this.stopRequested) {
      try {
        await this.execute();
      } catch (error) {
        console.error(`Error executing strategy ${this.name}:`, error);
        this.stop();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.interval));
    }
  }
}
