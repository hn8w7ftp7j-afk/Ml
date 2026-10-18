// Fixture tests must never inherit deployed database or account credentials.
// The parent build keeps its environment for the real source check and build.
import { spawnSync } from 'node:child_process';

const env = { ...process.env, NODE_ENV: 'test' };
for (const key of Object.keys(env)) {
  if (/(?:DATABASE|POSTGRES|NEON|REDIS|UPSTASH|(?:^|_)PG(?:HOST|PORT|USER|PASSWORD|DATABASE)|TOKEN|SECRET|PASSWORD|(?:^|_)API_KEY|(?:^|_)PRIVATE_KEY|WEB_PUSH|VAPID)/i.test(key)
    || key === 'VERCEL' || key.startsWith('VERCEL_')) delete env[key];
}
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
  env, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
