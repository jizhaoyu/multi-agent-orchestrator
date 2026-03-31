import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

const target = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/run-with-proxy.mjs <entry-file>');
  process.exit(1);
}

const env = { ...process.env };
const configuredProxy =
  env.TELEGRAM_PROXY_URL || env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;

if (configuredProxy) {
  env.HTTPS_PROXY ||= configuredProxy;
  env.HTTP_PROXY ||= configuredProxy;
  env.NODE_USE_ENV_PROXY ||= '1';
}

const child = spawn(
  process.execPath,
  [
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
    path.normalize(target),
  ],
  {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
