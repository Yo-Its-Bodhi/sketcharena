function errorCode(error: unknown): number {
  if (typeof error !== 'object' || !error || !('code' in error)) return 0;
  return Number((error as { code: unknown }).code) || 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== 'object' || !error) return '';
  const candidate = error as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
  const direct = [candidate.shortMessage, candidate.message, candidate.details].find((value) => typeof value === 'string');
  return typeof direct === 'string' ? direct : candidate.cause ? errorMessage(candidate.cause) : '';
}

export function walletError(error: unknown): string {
  const code = errorCode(error); const message = errorMessage(error).toLowerCase();
  if (code === 4001 || /user rejected|user denied|rejected the request/.test(message)) return 'Nothing was spent—you cancelled in your wallet.';
  if (code === 4100 || /unauthori[sz]ed|not authorized/.test(message)) return 'Your wallet has not approved this account yet. Reconnect it and try again.';
  if (code === 4900 || /wallet.*disconnected|provider.*disconnected/.test(message)) return 'Your wallet is disconnected. Reopen it, reconnect, and then retry safely.';
  if (code === 4901 || /chain.*disconnected|unsupported chain|wrong network/.test(message)) return 'Your wallet is not connected to the required Shido network. Switch networks and retry.';
  if (code === -32002 || /request.*already pending|already processing/.test(message)) return 'Your wallet already has a request waiting. Open the wallet and finish or cancel that request first.';
  if (/insufficient funds|not enough.*(?:shido|gas|funds)|exceeds balance/.test(message)) return 'Your wallet does not have enough SHIDO for the Arena fee and network gas. Add funds, then retry—the Mint Credit or discount has not been spent.';
  if (/transaction replaced|replacement transaction|repriced|cancelled transaction/.test(message)) return 'Your wallet replaced or cancelled the transaction. Reopen this artwork in the Vault so Sketch Arena can verify the latest chain result.';
  if (/nonce too low|already known|already imported/.test(message)) return 'This transaction may already have been submitted. Reopen the artwork instead of sending another copy; the Vault will resume confirmation.';
  if (/execution reverted|contract.*revert|reverted/.test(message)) return 'The Panic Archive contract rejected this mint. Nothing will be marked minted and your Mint Credit remains safe.';
  if (/timeout|timed out|failed to fetch|network error|rpc|gateway|service unavailable/.test(message)) return 'The Shido network is not answering right now. Your artwork and reward are safe; wait a moment and retry.';
  return 'Your wallet could not complete that step. Nothing is marked minted—retry from the Vault when you are ready.';
}
