import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('lib/analysis-direction-history-v1.js', 'utf8');
const body = source.slice(source.indexOf('export async function ensureAnalysisDirectionHistorySchema()'), source.indexOf('\nfunction databaseRecordPayload')).replace('export ', '');
const batches = [];
let fail = false;
const client = (strings, ...values) => ({ text: String.raw({ raw: strings }, ...values) });
client.transaction = async statements => {
  batches.push(statements);
  await Promise.resolve();
  if (fail) throw new Error('database temporarily unavailable');
};
const context = vm.createContext({ sql: () => client, analysisDirectionHistoryDatabaseConfigured: () => true });
vm.runInContext(`let schemaReady; ${body}; globalThis.ensure = ensureAnalysisDirectionHistorySchema;`, context);
await Promise.all(Array.from({ length: 8 }, () => context.ensure()));
assert.equal(batches.length, 1, 'concurrent calls in one worker share initialization');
assert.match(batches[0][0].text, /pg_advisory_xact_lock/);
assert.ok(batches[0].length > 10, 'all schema DDL is captured in the transaction');
assert.match(batches[0].at(-1).text, /CREATE TRIGGER/);
assert.equal((body.match(/await sql\(\)/g) || []).length, 1, 'no DDL executes outside the transaction');
if (process.argv.includes('--sql')) {
  process.stdout.write('BEGIN;\n' + batches[0].map(s => s.text.trim().replace(/;$/, '') + ';').join('\n') + '\nCOMMIT;\n');
} else {
  const retryContext = vm.createContext({ sql: () => client, analysisDirectionHistoryDatabaseConfigured: () => true });
  vm.runInContext(`let schemaReady; ${body}; globalThis.ensure = ensureAnalysisDirectionHistorySchema;`, retryContext);
  fail = true;
  await assert.rejects(retryContext.ensure(), /temporarily unavailable/);
  fail = false;
  await retryContext.ensure();
  assert.equal(batches.length, 3, 'failed initialization can be retried');
  console.log('PASS direction schema transaction, worker coalescing, and retry');
}
