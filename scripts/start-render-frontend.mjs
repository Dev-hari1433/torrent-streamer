import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const port = process.env.PORT || '3000';
const command = resolve('node_modules/next/dist/bin/next');
const child = spawn(process.execPath, [command, 'start', 'frontend', '--hostname', '0.0.0.0', '--port', port],
  { stdio: 'inherit', env: process.env, windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
