import { buildPedersenHash } from 'circomlibjs';

class Pedersen {
  private pedersenHash: any;
  private babyJub: any;
  private initialized: boolean;

  constructor() {
    this.pedersenHash = null;
    this.babyJub = null;
    this.initialized = false;
    this.initPedersen();
  }

  private async initPedersen() {
    if (!this.initialized) {
      this.pedersenHash = await buildPedersenHash();
      this.babyJub = this.pedersenHash.babyJub;
      this.initialized = true;
    }
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initPedersen();
    }
  }

  unpackPoint(buffer: Buffer): any[] {
    return this.babyJub.unpackPoint(this.pedersenHash.hash(buffer));
  }

  toStringBuffer(buffer: any): string {
    return this.babyJub.F.toString(buffer);
  }
}

const pedersen = new Pedersen();

export function buffPedersenHash(buffer: Buffer): Buffer {
  const [hash] = pedersen.unpackPoint(buffer);
  return Buffer.from(pedersen.toStringBuffer(hash));
}

export { pedersen };
