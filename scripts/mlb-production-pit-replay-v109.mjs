import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import readline from 'node:readline';
import { replayProductionPitSnapshotV109 } from '../lib/mlb-production-pit-replay-v109.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('Usage: node scripts/mlb-production-pit-replay-v109.mjs snapshots.ndjson replay.ndjson');
// Replay produces a new artifact. Exclusive creation also protects the source
// when output names the same file through a symlink or another path spelling.
const outputHandle = await open(outputPath, 'wx');
const output = outputHandle.createWriteStream();
const lines = readline.createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
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
