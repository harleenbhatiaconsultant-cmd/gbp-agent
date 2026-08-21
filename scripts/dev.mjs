/**
 * Dev server launcher.
 *
 * Exists because `next dev` silently falls through to the next free port when
 * 3000 is taken. That is friendly in isolation and awful in practice: you end
 * up with an old build on 3000 and a new one on 3001, and every subsequent
 * observation is against whichever one you happened to open. It cost real
 * confusion during this project.
 *
 * So this refuses to start rather than move. A server on an unexpected port is
 * worse than no server, because no server is obvious and a stale one is not.
 *
 *   npm run dev          check 3000; start if free, otherwise fail loudly
 *   npm run dev -- -p N  same, for a different port
 *   npm run dev:force    stop whatever holds the port first, then start
 *
 * `--force` is deliberately NOT the default. Killing an unidentified process
 * because it is in the way is the kind of convenience that eventually takes out
 * something someone cared about.
 */

import { createServer } from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const force = args.includes('--force');
const passThrough = args.filter((arg) => arg !== '--force');

const portFlagIndex = passThrough.findIndex((arg) => arg === '-p' || arg === '--port');
const port =
  portFlagIndex !== -1 && passThrough[portFlagIndex + 1]
    ? Number.parseInt(passThrough[portFlagIndex + 1], 10)
    : 3000;

const isWindows = process.platform === 'win32';

/**
 * Binds with NO host, which listens on all interfaces (`::`) exactly as Next
 * does. Checking 127.0.0.1 alone reports a free port when something is already
 * listening on `::`, so the check passes and Next then dies with EADDRINUSE —
 * which is precisely the confusing outcome this script exists to prevent.
 */
function isPortFree(candidate) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(candidate);
  });
}

/** Best effort — used only to tell the human what is in the way. */
function findHolder(candidate) {
  try {
    if (isWindows) {
      const output = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${candidate}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = new Set(
        output
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && pid !== '0'),
      );
      return [...pids];
    }

    const output = execSync(`lsof -ti tcp:${candidate} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function describeProcess(pid) {
  try {
    if (isWindows) {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const name = output.split(',')[0]?.replace(/"/g, '').trim();
      return name || 'unknown';
    }
    return execSync(`ps -p ${pid} -o comm=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function killProcess(pid) {
  try {
    if (isWindows) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let free = await isPortFree(port);

  if (!free) {
    const holders = findHolder(port);

    if (force) {
      for (const pid of holders) {
        const name = describeProcess(pid);
        const killed = killProcess(pid);
        console.log(`  ${killed ? 'stopped' : 'could not stop'} ${name} (PID ${pid}) on ${port}`);
      }
      // Sockets take a moment to release after the process dies.
      await new Promise((resolve) => setTimeout(resolve, 750));
      free = await isPortFree(port);
    }

    if (!free) {
      const detail = holders.length
        ? holders.map((pid) => `      PID ${pid}  (${describeProcess(pid)})`).join('\n')
        : '      could not identify the process';

      console.error(
        [
          '',
          `  Port ${port} is already in use.`,
          '',
          '  Refusing to start on a different port. Next.js would happily move to',
          `  ${port + 1}, which is how you end up reading a stale build and not knowing it.`,
          '',
          '  In the way:',
          detail,
          '',
          '  Either stop it, or run:',
          '      npm run dev:force',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
  }

  const url = `http://localhost:${port}`;
  console.log(
    ['', `  Starting the dev server on ${url}`, `  (port ${port} verified free)`, ''].join('\n'),
  );

  // Run the Next CLI through node directly rather than via npx with a shell.
  // `shell: true` concatenates rather than escapes arguments, which Node now
  // warns about, and it is unnecessary when the binary path is known.
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
  const nextArgs = ['dev', ...(portFlagIndex === -1 ? ['-p', String(port)] : passThrough)];

  const child = spawn(process.execPath, [nextBin, ...nextArgs], { stdio: 'inherit' });

  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
