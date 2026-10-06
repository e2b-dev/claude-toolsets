/**
 * Start (or find) headless Chrome inside an E2B sandbox and return the DevTools endpoint the driver connects to.
 *
 * The model loop stays on this machine and drives the browser over CDP through the sandbox's proxied host, which is
 * checklist item 6 of the SDK guide ("isolate the browser host per session, model loop outside it") done by E2B.
 * No in-sandbox proxy is needed:
 * - Chrome binds 127.0.0.1:9222 only, and envd forwards localhost ports, so the E2B proxy reaches it.
 * - Chrome refuses a Host header that is not an IP or `localhost`; `maskRequestHost` makes the proxy rewrite it.
 * - `allowPublicTraffic: false` puts the port behind the `e2b-traffic-access-token` header. It is not an option:
 *   loopback is not a boundary on E2B (FEAT-66), so an open CDP port would be remote control of the browser for
 *   anyone with the host name.
 * - `allowOut` plus `denyOut: ['0.0.0.0/0']` is the egress policy (checklist item 3), enforced outside the browser.
 *
 * Chrome keeps its own sandbox on: verified on the stock `desktop` template (Chrome 150, kernel 6.1), where it runs
 * as the default `user` with the setuid `chrome-sandbox` helper and renderers come up under seccomp-bpf, NoNewPrivs
 * and their own user namespace. So there is no `--no-sandbox`, and no `--remote-allow-origins=*` either: the
 * driver's handshake sends no Origin header, so Chrome's origin check never applies to it.
 */

import { Sandbox } from 'e2b';

export const CDP_PORT = 9222;
const START_TIMEOUT_MS = 60_000; // usually 3 to 5 s; a cold sandbox (font cache, first run) can take far longer
const DEFAULT_TEMPLATE = 'desktop';
const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60_000;

/** A startup failure. Its message is a fixed phrase; the underlying detail goes to the `debug` hook only. */
/** Startup failed and so did its cleanup. Call `close()` on this error to retry releasing what was started. */
export class BrowserInitializationError extends Error {
  override name = 'BrowserInitializationError';
  readonly #toolset: { close(): Promise<void> };

  constructor(toolset: { close(): Promise<void> }) {
    super('Browser initialization and cleanup failed; call error.close() to retry cleanup');
    this.#toolset = toolset;
  }

  close(): Promise<void> {
    return this.#toolset.close();
  }
}

export class BrowserSandboxError extends Error {
  override name = 'BrowserSandboxError';
}

export interface BrowserSandboxOptions {
  /** E2B API key. Defaults to `E2B_API_KEY`. */
  apiKey?: string | undefined;
  /** Template with `google-chrome` on PATH. Default `desktop`. */
  template?: string | undefined;
  /**
   * Attach to this sandbox instead of creating one. Chrome is started in it unless its DevTools port already answers.
   * It must have been created with `network.allowPublicTraffic: false` and `maskRequestHost: 'localhost:${PORT}'`.
   */
  sandbox?: Sandbox | undefined;
  /** Egress allowlist (hosts, IPs, CIDRs). Given, everything else is denied. Omitted, egress stays open. */
  allowOut?: string[] | undefined;
  /** Sandbox lifetime in ms. Default 10 minutes. */
  timeoutMs?: number | undefined;
  /** Chrome window size; the driver also pins the viewport to it. */
  viewport?: { width: number; height: number } | undefined;
  /** Sandbox metadata, for finding your sandboxes later (`Sandbox.list`). */
  metadata?: Record<string, string> | undefined;
  /** Receives diagnostics that must not reach the model or an exception, such as the tail of Chrome's log. */
  debug?: ((line: string) => void) | undefined;
  /**
   * Run Chrome headful on this X display of the sandbox (for example `:0`) instead of headless, so a person can watch
   * it over VNC. The display must already be running (the `desktop` template's, started by `@e2b/desktop`).
   */
  display?: string | undefined;
}

