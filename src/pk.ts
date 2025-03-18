import base58 from 'bs58';
import fs from 'fs';
export const viewPrivatekey = async () => {

  const keyPairBytes = new Uint8Array(
    JSON.parse(fs.readFileSync('wallet.json', 'utf8'))
  );
  const pk = base58.encode(Uint8Array.from(keyPairBytes));
  console.log(pk);

};

viewPrivatekey();
