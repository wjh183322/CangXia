
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { assertIsolatedProbeMount, readProbeConfig, validateAccessHost } from '../src/config.mjs';
import { ProbeError } from '../src/contracts.mjs';
import { startProbe } from '../src/server.mjs';

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
let home, xvfb, probe, closing = false;
try {
  if (process.platform !== 'linux' || !process.getuid() || !process.getgid()) {
    throw new ProbeError('PROBE_NONROOT_REQUIRED', 'Run the Linux probe with a non-root UID and GID.');
  }
  const config = readProbeConfig(process.env);
  validateAccessHost(config.accessHost);
  assertIsolatedProbeMount(await readFile('/proc/self/mountinfo', 'utf8'));

  process.umask(0o077);
  home = await mkdtemp('/tmp/cangxia-runtime-');
  process.env.HOME = home;
  process.env.XDG_RUNTIME_DIR = home;
  xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const displayFailure = () => {
    if (!closing) stop.abort(new ProbeError('PROBE_DISPLAY_FAILED', 'The internal display stopped.'));
  };
  xvfb.once('error', displayFailure);
  xvfb.once('exit', displayFailure);
  const lines = createInterface({ input: xvfb.stdio[3] });
  const startup = AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]);
  const [display] = await once(lines, 'line', { signal: startup });
  lines.close();
  if (!/^[0-9]{1,5}$/.test(display)) throw new ProbeError('PROBE_DISPLAY_FAILED', 'The internal display is invalid.');
  process.env.DISPLAY = ':' + display;
  stop.signal.throwIfAborted();
  probe = await startProbe({ config });

  if (!stop.signal.aborted) await once(stop.signal, 'abort');
  stop.signal.throwIfAborted();
} catch (error) {
  const failure = error instanceof ProbeError ? error : error.cause;
  const orderly = stop.signal.aborted && stop.signal.reason?.name === 'AbortError' &&
    (error.name === 'AbortError' || stop.signal.reason === error);
  if (!orderly) {
    console.error(failure instanceof ProbeError ? failure.code : 'PROBE_START_FAILED');
    process.exitCode = 1;
  }
} finally {
  closing = true;
  try {
    await probe?.close();
  } catch {
    console.error('PROBE_SHUTDOWN_FAILED');
    process.exitCode = 1;
  }
  if (xvfb?.pid && xvfb.exitCode === null && xvfb.signalCode === null) {
    const exited = once(xvfb, 'exit');
    xvfb.kill();
    await exited;
  }
  if (home) await rm(home, { recursive: true, force: true });
}