export interface BrowserSandbox {
  sandbox: Sandbox;
  /** The browser DevTools endpoint, `wss://<host><path>`. A secret together with `headers`: never log it. */
  wsUrl: string;
  /** Handshake headers: the traffic access token. */
  headers: Record<string, string>;
  /** Whether this call started Chrome (false when it was already running in an attached sandbox). */
  launchedChrome: boolean;
  /** Where Chrome saves downloads (named by their download guid), in a fresh 0700 directory. Never shown to the model. */
  downloadDir: string;
  /** The session's directory (profile, log, downloads). With `launchedChrome`, `stopChrome` stops that Chrome. */
  sessionDir: string;
}

/**
 * The X display Chrome opens a window on, or undefined to run it headless.
 *
 * Default: visible on the screen of an `@e2b/desktop` sandbox (its `display`, usually `:0`), so the live view and the
 * computer toolset see it; headless everywhere else. `headless: true` hides it on a desktop too; `display` picks a
 * screen explicitly (a custom template running its own X server).
 */
export function resolveDisplay(
  sandbox: unknown,
  headless: boolean | undefined,
  display: string | undefined,
): string | undefined {
  if (headless === true) {
    if (display !== undefined)
      throw new BrowserSandboxError('headless: true and display contradict each other; pass one');
    return undefined;
  }
  const screen = (sandbox as { display?: unknown } | undefined)?.display;
  const chosen = display ?? (typeof screen === 'string' ? screen : undefined);
  if (headless === false && chosen === undefined)
    throw new BrowserSandboxError('headless: false needs a screen: attach an @e2b/desktop sandbox or pass display');
  return chosen;
}

/**
 * Stop the Chrome this module started with `dir` as its session directory, and only that one: it is found by its
 * profile path, so a browser the sandbox's owner runs is left alone.
 */
export async function stopChrome(sandbox: Sandbox, dir: string): Promise<void> {
  if (!/^\/tmp\/e2b-browser-[A-Za-z0-9]+$/.test(dir)) throw new BrowserSandboxError('Not a browser session directory');
  // `profil[e]` matches Chrome's argument but not this command line, so pkill does not kill its own shell. Wait until
  // Chrome has exited (up to 3 s), then force it; pkill and pgrep exit 1 when nothing matches, the browser being gone.
  const match = `'--user-data-dir=${dir}/profil[e]'`;
  await sandbox.commands.run(
    `pkill -f -- ${match}; for _ in $(seq 30); do pgrep -f -- ${match} >/dev/null || exit 0; sleep 0.1; done; pkill -9 -f -- ${match}; true`,
    { timeoutMs: 10_000 },
  );
}

/**
 * The Chrome command line. The environment is scrubbed (`env -i`) so the browser holds none of the sandbox's
 * variables. The profile and the log (which names the DevTools endpoint) live in `dir`, the session's fresh 0700
 * directory.
 */
