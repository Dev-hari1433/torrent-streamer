// Keep regression downloads and saved sessions away from the running application.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const tempRoot = resolve('../.runtime');
await mkdir(tempRoot, { recursive: true });
const dataDirectory = await mkdtemp(join(tempRoot, 'lumora-suite-'));
try {
  const tempDirectory = join(dataDirectory, 'tmp'); await mkdir(tempDirectory);
  const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts')
    && (name !== 'sparseStore.test.ts' || process.env.LUMORA_TEST_LARGE_OFFSETS === '1')).map(name => join('test', name));
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...tests], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, DATA_DIR: dataDirectory,
        TEMP: tempDirectory, TMP: tempDirectory, TMPDIR: tempDirectory, NODE_COMPILE_CACHE: join(tempDirectory, 'node-cache') },
    });
    child.once('error', reject); child.once('close', code => resolveExit(code ?? 1));
  });
} finally {
  if (dirname(resolve(dataDirectory)) !== tempRoot) throw new Error('Refusing cleanup outside the test temporary directory');
  await rm(dataDirectory, { recursive: true, force: true });
}
