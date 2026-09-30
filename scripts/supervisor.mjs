import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime'); mkdirSync(runtime, { recursive: true });
const stopFile = join(runtime, 'stop.request'); rmSync(stopFile, { force: true });
let stopping = false;
const children = new Map(); const retries = new Map();
const record = () => writeFileSync(join(runtime, 'processes.json'), JSON.stringify({ supervisor: process.pid, root, children: [...children].map(([name, child]) => ({ name, pid: child.pid })) }));
const log = (name, data) => appendFileSync(join(runtime, `${name}.log`), data);
function launch(name, args, cwd) {
  if (stopping) return;
  const started = Date.now(); const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(name, child); record();
  log(name, `\n[${new Date().toISOString()}] Starting ${name}\n`);
  child.stdout.on('data', chunk => log(name, chunk)); child.stderr.on('data', chunk => log(name, chunk));
  child.on('error', error => log(name, `${error.message}\n`));
  child.on('exit', (code, signal) => {
    children.delete(name); record(); log(name, `[${new Date().toISOString()}] Exited: ${code ?? signal}\n`);
    if (!stopping) {
      const count = Date.now() - started > 60000 ? 0 : (retries.get(name) ?? 0) + 1; retries.set(name, count);
      setTimeout(() => launch(name, args, cwd), Math.min(30000, 1000 * 2 ** Math.min(count, 5)));
    }
  });
}
function stop() {
  if (stopping) return; stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    rmSync(join(runtime, 'processes.json'), { force: true }); rmSync(stopFile, { force: true }); process.exit(0);
  }, 1500);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => { if (existsSync(stopFile)) stop(); }, 500);
launch('backend', ['--env-file-if-exists=.env', join(root, 'backend/dist/server.js')], join(root, 'backend'));
launch('frontend', [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1'], join(root, 'frontend'));
