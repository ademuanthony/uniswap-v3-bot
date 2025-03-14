declare module 'circomlibjs' {
  export function buildPedersenHash(): Promise<{
    hash: (buffer: Buffer) => Uint8Array;
    babyJub: {
      unpackPoint: (point: Uint8Array) => any[];
      F: {
        toString: (value: any) => string;
      };
    };
  }>;
}
