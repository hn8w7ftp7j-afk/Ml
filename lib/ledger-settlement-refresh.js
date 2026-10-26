import { requireCloudLedgerResponse } from './cloud-ledger-receipt.js';

// A lost settlement response does not prove that reading the ledger failed.
// Never retry the write here: it may already have committed. Read every page
// independently before deciding whether complete statistics can be published.
export async function readLedgerAfterSettlement(settle, readLedger) {
  let settlement = null;
  let settlementError = null;
  try {
    settlement = requireCloudLedgerResponse(await settle());
  } catch (error) {
    settlementError = error;
  }
  const ledger = requireCloudLedgerResponse(await readLedger());
  return { ledger, settlement, settlementError };
}