function chromeCommand(viewport: { width: number; height: number }, dir: string, display: string | undefined): string {
  const flags = [
    ...(display === undefined ? ['--headless=new'] : ['--window-position=0,0', '--test-type']),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${dir}/profile`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-dev-shm-usage',
    `--window-size=${viewport.width},${viewport.height}`,
    // refuses a public page's requests to loopback and private addresses inside the browser (guide item 3)
    '--enable-features=LocalNetworkAccessChecks',
    'about:blank',
  ];
  const x = display === undefined ? '' : ` DISPLAY=${display}`;
  return `exec env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8${x} google-chrome ${flags.join(' ')} >${dir}/chrome.log 2>&1`;
}

/** A fresh 0700 directory for this session (mktemp creates it so), with an empty `downloads` directory in it. */
async function sessionDir(sandbox: Sandbox): Promise<string> {
  const out = await sandbox.commands.run(
    'd=$(mktemp -d /tmp/e2b-browser-XXXXXX) && mkdir -m 700 "$d/downloads" && echo "$d"',
    {
      timeoutMs: 5_000,
    },
  );
  const dir = out.stdout.trim();
  if (!/^\/tmp\/e2b-browser-[A-Za-z0-9]+$/.test(dir))
    throw new BrowserSandboxError('Could not prepare the browser directory');
  return dir;
}

/** The browser endpoint's path (`/devtools/browser/<id>`), read from inside the sandbox over envd, or undefined. */
async function devtoolsPath(sandbox: Sandbox): Promise<string | undefined> {
  const out = await sandbox.commands
    .run(`curl -s -m 1 http://127.0.0.1:${CDP_PORT}/json/version; true`, { timeoutMs: 5_000 })
    .then((result) => result.stdout)
    .catch(() => '');
  try {
    const endpoint = (JSON.parse(out) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
    return typeof endpoint === 'string' ? new URL(endpoint).pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sandbox with headless Chrome listening on its DevTools port, and how to reach it. A sandbox this call created is
 * killed if Chrome does not come up. Errors carry fixed text: no sandbox id, host, token or log contents.
 */
export async function startBrowserSandbox(opts: BrowserSandboxOptions = {}): Promise<BrowserSandbox> {
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  if (opts.display !== undefined && !/^:\d{1,3}$/.test(opts.display))
    throw new BrowserSandboxError('display must look like :0');
  const owned = opts.sandbox === undefined;
  // These are fixed when a sandbox is created. Ignoring them on an attached one would mislead: a caller who passes
  // timeoutMs expects the sandbox to end then.
  if (!owned) {
    const given = (['apiKey', 'template', 'allowOut', 'timeoutMs', 'metadata'] as const).filter(
      (key) => opts[key] !== undefined,
    );
    if (given.length > 0)
      throw new BrowserSandboxError(
        `${given.join(', ')} ${given.length === 1 ? 'applies' : 'apply'} only to a sandbox this call creates; set ${given.length === 1 ? 'it' : 'them'} when you create yours`,
      );
  }
  const sandbox =
    opts.sandbox ??
    (await Sandbox.create(opts.template ?? DEFAULT_TEMPLATE, {
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      network: {
        allowPublicTraffic: false,
        maskRequestHost: 'localhost:${PORT}',
        ...(opts.allowOut !== undefined ? { allowOut: opts.allowOut, denyOut: ['0.0.0.0/0'] } : {}),
      },
    }).catch((error: unknown) => {
      opts.debug?.(`sandbox create failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new BrowserSandboxError('Could not create the browser sandbox');
    }));

  let dir: string | undefined;
  let launchedChrome = false;
  try {
    const token = sandbox.trafficAccessToken;
    if (token === undefined)
      throw new BrowserSandboxError(
        'The sandbox has public traffic enabled; create it with network.allowPublicTraffic: false',
      );

    dir = await sessionDir(sandbox);
    let path = await devtoolsPath(sandbox);
    launchedChrome = path === undefined;
    if (launchedChrome) {
      const launchedAt = Date.now();
      // timeoutMs 0: a background command is otherwise killed after the default 60 s
      const handle = await sandbox.commands.run(chromeCommand(viewport, dir, opts.display), {
        background: true,
        timeoutMs: 0,
      });
      await handle.disconnect();
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (path === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        path = await devtoolsPath(sandbox);
      }
      opts.debug?.(`chrome ${path === undefined ? 'did not answer' : 'answered'} after ${Date.now() - launchedAt} ms`);
    }
    if (path === undefined) {
      if (opts.debug) {
        const tail = await sandbox.commands.run(`tail -20 ${dir}/chrome.log; true`).catch(() => undefined);
        opts.debug(`chrome did not start; log tail:\n${tail?.stdout ?? '(unreadable)'}`);
      }
      throw new BrowserSandboxError(`Chrome did not start in the sandbox within ${START_TIMEOUT_MS / 1000} s`);
    }
    return {
      sandbox,
      wsUrl: `wss://${sandbox.getHost(CDP_PORT)}${path}`,
      headers: { 'e2b-traffic-access-token': token },
      launchedChrome,
      downloadDir: `${dir}/downloads`,
      sessionDir: dir,
    };
  } catch (error) {
    const cleanup = async () => {
      if (owned) await sandbox.kill();
      // a Chrome that started too slowly would keep running in the caller's sandbox with nobody attached
      else if (launchedChrome && dir !== undefined) await stopChrome(sandbox, dir);
    };
    if (
      !(await cleanup().then(
        () => true,
        () => false,
      ))
    )
      throw new BrowserInitializationError({ close: cleanup });
    if (error instanceof BrowserSandboxError) throw error;
    opts.debug?.(`browser start failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new BrowserSandboxError('Could not start Chrome in the sandbox');
  }
}
