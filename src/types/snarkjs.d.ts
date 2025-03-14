declare module 'snarkjs' {
  export function buildGroth16(): {
    prove: (input: any) => Promise<{
      proof: any;
      publicSignals: any[];
    }>;
  };
}
