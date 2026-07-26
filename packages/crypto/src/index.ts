/**
 * @ledger/crypto — the only module in the codebase that sees key material.
 *
 * Everything else deals in `SealedValue`. If you find yourself importing `node:crypto` outside
 * this package to protect something, the thing you want is probably already here.
 */

export {
  Keyring,
  type KeyMaterial,
  type SealedValue,
  aadFor,
  keyFromBase64,
  keyIdFor,
  open,
  reseal,
  safeEqual,
  seal,
} from './envelope';

export {
  type KekProvider,
  envKekProvider,
  getKeyring,
  kmsKekProvider,
  resetKeyringCache,
  selectKekProvider,
} from './keyring';
