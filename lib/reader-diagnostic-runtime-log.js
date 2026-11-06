import { sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';

// Diagnostics describe an observation, never a live-board save or upload
// authority. Log only the existing allow-listed evidence after its durable ACK.
export function logReaderDiagnosticReceipt(input, receipt, emit = console.info) {
  try {
    const report = sanitizeDiagnosticReport(input);
    const received = Date.parse(receipt?.receivedAt || '');
    if (receipt?.ok !== true || receipt?.durable !== true || receipt.reportId !== report.reportId
      || !Number.isFinite(received) || !report.leagues.NBA) return false;
    const event = {
      code: 'NBA_READER_DIAGNOSTIC_SAVED', reportId: report.reportId,
      createdAt: report.createdAt, receivedAt: new Date(received).toISOString(),
      readerVersion: report.readerVersion, extensionManifestVersion: report.extensionManifestVersion,
      tabCount: report.tabCount, silentTabCount: report.silentTabCount,
      exceptionCode: report.exceptionCode, diagnostic: report.leagues.NBA,
    };
    emit('[NBA_READER_DIAGNOSTIC_SAVED]', JSON.stringify(event));
    return true;
  } catch {
    // A log failure must not revoke a successfully persisted receipt or cause
    // the Reader to retry an already acknowledged market-independent report.
    return false;
  }
}
