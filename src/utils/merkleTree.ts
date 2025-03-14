import { ethers } from 'ethers';
import { buffPedersenHash } from './pedersen';

export class MerkleTree {
  private levels: number;
  private hashFn: (left: Buffer, right: Buffer) => Buffer;
  private leaves: string[];
  private layers: string[][];

  constructor(levels: number, leaves: string[] = []) {
    this.levels = levels;
    this.hashFn = this.pedersenHash;
    this.leaves = leaves;
    this.layers = [leaves];
    this.buildTree();
  }

  private pedersenHash(left: Buffer, right: Buffer): Buffer {
    const combined = Buffer.concat([left, right]);
    return buffPedersenHash(combined);
  }

  private buildTree(): void {
    for (let level = 0; level < this.levels; level++) {
      const currentLayer = this.layers[level];
      const nextLayer: string[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
        const hash = this.hashFn(
          Buffer.from(left.slice(2), 'hex'),
          Buffer.from(right.slice(2), 'hex')
        );
        nextLayer.push('0x' + hash.toString('hex'));
      }

      this.layers.push(nextLayer);
    }
  }

  public root(): string {
    return this.layers[this.layers.length - 1][0];
  }

  public indexOf(element: string): number {
    return this.leaves.indexOf(element);
  }

  public path(index: number): {
    pathElements: string[];
    pathIndices: number[];
  } {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error('Index out of bounds');
    }

    const pathElements: string[] = [];
    const pathIndices: number[] = [];
    let currentIndex = index;

    for (let level = 0; level < this.levels; level++) {
      const currentLayer = this.layers[level];
      const pairIndex =
        currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;

      if (pairIndex < currentLayer.length) {
        pathElements.push(currentLayer[pairIndex]);
      } else {
        pathElements.push(currentLayer[currentIndex]);
      }

      pathIndices.push(currentIndex % 2);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}
