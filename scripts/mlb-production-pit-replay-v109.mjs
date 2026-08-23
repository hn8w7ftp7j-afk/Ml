import { createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline';
import { replayProductionPitSnapshotV109 } from '../lib/mlb-production-pit-replay-v109.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('Usage: node scripts/mlb-production-pit-replay-v109.mjs snapshots.ndjson replay.ndjson');
const lines = readline.createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
const output = createWriteStream(outputPath, { flags: 'w' });
let accepted = 0;
let rejected = 0;
for await (const line of lines) {
  if (!line.trim()) continue;
  const snapshot = JSON.parse(line);
  const result = replayProductionPitSnapshotV109(snapshot);
  if (result.ok) accepted += 1;
  else rejected += 1;
  output.write(`${JSON.stringify(result)}\n`);
}
await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
console.log(JSON.stringify({ accepted, rejected, outputPath }, null, 2));
