import { describe, expect, it } from 'vitest';
import { walletError } from './walletErrors';

describe('walletError', () => {
  it('distinguishes cancellation, insufficient funds, RPC failure, replacement, and revert states', () => {
    expect(walletError({ code: 4001, message: 'User rejected the request' })).toContain('cancelled');
    expect(walletError(new Error('insufficient funds for intrinsic transaction cost'))).toContain('enough SHIDO');
    expect(walletError(new Error('RPC gateway timed out'))).toContain('not answering');
    expect(walletError(new Error('transaction replaced by a repriced transaction'))).toContain('replaced');
    expect(walletError(new Error('execution reverted: voucher already used'))).toContain('contract rejected');
  });

  it('does not surface unknown provider internals to players', () => {
    expect(walletError(new Error('eth_estimateGas internal JSON blob 0xdeadbeef'))).toBe('Your wallet could not complete that step. Nothing is marked minted—retry from the Vault when you are ready.');
  });
});
