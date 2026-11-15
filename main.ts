// Entry lifecycle for the github-core-clone forge.
//
// The trial pod runs this file as `node /bot/main.ts`. Its only job is the
// handshake with the trial environment (the "env"): bind an ephemeral port,
// tell the env which port the forge listens on, then wait until the env says
// the trial is over and exit cleanly. All of the actual forge behaviour lives
// in app.ts (and lib/); this file owns no state and serves no requests.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial).
//      Without it there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never
//      bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address
//      the request came from plus N as the base URL and dials it from then on.
//      The first register wins; a 409 means another entry already registered,
//      and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with a
//      short exponential backoff; the process never exits before the env says
//      done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

// The env's base URL, with any trailing slashes removed so the paths below
// always join cleanly. Empty when the variable is unset.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request may take at most this long before it is abandoned and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Backoff between retries: start here, double each time, never exceed the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait after `failures` failed attempts: exponential from BACKOFF_START_MS,
// capped at BACKOFF_CAP_MS.
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

// POST the bound port to the env until it accepts the registration.
// 200 is the normal answer; 409 means a first register already won, which is
// not this process's to fix. 400 and 405 are contract errors and end the
// program; a network error or any other status is retried, since the env may
// still be starting.
async function registerWithEnv(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoffMs(failures));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForTrialDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done,
      // so poll again.
    }
    await sleep(backoffMs(failures));
  }
}

// Bound the port, register it, then wait for the env: the whole life of the
// process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerWithEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForTrialDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
