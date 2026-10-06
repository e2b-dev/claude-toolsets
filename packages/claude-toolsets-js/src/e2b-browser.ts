/**
 * The browser toolset (`browser_toolset_20260801`) over CDP, with headless Chrome in an E2B sandbox.
 *
 * `E2BBrowserToolset.create()` starts a sandbox (or attaches to yours), starts Chrome in it and connects over the
 * sandbox's token-gated proxy, then serves every default-on member plus `javascript_exec`, `read_console` and
 * `read_network` (default-off: enable them in `configs`; `javascript_exec` also needs `confirm`). The model loop, the
 * API key and the conversation stay in this process; only the browser runs in the sandbox.
 *
 * What it adds over the quickstart driver:
 * - a tab registry: every page target is attached (popups too, paused until set up), with stable `tab_N` ids,
 *   exactly one active tab and `tab_opened` changes;
 * - request interception, in every tab and cross-site iframe (and in service workers, which pages bypass): every
 *   document request (redirect hops and page-started navigations included) goes through the driver's scheme check
 *   and the `urlPolicy`, and a refused one is reported as `navigation_refused`. Requests of any kind to local
 *   addresses (loopback, private ranges, link-local) go through the policy too, and the DevTools and envd ports are
 *   always refused, so a page cannot reach the sandbox's own services. Other subresources are left to the sandbox
 *   egress policy (`allowOut`). Without a `urlPolicy`, only the scheme check and the port refusal apply;
 * - dialogs dismissed and reported, downloads kept in the sandbox and reported, console and network buffers;
 * - page scripts run in an isolated world, so a page's own globals can neither break nor spoof them.
 *
 * `file_upload` stages policy-approved local files or application-provided documents into a private sandbox directory,
 * sets a referenced file input through CDP, and removes staging files on close. It remains opt-in and requires confirmation.
 *
 * Read "Running a browser toolset safely" in the SDK guide before pointing it at signed-in accounts.
 */

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Sandbox } from 'e2b';
import {
  BetaAbstractBrowserToolset20260801,
  ToolError,
  type BetaBrowserNavigateResult,
  type BetaBrowserState,
  type BetaBrowserToolsetOptions,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  type BetaURLPolicy,
} from '@anthropic-ai/sdk/helpers/beta/toolsets';
import type {
  BetaBrowserClickTarget,
  BetaBrowserCloseTabInput,
  BetaBrowserDoubleClickInput,
  BetaBrowserFindInput,
  BetaBrowserFileUploadInput,
  BetaBrowserFormInputInput,
  BetaBrowserGetPageTextInput,
  BetaBrowserHoldKeyInput,
  BetaBrowserHoverInput,
  BetaBrowserJavascriptExecInput,
  BetaBrowserKeyInput,
  BetaBrowserLeftClickDragInput,
  BetaBrowserLeftClickInput,
  BetaBrowserLeftMouseDownInput,
  BetaBrowserLeftMouseUpInput,
  BetaBrowserMiddleClickInput,
  BetaBrowserMouseMoveInput,
  BetaBrowserNavigateInput,
  BetaBrowserReadConsoleInput,
  BetaBrowserReadNetworkInput,
  BetaBrowserReadPageInput,
  BetaBrowserRightClickInput,
  BetaBrowserScreenshotInput,
  BetaBrowserScrollInput,
  BetaBrowserScrollToInput,
  BetaBrowserStateTabEntry,
  BetaBrowserSwitchTabInput,
  BetaBrowserTripleClickInput,
  BetaBrowserTypeInput,
  BetaBrowserWaitInput,
  BetaBrowserZoomInput,
} from '@anthropic-ai/sdk/resources/beta';

import { CdpClient, type CdpParams } from './cdp.ts';
import * as Input from './input.ts';
import {
  findExpr,
  fileInputExpr,
  fileInputValidationArguments,
  fileInputValidationFunction,
  ReferenceAllocator,
  runtimeSource,
  formInputExpr,
  pageTextExpr,
  readPageExpr,
  resolvePointExpr,
  scrollToExpr,
  runtimeResult,
} from './page-scripts.ts';
import { LOCAL_URL_PATTERNS, localRefusal, refuseScheme, withDefaultScheme } from './policy.ts';
import { BrowserInitializationError, resolveDisplay, startBrowserSandbox, stopChrome } from './sandbox.ts';
import { checkScreen } from './screen.ts';
import { prepareUploads, type UploadDocuments } from './uploads.ts';

type Ctx = BetaToolsetCallContext;
type StateChange = NonNullable<BetaBrowserState['state_changes']>[number];
type Viewport = { width: number; height: number };

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
/** What Fetch pauses: every document, and any request to a local address (checked in `#onRequestPaused`). */
const FETCH_PATTERNS = [
  { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
  ...LOCAL_URL_PATTERNS.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })),
];
/** Non-page targets whose requests the driver intercepts; any other (a dedicated worker) is let go. */
const GUARDED_TYPES: ReadonlySet<string> = new Set(['iframe', 'page', 'service_worker', 'shared_worker']);
/** The isolated world the page scripts run in, one per document. */
const WORLD = '__e2b_browser_toolset'; // prefix; each toolset instance adds its own suffix
const MAX_TABS = 100; // the API's limit on a browser_state inventory
const SETTLE_MS = 100; // after an input action, let the page react before the next call reads it
const NAV_QUIET_MS = 150; // after a click or key with no navigation requested by then, the action is done
const NAV_START_WINDOW_MS = 500; // once one was requested, how long it may take to start
const ACTION_LOAD_CAP_MS = 10_000; // then how long to wait for the new document's DOMContentLoaded
const NAV_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const SCRIPT_TIMEOUT_MS = 30_000;
const BUFFER_MAX = 100; // console and network entries kept per tab
const LINE_MAX = 1_000;
const PAGE_TEXT_MAX = 30_000; // about 8k tokens; find and read_page reach the rest
const SCRIPT_RESULT_MAX = 50_000;

/**
 * The SDK's toolset options (`urlPolicy`, `configs`, `confirm` and the rest), passed on unchanged, plus the sandbox
 * options. `sandbox` attaches to your sandbox instead of creating one; `close()` then leaves it running.
 */
export type E2BBrowserOptions = Omit<BetaBrowserToolsetOptions, 'browserState'> & {
  /** CSS viewport, also the screenshot size in pixels. Default 1280x800. */
  viewport?: Viewport | undefined;
  /** Diagnostics that must stay out of model-facing text (Chrome's log on a failed start). */
  debug?: ((line: string) => void) | undefined;
  /**
   * Hide Chrome (`true`) or show it on the sandbox's screen (`false`). Default: shown on an `@e2b/desktop` sandbox, so
   * it appears in the live view; headless otherwise. Only applies when the toolset starts Chrome.
   */
  headless?: boolean | undefined;
  /** Advanced: the X display to open Chrome on (for example `:1`). Default: the desktop's own, see `headless`. */
  display?: string | undefined;
  /** Files addressed by document_ids. IDs must also pass the SDK's filePolicy before they are looked up. */
  uploadDocuments?: UploadDocuments | undefined;
} & (CreateSandbox | AttachSandbox);

/** Without `sandbox`, the toolset creates one with these settings and owns it: `close()` kills it. */
interface CreateSandbox {
  sandbox?: undefined;
  /** E2B API key. Defaults to `E2B_API_KEY`. */
  apiKey?: string | undefined;
  /** Template with `google-chrome`. Default `desktop`. */
  template?: string | undefined;
  /** Sandbox egress allowlist. Given, everything else is denied. */
  allowOut?: string[] | undefined;
  /** Sandbox lifetime in ms. Default 10 minutes. */
  timeoutMs?: number | undefined;
  /** Sandbox metadata. */
  metadata?: Record<string, string> | undefined;
}

/**
 * With `sandbox`, the toolset attaches to yours and `close()` leaves it running. Its settings are fixed when you
 * create it, so the create-only options are refused here.
 */
interface AttachSandbox {
  /** A sandbox to attach to (created with `network.allowPublicTraffic: false`). Not killed by `close()`. */
  sandbox: Sandbox;
  apiKey?: undefined;
  template?: undefined;
  allowOut?: undefined;
  timeoutMs?: undefined;
  metadata?: undefined;
}

/** One entry of a tab's `read_network` buffer. */
interface NetworkEntry {
  method: string;
  url: string;
  type: string;
  started: number;
  status?: number;
  mime?: string;
  error?: string;
  ms?: number;
}

/** One open page target, as the driver tracks it. */
interface Tab {
  readonly id: string;
  readonly targetId: string;
  readonly sessionId: string;
  /** The main frame's id: the target id for a page, confirmed from the frame tree during setup. */
  frameId: string;
  url: string;
  title: string;
  /** Settles when per-tab setup is done; rejects if it failed (the tab is then closed). */
  ready: Promise<void>;
  /** For picking the tab to activate when the active one closes. */
  lastActive: number;
  /** The isolated world's context, cached only after runtime installation succeeds. */
  worldId: number | undefined;
  /** Invalidates an installation if its document/context changes while CDP replies are pending. */
  worldGeneration: number;
  /** Bumped when the main frame starts loading or navigates: how an action detects that it started a navigation. */
  navSeq: number;
  /** Main frame between frameStartedLoading and DOMContentLoaded (or frameStoppedLoading). */
  loading: boolean;
  /** Loader ids whose document reached DOMContentLoaded (recent ones). */
  loadedLoaders: Set<string>;
  /** Main-document HTTP status by loader id (recent ones). */
  documentStatus: Map<string, number>;
  /** The loader of the main-frame document committed last. */
  lastLoader: string | undefined;
  /** Renderer-requested main-frame navigations (a link, a form, `location`): how a click knows to wait. */
  navRequests: number;
  /** The main-frame document request in flight, and its net error if it failed. */
  docRequestId: string | undefined;
  docError: string | undefined;
  /** Set while the tab shows Chrome's error page: the net error, so browser_state does not pass it off as a page. */
  loadError: string | undefined;
  /** Mouse buttons held since left_mouse_down, for mouse_move during a manual drag. */
  buttons: number;
  /** Where the pointer is while a button is held, so close() can release it there. */
  point: Input.Point;
  console: string[];
  network: NetworkEntry[];
  requests: Map<string, NetworkEntry>;
}

/** The fields of a CDP RemoteObject the driver reads. */
interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface ExceptionDetails {
  text?: string;
  exception?: RemoteObject;
}

interface EvaluateResult {
  result?: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/** `text` cut to `max` characters, with a note saying how much was dropped. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`;
}

/** Text on one line, cut to `max`: for page-supplied values in buffers and error lines. */
function line(text: string, max = LINE_MAX): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length <= max ? folded : `${folded.slice(0, max)}…`;
}

function exceptionText(details: ExceptionDetails): string {
  return line(details.exception?.description ?? details.text ?? 'unknown error', 500);
}

/** A console argument as a person would read it in DevTools. */
function describe(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value);
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  return arg.unserializableValue ?? arg.description ?? arg.type;
}

/** Keep a bounded insertion-ordered set or map from growing without limit over a long session. */
function trim(collection: Set<string> | Map<string, unknown>, max = 50): void {
  for (const key of collection.keys()) {
    if (collection.size <= max) break;
    collection.delete(key);
  }
}

async function staging<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('file_upload: could not stage the files in the sandbox; retry, or start a new browser session');
  }
}

function checkDuration(value: unknown, max: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= max))
    throw new ToolError(`duration: must be between 0 and ${max} seconds`);
  return value;
}

function checkRef(ref: unknown): string {
  if (typeof ref !== 'string' || !/^ref_\d{1,16}$/.test(ref))
    throw new ToolError('ref: expected an element reference like "ref_7" from read_page or find');
  return ref;
}

function checkText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ToolError(`${field}: expected a string`);
  return value;
}

/** A required `tab_id` (close_tab, switch_tab): an empty one must not fall back to the active tab. */
function checkTabId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new ToolError('tab_id: name the tab, like "tab_2" (see list_tabs)');
  return value;
}

/** Net errors a denied egress destination shows up as. */
const EGRESS_ERRORS =
  /^net::ERR_(CONNECTION_(CLOSED|REFUSED|RESET|FAILED|TIMED_OUT)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT)$/;

/** A net error with what it likely means. Chrome's `errorText` is a net error name, no address. */
function netError(errorText: string): string {
  if (errorText === 'net::ERR_BLOCKED_BY_CLIENT') return 'the URL policy refused the page or one of its redirects';
  const name = line(errorText, 100);
  return EGRESS_ERRORS.test(errorText) ? `${name}; the host may be outside the sandbox egress allowlist` : name;
}

/** A model-facing message for a failed `Page.navigate`. */
function navigateError(errorText: string): string {
  if (errorText === 'net::ERR_ABORTED')
    return 'navigate failed: the server sent no page to show (for example HTTP 204), or the load was cancelled; the tab stayed where it was.';
  return `navigate failed: ${netError(errorText)}.`;
}

/**
 * The browser toolset driving headless Chrome in an E2B sandbox. Build it with `E2BBrowserToolset.create`, pass it in
 * `tools`, and release it with `close()` (in a `finally`), which kills the sandbox it created.
 */
export class E2BBrowserToolset extends BetaAbstractBrowserToolset20260801 {
  readonly #urlPolicy: BetaURLPolicy | undefined;
  readonly #viewport: Viewport;
  #sandbox: Sandbox | undefined;
  #ownsSandbox = false;
  #launchedChrome = false;
  /** The session directory of the Chrome this toolset started, to stop it when the connection is gone. */
  #sessionDir = '';
  #cdp: CdpClient | undefined;
  readonly #tabs = new Map<string, Tab>(); // by tab id, in the order the tabs opened
  #activeId: string | undefined;
  /**
   * The active tab of the last browser_state the model saw. A call without `tab_id` goes there, so a tab a page
   * opened between calls cannot take the call (or the approval given for another tab); the next report shows it.
   */
  #reportedActiveId: string | undefined;
  /** Reserve reference blocks before transport so lost responses cannot cause cross-tab aliasing. */
  readonly #refs = new ReferenceAllocator();
  /** Intercepted non-tab targets (iframes, workers) by session id, with the tab they belong to (if any). */
  readonly #guarded = new Map<string, Tab | undefined>();
  #downloadDir = '';
  #uploadDocuments: UploadDocuments = new Map();
  readonly #uploadDirectories = new Set<string>();
  #uploadBytes = 0;
  #nextTab = 1;
  #activations = 0;
  #nextDownload = 1;
  /** Set once the initial tabs are registered: a tab attached after that opened during a call. */
  #started = false;
  #changes: StateChange[] = [];
  readonly #downloads = new Map<string, { id: string; url: string }>(); // by Chrome's download guid
  #closing: Promise<void> | undefined;
  /** Set while `detach()` lets go of Chrome: targets that attach now are let run without interception. */
  #detaching = false;
  /**
   * This instance's isolated world. A fresh name per instance: after `detach()` the page keeps the old world and
   * its refs, and a new toolset reusing that name would find them and hand out refs that already exist.
   */
  readonly #world = `${WORLD}_${randomBytes(12).toString('hex')}`;
  /** URL checks still running for paused requests; `detach()` waits for them before it disables interception. */
  readonly #pausedChecks = new Set<Promise<void>>();

  /**
   * Create the sandbox (unless `options.sandbox` is given), start Chrome and connect. The toolset options are checked
   * first, so a configuration mistake throws before any sandbox exists; a failure after that closes everything.
   */
  static async create(options: E2BBrowserOptions = {}): Promise<E2BBrowserToolset> {
    const {
      apiKey,
      template,
      sandbox,
      allowOut,
      timeoutMs,
      viewport,
      metadata,
      debug,
      headless,
      display,
      uploadDocuments,
      ...toolsetOptions
    } = options;
    const screen = resolveDisplay(sandbox, headless, display); // throws before anything starts
    const size = viewport ?? DEFAULT_VIEWPORT;
    checkScreen('viewport', size.width, size.height);

    const browser = new E2BBrowserToolset(toolsetOptions, size);
    browser.#uploadDocuments = new Map(uploadDocuments);
    try {
      const started = await startBrowserSandbox({
        apiKey,
        template,
        sandbox,
        allowOut,
        timeoutMs,
        viewport: size,
        metadata,
        debug,
        display: screen,
      });
      browser.#sandbox = started.sandbox;
      browser.#ownsSandbox = sandbox === undefined;
      browser.#launchedChrome = started.launchedChrome;
      browser.#downloadDir = started.downloadDir;
      browser.#sessionDir = started.sessionDir;
      browser.#cdp = await CdpClient.connect(started.wsUrl, started.headers);
      browser.#cdp.onClose(() => void browser.#onConnectionLost());
      await browser.#setUp();
    } catch (error) {
      const cleaned = await browser.close().then(
        () => true,
        () => false,
      );
      if (!cleaned) throw new BrowserInitializationError(browser);
      throw error;
    }
    return browser;
  }

  private constructor(options: Omit<BetaBrowserToolsetOptions, 'browserState'>, viewport: Viewport) {
    super({ ...options, browserState: () => this.#browserState() });
    this.#urlPolicy = options.urlPolicy;
    this.#viewport = viewport;
  }

  /** The E2B sandbox the browser runs in: for its files, `getHost` for other ports, and so on. */
  get sandbox(): Sandbox {
    if (this.#sandbox === undefined) throw new Error('The browser sandbox is not started');
    return this.#sandbox;
  }

  /**
   * Close the browser, then kill the sandbox if `create` made it. It waits for calls in flight first, and is safe to
   * call more than once. If part of the cleanup fails, it throws, and calling it again retries what is left.
   */
  override close(): Promise<void> {
    this.#closing ??= this.#shutDown().catch((error: unknown) => {
      this.#closing = undefined; // let the next close() retry what is left
      throw error;
    });
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    await super.close();
    const failures: string[] = [];
    const cdp = this.#cdp;
    // A button held since left_mouse_down would stay held for whoever uses this Chrome next. Release it; if that
    // fails in a Chrome we did not start, keep the connection so the next close() can try again.
    if (cdp !== undefined && !cdp.closed)
      for (const tab of this.#tabs.values())
        if (tab.buttons !== 0)
          await Input.mouseUp((m, p) => cdp.send(m, p, tab.sessionId), tab.point).then(
            () => (tab.buttons = 0),
            () => undefined,
          );
    const borrowed = !this.#launchedChrome && !this.#ownsSandbox;
    const held = borrowed && cdp !== undefined && !cdp.closed && [...this.#tabs.values()].some((t) => t.buttons !== 0);
    if (held) failures.push('release the mouse button held in the attached browser');
    else this.#cdp = undefined;
    if (cdp !== undefined && !held) {
      // Chrome already running in an attached sandbox is not ours to stop
      if (this.#launchedChrome && !cdp.closed)
        await cdp.send('Browser.close', {}, undefined, 5_000).then(
          () => (this.#launchedChrome = false),
          () => undefined,
        );
      await cdp.close().catch(() => undefined);
    }
    // The Chrome we started in the caller's sandbox, still running: the connection never came up, was lost, or
    // Browser.close failed. In a sandbox we created, killing the sandbox stops it.
    if (this.#launchedChrome && !this.#ownsSandbox && this.#sandbox !== undefined) {
      await stopChrome(this.#sandbox, this.#sessionDir).then(
        () => (this.#launchedChrome = false),
        () => failures.push('stop the browser it started in the attached sandbox'),
      );
    }
    if (this.#sandbox !== undefined && !this.#ownsSandbox) {
      for (const directory of [...this.#uploadDirectories]) {
        await this.#sandbox.files.remove(directory).then(
          () => this.#uploadDirectories.delete(directory), // a failed one stays listed for the next close()
          () => undefined,
        );
      }
      if (this.#uploadDirectories.size > 0) failures.push('remove upload staging files from the attached sandbox');
    }
    if (this.#ownsSandbox && this.#sandbox !== undefined) {
      const killed = await this.#sandbox.kill().then(
        () => true,
        () => false,
      );
      if (killed) {
        this.#ownsSandbox = false;
        this.#launchedChrome = false;
        this.#uploadDirectories.clear(); // killing the owned sandbox removes its files as well
      } else failures.push('kill the browser sandbox');
    }
    if (failures.length > 0) throw new Error(`Could not ${failures.join(', or ')}; call close() again to retry`);
  }

  /**
   * Let go of Chrome cleanly and leave it running, with its tabs, pages and cookies, so another toolset can attach to
   * it later. Call it before you pause or fork the sandbox: a snapshot taken while this toolset is connected keeps
   * Chrome waiting for this toolset to approve every page request, so after resume (or in a fork) every navigation
   * hangs. Afterwards this instance is closed; attach a new one with `create({ sandbox })`, and give the model a fresh
   * view (refs and tab ids from this instance do not carry over).
   *
   * Only for a sandbox you passed to `create`: a sandbox the toolset created would be left with no owner, so use
   * `close()` there. Refused while files are staged for upload or a download is in progress.
   *
   * The page is not frozen: until the snapshot, its scripts keep running and its requests are checked only by the
   * sandbox's egress rules. Detach when the agent is idle, and snapshot right after.
   */
  detach(): Promise<void> {
    if (this.#closing !== undefined) return Promise.reject(new Error('detach: the toolset is already closed'));
    if (this.#ownsSandbox)
      return Promise.reject(
        new Error('detach: this toolset created its sandbox, so nothing would own it afterwards; use close()'),
      );
    if (this.#uploadDirectories.size > 0)
      return Promise.reject(new Error('detach: files are staged for upload; submit the form or close() first'));
    if (this.#downloads.size > 0) return Promise.reject(new Error('detach: a download is still in progress'));
    this.#closing = this.#release().catch((error: unknown) => {
      // a failed detach is not a handoff: close() can still clean up, Chrome included if this toolset started it
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }

  async #release(): Promise<void> {
    await super.close(); // waits for calls in flight; later calls are refused
    if (this.#uploadDirectories.size > 0)
      throw new Error('detach: files were staged for upload meanwhile; call close() to clean up');
    if (this.#downloads.size > 0) throw new Error('detach: a download started meanwhile; call close() to clean up');
    this.#detaching = true;
    const cdp = this.#cdp; // kept on this.#cdp until the socket closes: late targets and paused requests use it
    if (cdp === undefined || cdp.closed)
      throw new Error('detach failed: the browser connection was already lost; call close() to clean up');
    const failures: string[] = [];
    const step = (what: string, sending: Promise<unknown>) =>
      sending.catch((error: unknown) => {
        if (!/not found|No session|No target/i.test(String(error))) failures.push(`${what}: ${String(error)}`);
      });

    // a button held since left_mouse_down would stay held for the next owner
    for (const tab of this.#tabs.values())
      if (tab.buttons !== 0) {
        await step(
          'release the mouse',
          Input.mouseUp((m, p) => cdp.send(m, p, tab.sessionId), tab.point),
        );
        tab.buttons = 0;
      }
    // answer the requests whose URL check is still running, so none is left paused
    await Promise.race([Promise.allSettled([...this.#pausedChecks]), sleep(5_000)]);

    const sessions = [...[...this.#tabs.values()].map((tab) => tab.sessionId), ...this.#guarded.keys()];
    // Interception first: switching auto-attach off detaches child sessions, and with them our way to reach them.
    await Promise.all(sessions.map((s) => step('stop interception', cdp.send('Fetch.disable', {}, s))));
    await Promise.all(
      sessions.map((s) =>
        step(
          'stop auto-attach',
          cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, s),
        ),
      ),
    );
    await step(
      'stop auto-attach',
      cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }),
    );
    await Promise.all(sessions.map((s) => step('detach', cdp.send('Target.detachFromTarget', { sessionId: s }))));
    // Wait for the socket to close: a snapshot taken before Chrome sees it go would still hold our sessions.
    await cdp.close().catch((error: unknown) => failures.push(`disconnect: ${String(error)}`));
    this.#cdp = undefined;

    if (this.#sandbox !== undefined)
      for (const directory of this.#uploadDirectories)
        await this.#sandbox.files.remove(directory).catch(() => undefined);
    this.#uploadDirectories.clear();
    this.#tabs.clear();
    this.#guarded.clear();
    if (failures.length > 0)
      throw new Error(
        `detach incomplete, Chrome may still hold requests (${failures.join('; ')}); call close() to clean up`,
      );
    this.#launchedChrome = false; // handed off: Chrome is left for whoever attaches next
  }

  /** The connection dropped while in use: stop the Chrome this toolset started, so it does not run unguarded. */
  async #onConnectionLost(): Promise<void> {
    if (this.#closing !== undefined || this.#detaching || !this.#launchedChrome || this.#sandbox === undefined) return;
    await stopChrome(this.#sandbox, this.#sessionDir).then(
      () => (this.#launchedChrome = false),
      () => undefined, // close() retries
    );
  }

  // --- setup and events ------------------------------------------------------------------------------------

  /** Subscribe to the events the driver tracks, configure the browser, and register the tabs already open. */
  async #setUp(): Promise<void> {
    const cdp = this.#client();
    this.#listen(cdp);
    await Promise.all([
      cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: this.#downloadDir,
        eventsEnabled: true,
      }),
      // a "wants to show notifications" bubble would cover the page, and no member can answer it
      cdp
        .send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied' })
        .catch(() => undefined),
      cdp.send('Target.setDiscoverTargets', { discover: true }),
    ]);
    // Every page attaches with its own flat session. A new one (a popup) waits for the debugger, so its Fetch
    // interception is on before its first request.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    for (const info of targetInfos) {
      if (info.type === 'page' && this.#tabByTarget(info.targetId) === undefined)
        await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => undefined);
    }
    if (this.#tabs.size === 0) await cdp.send('Target.createTarget', { url: 'about:blank' });
    const first = await this.#waitForTab(() => this.#tabs.values().next().value);
    await Promise.all([...this.#tabs.values()].map((tab) => tab.ready.catch(() => undefined)));
    await this.#activate(this.#tabs.has(first.id) ? first : (this.#mostRecent() ?? first));
    this.#started = true;
    this.#changes = []; // the tabs open at start are not news
  }

  #listen(cdp: CdpClient): void {
    cdp.on(
      'Target.attachedToTarget',
      (p: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }, parent) =>
        void this.#onAttached(p.sessionId, p.targetInfo, p.waitingForDebugger, parent).catch(() => undefined),
    );
    cdp.on('Target.detachedFromTarget', (p: { sessionId: string }) => {
      this.#guarded.delete(p.sessionId);
      this.#remove(this.#tabBySession(p.sessionId));
    });
    cdp.on('Target.targetDestroyed', (p: { targetId: string }) => this.#remove(this.#tabByTarget(p.targetId)));
    cdp.on('Target.targetInfoChanged', (p: { targetInfo: TargetInfo }) => {
      const tab = this.#tabByTarget(p.targetInfo.targetId);
      if (tab !== undefined) Object.assign(tab, { url: p.targetInfo.url, title: p.targetInfo.title });
    });

    // Dialogs block the page until answered, and no member answers one, so each is answered at once. An alert,
    // confirm or prompt is dismissed (prompt returns null) and reported. A beforeunload ("leave this page?") is
    // accepted and not reported: refusing it would strand the model's own navigate, back or close_tab, and it
    // carries no page text, only the fact that the page had unsaved state.
    cdp.on('Page.javascriptDialogOpening', (p: { type: string; message: string }, sessionId) => {
      const accept = p.type === 'beforeunload';
      void cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => undefined);
      if (!accept) this.#changes.push({ type: 'dialog_dismissed', kind: p.type, message: p.message });
    });

    cdp.on('Page.frameStartedLoading', (p: { frameId: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab?.frameId !== p.frameId) return;
      tab.loading = true;
      tab.navSeq++;
    });
    cdp.on('Page.frameStoppedLoading', (p: { frameId: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab?.frameId === p.frameId) tab.loading = false;
    });
    cdp.on(
      'Page.frameNavigated',
      (
        p: { frame: { id: string; parentId?: string; url: string; loaderId: string; unreachableUrl?: string } },
        sessionId,
      ) => {
        const tab = this.#tabBySession(sessionId);
        if (tab === undefined || p.frame.parentId !== undefined) return;
        tab.navSeq++;
        tab.url = p.frame.url;
        tab.lastLoader = p.frame.loaderId;
        tab.worldId = undefined;
        tab.worldGeneration++;
        tab.loadError = p.frame.unreachableUrl !== undefined ? (tab.docError ?? 'net::ERR_FAILED') : undefined;
      },
    );
    cdp.on('Page.frameRequestedNavigation', (p: { frameId: string; disposition: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab?.frameId === p.frameId && p.disposition === 'currentTab') tab.navRequests++;
    });
    cdp.on('Page.navigatedWithinDocument', (p: { frameId: string; url: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab?.frameId !== p.frameId) return;
      tab.navSeq++;
      tab.url = p.url;
    });
    cdp.on('Page.lifecycleEvent', (p: { frameId: string; loaderId: string; name: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab?.frameId !== p.frameId || p.name !== 'DOMContentLoaded') return;
      tab.loadedLoaders.add(p.loaderId);
      trim(tab.loadedLoaders);
      tab.loading = false;
    });

    cdp.on('Runtime.executionContextDestroyed', (p: { executionContextId: number }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab !== undefined && (tab.worldId === undefined || tab.worldId === p.executionContextId)) {
        tab.worldId = undefined;
        tab.worldGeneration++;
      }
    });
    cdp.on('Runtime.executionContextsCleared', (_p: unknown, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab !== undefined) {
        tab.worldId = undefined;
        tab.worldGeneration++;
      }
    });

    cdp.on('Runtime.consoleAPICalled', (p: { type: string; args: RemoteObject[] }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab !== undefined) this.#buffer(tab.console, line(`[${p.type}] ${p.args.map(describe).join(' ')}`));
    });
    cdp.on('Runtime.exceptionThrown', (p: { exceptionDetails: ExceptionDetails }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      if (tab !== undefined) this.#buffer(tab.console, `[exception] ${exceptionText(p.exceptionDetails)}`);
    });

    cdp.on(
      'Network.requestWillBeSent',
      (
        p: {
          requestId: string;
          request: { url: string; method: string };
          type?: string;
          frameId?: string;
          timestamp: number;
          redirectResponse?: { status: number };
        },
        sessionId,
      ) => {
        const tab = this.#tabBySession(sessionId);
        if (tab === undefined) return;
        if (p.type === 'Document' && p.frameId === tab.frameId && tab.docRequestId !== p.requestId) {
          tab.docRequestId = p.requestId;
          tab.docError = undefined;
        }
        const previous = tab.requests.get(p.requestId);
        if (previous !== undefined && p.redirectResponse !== undefined) previous.status = p.redirectResponse.status;
        const { url } = p.request;
        const entry: NetworkEntry = {
          method: p.request.method,
          // a data: URL is its whole payload; its type and size say enough
          url: url.startsWith('data:')
            ? `${line(url.slice(0, url.search(/[;,]/)), 100)} (${url.length} characters)`
            : line(url, 500),
          type: p.type ?? 'Other',
          started: p.timestamp,
        };
        tab.requests.set(p.requestId, entry);
        this.#buffer(tab.network, entry);
        trim(tab.requests, BUFFER_MAX);
      },
    );
    cdp.on(
      'Network.responseReceived',
      (
        p: {
          requestId: string;
          type: string;
          frameId?: string;
          loaderId: string;
          response: { status: number; mimeType: string };
        },
        sessionId,
      ) => {
        const tab = this.#tabBySession(sessionId);
        if (tab === undefined) return;
        const entry = tab.requests.get(p.requestId);
        if (entry !== undefined) Object.assign(entry, { status: p.response.status, mime: p.response.mimeType });
        if (p.type === 'Document' && p.frameId === tab.frameId) {
          tab.documentStatus.set(p.loaderId, p.response.status);
          trim(tab.documentStatus);
        }
      },
    );
    cdp.on('Network.loadingFinished', (p: { requestId: string; timestamp: number }, sessionId) => {
      const entry = this.#tabBySession(sessionId)?.requests.get(p.requestId);
      if (entry !== undefined) entry.ms = Math.round((p.timestamp - entry.started) * 1000);
    });
    cdp.on('Network.loadingFailed', (p: { requestId: string; errorText: string }, sessionId) => {
      const tab = this.#tabBySession(sessionId);
      const entry = tab?.requests.get(p.requestId);
      if (entry !== undefined) entry.error = line(p.errorText, 100);
      if (tab !== undefined && tab.docRequestId === p.requestId) tab.docError = p.errorText;
    });

    cdp.on(
      'Fetch.requestPaused',
      (p: { requestId: string; request: { url: string }; resourceType: string }, sessionId) => {
        const check = this.#onRequestPaused(p.requestId, p.request.url, p.resourceType, sessionId);
        this.#pausedChecks.add(check);
        void check.finally(() => this.#pausedChecks.delete(check));
      },
    );

    cdp.on('Browser.downloadWillBegin', (p: { guid: string; url: string }) => {
      const id = `download_${this.#nextDownload++}`;
      this.#downloads.set(p.guid, { id, url: p.url });
      this.#changes.push({ type: 'download_started', download_id: id, url: p.url });
    });
    cdp.on('Browser.downloadProgress', (p: { guid: string; state: string; receivedBytes: number }) => {
      const download = this.#downloads.get(p.guid);
      if (download === undefined || p.state === 'inProgress') return;
      this.#downloads.delete(p.guid);
      const { id: download_id, url } = download;
      if (p.state === 'completed')
        // the path is shown to the model only if a filePolicy says so; by default the SDK strips it
        this.#changes.push({
          type: 'download_completed',
          download_id,
          url,
          path: `${this.#downloadDir}/${p.guid}`,
          size_bytes: p.receivedBytes,
        });
      else
        this.#changes.push({
          type: 'download_failed',
          download_id,
          url,
          error: 'The download failed or was cancelled.',
        });
    });
  }

  /**
   * A target attached. A top-level page becomes a tab (active, with a `tab_opened` change, once the initial tabs are
   * registered). A cross-site iframe or a service worker is intercepted like a tab but is not one; anything else (a
   * dedicated worker) is let go. `parent` is the session it attached under (undefined: the browser).
   */
  async #onAttached(sessionId: string, info: TargetInfo, waiting: boolean, parent: string | undefined): Promise<void> {
    const cdp = this.#client();
    if (this.#detaching) {
      // letting go: the target runs as it would with no toolset attached
      if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      return;
    }
    const topLevelPage = info.type === 'page' && parent === undefined;
    if (!topLevelPage && GUARDED_TYPES.has(info.type)) return this.#guard(sessionId, info, waiting, parent);
    if (!topLevelPage || this.#tabByTarget(info.targetId) !== undefined || this.#tabs.size >= MAX_TABS) {
      if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      // a page past the tab limit is closed rather than left running unseen
      if (info.type === 'page' && this.#tabByTarget(info.targetId) === undefined)
        await cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
      return;
    }
    const tab: Tab = {
      id: `tab_${this.#nextTab++}`,
      targetId: info.targetId,
      sessionId,
      frameId: info.targetId,
      url: info.url,
      title: info.title,
      ready: Promise.resolve(),
      lastActive: 0,
      worldId: undefined,
      worldGeneration: 0,
      navSeq: 0,
      loading: false,
      loadedLoaders: new Set(),
      documentStatus: new Map(),
      lastLoader: undefined,
      navRequests: 0,
      docRequestId: undefined,
      docError: undefined,
      loadError: undefined,
      buttons: 0,
      point: { x: 0, y: 0 },
      console: [],
      network: [],
      requests: new Map(),
    };
    this.#tabs.set(tab.id, tab);
    if (this.#started) {
      // like a real browser, a tab a page opens takes focus, so the model's next call lands where it went
      this.#changes.push({ type: 'tab_opened', tab_id: tab.id });
      this.#activeId = tab.id;
      tab.lastActive = ++this.#activations;
    }
    tab.ready = this.#prepare(tab, waiting);
    await tab.ready;
    if (this.#activeId === tab.id) await this.#send(tab, 'Page.bringToFront').catch(() => undefined);
  }

  /**
   * Per-tab setup, then let a paused target run. A tab that cannot be set up (its interception above all) is closed:
   * driving it would skip the URL policy.
   */
  async #prepare(tab: Tab, waiting: boolean): Promise<void> {
    const { width, height } = this.#viewport;
    const steps: Promise<unknown>[] = [
      this.#send(tab, 'Page.enable'),
      this.#send(tab, 'Runtime.enable'),
      this.#send(tab, 'Network.enable'),
      this.#send(tab, 'Page.setLifecycleEventsEnabled', { enabled: true }),
      // screenshot pixels are CSS pixels, the frame click coordinates use
      this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      this.#send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
      this.#send<{ frameTree: { frame: { id: string } } }>(tab, 'Page.getFrameTree').then((r) => {
        tab.frameId = r.frameTree.frame.id;
      }),
      // documents and local addresses only: other subresources are the egress policy's job
      this.#send(tab, 'Fetch.enable', { patterns: FETCH_PATTERNS }),
      // a service worker could answer a navigation with another host's content, past the interception
      this.#send(tab, 'Network.setBypassServiceWorker', { bypass: true }),
      // cross-site iframes run in their own target; attach them (paused) so their requests are intercepted too
      this.#send(tab, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
    ];
    // Resume in the same batch: a paused new renderer answers some of the commands above only once it runs, and
    // CDP handles one session's commands in order, so interception is on before the page's first request.
    if (waiting) steps.push(this.#send(tab, 'Runtime.runIfWaitingForDebugger'));
    try {
      await Promise.all(steps);
    } catch (error) {
      await this.#client()
        .send('Target.closeTarget', { targetId: tab.targetId })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Intercept a non-tab target (a cross-site iframe, a service worker) the way a tab is, then let it run. Its own
   * iframes attach under it in turn. If interception cannot be set up, the target is closed, failing that the tab it
   * belongs to: running it would skip the URL policy.
   */
  async #guard(sessionId: string, info: TargetInfo, waiting: boolean, parent: string | undefined): Promise<void> {
    const type = info.type;
    const cdp = this.#client();
    const owner = parent === undefined ? undefined : (this.#tabBySession(parent) ?? this.#guarded.get(parent));
    this.#guarded.set(sessionId, owner);
    const steps: Promise<unknown>[] = [cdp.send('Fetch.enable', { patterns: FETCH_PATTERNS }, sessionId)];
    if (type === 'iframe' || type === 'page') {
      steps.push(cdp.send('Network.enable', {}, sessionId));
      steps.push(cdp.send('Network.setBypassServiceWorker', { bypass: true }, sessionId));
      steps.push(
        cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId),
      );
    }
    try {
      // Acknowledged while the target is still paused, so none of its code runs before interception is on.
      await Promise.all(steps);
    } catch {
      this.#guarded.delete(sessionId);
      // not closed: in a visible Chrome that closes the whole tab
      if (waiting) return;
      const closed = await cdp
        .send<{ success?: boolean }>('Target.closeTarget', { targetId: info.targetId })
        .then((r) => r.success !== false)
        .catch(() => false);
      if (!closed && owner !== undefined)
        await cdp.send('Target.closeTarget', { targetId: owner.targetId }).catch(() => undefined);
      return;
    }
    if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
  }

  async #checkDestination(tab: Tab, url: string): Promise<void> {
    let allowed = false;
    try {
      refuseScheme(url);
      if (localRefusal(url) === 'refused') throw new ToolError('a reserved local port');
      allowed = (await this.#urlPolicy?.({ tabId: tab.id }, url)) === undefined; // a predicate-style policy fails closed
    } catch {
      allowed = false; // any throw refuses, as for intercepted requests
    }
    if (!allowed) {
      this.#changes.push({ type: 'navigation_refused' });
      throw new ToolError('That page is not allowed by the URL policy; the tab stayed where it was.');
    }
  }

  /**
   * A paused request (a document, or anything to a local address): continue it if the scheme check, the local-port
   * refusal and the URL policy pass, else fail it. A refused document is reported as `navigation_refused`.
   */
  async #onRequestPaused(
    requestId: string,
    url: string,
    resourceType: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const cdp = this.#cdp;
    if (cdp === undefined) return;
    const document = resourceType === 'Document';
    let allowed = true;
    try {
      const local = localRefusal(url);
      if (document || local !== 'public') {
        refuseScheme(url);
        if (local === 'refused') throw new ToolError('a reserved local port');
        const tabId = (
          this.#tabBySession(sessionId) ?? (sessionId !== undefined ? this.#guarded.get(sessionId) : undefined)
        )?.id;
        const returned: unknown = await this.#urlPolicy?.({ tabId }, url);
        allowed = returned === undefined; // a policy written as a predicate fails closed
      }
    } catch {
      allowed = false; // any throw refuses: a ToolError is the policy's refusal, anything else fails closed
    }
    if (allowed) {
      await cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => undefined);
    } else {
      if (document) this.#changes.push({ type: 'navigation_refused' });
      await cdp
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
        .catch(() => undefined);
    }
  }

  /** Drop a closed tab. If it was active, the most recently active tab left takes over. */
  #remove(tab: Tab | undefined): void {
    if (tab === undefined || !this.#tabs.delete(tab.id)) return;
    if (this.#activeId !== tab.id) return;
    this.#activeId = undefined;
    const next = this.#mostRecent();
    if (next !== undefined) void this.#activate(next);
  }

  // --- helpers ---------------------------------------------------------------------------------------------

  #client(): CdpClient {
    if (this.#cdp === undefined || this.#cdp.closed) throw new ToolError('The browser is closed.');
    return this.#cdp;
  }

  #send<T = Record<string, unknown>>(tab: Tab, method: string, params?: CdpParams, timeoutMs?: number): Promise<T> {
    try {
      return this.#client().send<T>(method, params, tab.sessionId, timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The per-tab send function the input helpers take. */
  #sender(tab: Tab): Input.Send {
    return (method, params) => this.#send(tab, method, params);
  }

  #tabBySession(sessionId: string | undefined): Tab | undefined {
    if (sessionId === undefined) return undefined;
    for (const tab of this.#tabs.values()) if (tab.sessionId === sessionId) return tab;
    return undefined;
  }

  #tabByTarget(targetId: string): Tab | undefined {
    for (const tab of this.#tabs.values()) if (tab.targetId === targetId) return tab;
    return undefined;
  }

  #mostRecent(): Tab | undefined {
    let best: Tab | undefined;
    for (const tab of this.#tabs.values()) if (best === undefined || tab.lastActive > best.lastActive) best = tab;
    return best;
  }

  /**
   * The tab a call names (`tab_id`), else the one the last browser_state showed active (else the active tab), once
   * its setup is done.
   */
  async #tab(tabId: string | null | undefined): Promise<Tab> {
    const id = tabId || undefined;
    const defaultId =
      this.#reportedActiveId !== undefined && this.#tabs.has(this.#reportedActiveId)
        ? this.#reportedActiveId
        : this.#activeId;
    const tab = this.#tabs.get(id ?? defaultId ?? '');
    if (tab === undefined) {
      if (id !== undefined)
        throw new ToolError(`There is no tab "${line(id, 40)}". Call list_tabs to see the open tabs.`);
      throw new ToolError('No tab is open. Call new_tab to open one.');
    }
    await tab.ready.catch(() => {
      throw new ToolError('The tab closed before it was ready. Call list_tabs to see the open tabs.');
    });
    return tab;
  }

  /** Poll for a tab (registered by the attach handler) for up to 10 s, then wait for its setup. */
  async #waitForTab(find: () => Tab | undefined): Promise<Tab> {
    const deadline = Date.now() + 10_000;
    let tab = find();
    while (tab === undefined && Date.now() < deadline) {
      await sleep(20);
      tab = find();
    }
    if (tab === undefined) throw new ToolError('The tab did not open.');
    await tab.ready;
    return tab;
  }

  async #activate(tab: Tab): Promise<void> {
    this.#activeId = tab.id;
    tab.lastActive = ++this.#activations;
    await this.#send(tab, 'Page.bringToFront').catch(() => undefined);
  }

  /** A tab as browser_state lists it. A tab on Chrome's error page says so in its title, not the failed host name. */
  #entry(tab: Tab): BetaBrowserStateTabEntry {
    const title = tab.loadError !== undefined ? `Failed to load: ${netError(tab.loadError)}` : tab.title;
    return { tab_id: tab.id, title, url: tab.url, active: tab.id === this.#activeId };
  }

  #buffer<T>(buffer: T[], item: T): void {
    buffer.push(item);
    if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  }

  /**
   * Install once in the current document. A failed or invalidated installation is never cached.
   * Submitted actions are never replayed automatically.
   */
  async #runtimeWorld(tab: Tab): Promise<number> {
    if (tab.worldId !== undefined) return tab.worldId;
    const generation = tab.worldGeneration;
    const world = await this.#send<{ executionContextId: number }>(tab, 'Page.createIsolatedWorld', {
      frameId: tab.frameId,
      worldName: this.#world,
    });
    if (generation !== tab.worldGeneration) throw new ToolError('The page changed while creating its runtime');
    const installed = await this.#send<EvaluateResult>(
      tab,
      'Runtime.evaluate',
      {
        expression: runtimeSource,
        contextId: world.executionContextId,
        returnByValue: true,
      },
      SCRIPT_TIMEOUT_MS,
    );
    if (installed.exceptionDetails) throw new ToolError('The browser runtime could not be installed');
    if (generation !== tab.worldGeneration) throw new ToolError('The page changed while installing its runtime');
    tab.worldId = world.executionContextId;
    return tab.worldId;
  }

  async #run<T>(tab: Tab, expression: string): Promise<T | undefined> {
    const contextId = await this.#runtimeWorld(tab);
    const result = await this.#send<EvaluateResult>(
      tab,
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true, awaitPromise: true },
      SCRIPT_TIMEOUT_MS,
    );
    if (result.exceptionDetails) throw new ToolError(`A page script failed: ${exceptionText(result.exceptionDetails)}`);
    return result.result?.value as T | undefined;
  }

  /** Decode the shared envelope. Reference blocks were reserved before transport. */
  async #runtime<T>(tab: Tab, expression: string): Promise<T> {
    const raw = await this.#run<unknown>(tab, expression);
    let result;
    try {
      result = runtimeResult<T>(raw);
    } catch {
      throw new ToolError('The page did not return a valid runtime result');
    }
    if (!result.ok) throw new ToolError(result.error.message);
    return result.value;
  }

  /**
   * The tab's address and title as the browser reports them (the same source as `browser_state`, so an error page
   * reads as the address that failed, not `chrome-error://`), else as last seen.
   */
  async #pageInfo(tab: Tab): Promise<{ url: string; title: string }> {
    const info = await this.#client()
      .send<{ targetInfo: TargetInfo }>('Target.getTargetInfo', { targetId: tab.targetId })
      .catch(() => undefined);
    // mid-navigation the target can report an empty URL; keep the last one seen then
    if (info !== undefined && info.targetInfo.url !== '')
      Object.assign(tab, { url: info.targetInfo.url, title: info.targetInfo.title });
    return { url: tab.url, title: tab.title };
  }

  /** A coordinate target, checked to be a point inside the viewport. */
  #coordinate(target: unknown, field = 'target'): Input.Point {
    const t = target as { type?: unknown; x?: unknown; y?: unknown } | null | undefined;
    if (
      t?.type !== 'coordinate' ||
      typeof t.x !== 'number' ||
      typeof t.y !== 'number' ||
      !Number.isFinite(t.x) ||
      !Number.isFinite(t.y)
    )
      throw new ToolError(`${field}: expected {"type": "coordinate", "x": <number>, "y": <number>}`);
    const { width, height } = this.#viewport;
    if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height)
      throw new ToolError(`${field}: (${t.x}, ${t.y}) is outside the ${width}x${height} viewport.`);
    return { x: t.x, y: t.y };
  }

  /** Where to act for a click-type target: a coordinate as given, or a ref's element, checked for `action`. */
  async #point(tab: Tab, target: BetaBrowserClickTarget, action: 'click' | 'hover'): Promise<Input.Point> {
    if ((target as { type?: unknown } | undefined)?.type !== 'ref') return this.#coordinate(target);
    const { x, y } = await this.#runtime<{ x: number; y: number }>(
      tab,
      resolvePointExpr(checkRef((target as { ref?: unknown }).ref), action, this.#refs.reserve()),
    );
    if (typeof x !== 'number' || typeof y !== 'number')
      throw new ToolError('The page did not answer. Call read_page again.');
    return { x, y };
  }

  /** The tab's navigation counters before an action, for `#settle`. */
  #mark(tab: Tab): { seq: number; requests: number } {
    return { seq: tab.navSeq, requests: tab.navRequests };
  }

  /**
   * After an input action: a short settle, and for actions that can start a navigation (clicks, keys, typing), a
   * wait for the new document's DOMContentLoaded if the main frame started loading, so the next read sees it. An
   * action that asked for no navigation within `NAV_QUIET_MS` is done then.
   */
  async #settle(tab: Tab, before: { seq: number; requests: number }, watchNavigation: boolean): Promise<void> {
    await sleep(SETTLE_MS);
    if (!watchNavigation) return;
    const started = (): boolean => tab.navSeq !== before.seq || tab.loading;
    const quietBy = Date.now() + NAV_QUIET_MS - SETTLE_MS;
    const startBy = Date.now() + NAV_START_WINDOW_MS - SETTLE_MS;
    while (!started() && Date.now() < startBy && this.#tabs.has(tab.id)) {
      if (tab.navRequests === before.requests && Date.now() >= quietBy) return;
      await sleep(25);
    }
    if (started()) await this.#whileLoading(tab, ACTION_LOAD_CAP_MS);
  }

  /** Wait while the tab's main frame is loading, up to `capMs`. Returns whether it finished. */
  async #whileLoading(tab: Tab, capMs: number): Promise<boolean> {
    const deadline = Date.now() + capMs;
    while (tab.loading && Date.now() < deadline && this.#tabs.has(tab.id)) await sleep(25);
    return !tab.loading;
  }

  async #click(input: BetaBrowserLeftClickInput, button: Input.MouseButton, clickCount: number): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const modifiers = Input.parseModifiers(input.modifiers);
    const at = await this.#point(tab, input.target, 'click');
    const before = this.#mark(tab);
    await Input.click(this.#sender(tab), at, { button, clickCount, modifiers });
    await this.#settle(tab, before, true);
  }

  // --- browser state ---------------------------------------------------------------------------------------

  /**
   * The SDK's `browserState` callback: every tab (the active one marked) and the changes since the last report.
   * Titles and URLs are refreshed from `Target.getTargets` when the browser answers, else reported as last seen.
   * It never throws.
   */
  async #browserState(): Promise<BetaBrowserState> {
    try {
      const cdp = this.#cdp;
      if (cdp !== undefined && !cdp.closed) {
        const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>(
          'Target.getTargets',
          {},
          undefined,
          5_000,
        );
        const live = new Set<string>();
        for (const info of targetInfos) {
          const tab = this.#tabByTarget(info.targetId);
          if (tab === undefined) continue;
          live.add(tab.id);
          Object.assign(tab, { url: info.url, title: info.title });
        }
        for (const tab of [...this.#tabs.values()]) if (!live.has(tab.id)) this.#remove(tab);
      }
    } catch {
      // report the registry as it stands
    }
    if (this.#tabs.size > 0 && (this.#activeId === undefined || !this.#tabs.has(this.#activeId))) {
      const next = this.#mostRecent();
      if (next !== undefined) this.#activeId = next.id;
    }
    const state_changes = this.#changes.splice(0);
    const tabs = [...this.#tabs.values()].map((tab) => this.#entry(tab));
    this.#reportedActiveId = this.#activeId;
    return state_changes.length > 0 ? { tabs, state_changes } : { tabs };
  }

  // --- members: navigation and capture ---------------------------------------------------------------------

  protected override async navigate(_ctx: Ctx, input: BetaBrowserNavigateInput): Promise<BetaBrowserNavigateResult> {
    const tab = await this.#tab(input.tab_id);
    const requested = checkText(input.url, 'url');
    let loaderId: string | undefined;
    const target = withDefaultScheme(requested);
    if (requested === 'back' || requested === 'forward') {
      const history = await this.#send<{ currentIndex: number; entries: { id: number; url: string }[] }>(
        tab,
        'Page.getNavigationHistory',
      );
      const entry = history.entries[history.currentIndex + (requested === 'back' ? -1 : 1)];
      if (entry === undefined) throw new ToolError(`There is no page to go ${requested} to in this tab.`);
      await this.#checkDestination(tab, entry.url);
      await this.#historyMove(tab, () => this.#send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id }));
    } else if (requested === 'reload') {
      await this.#checkDestination(tab, tab.url);
      await this.#historyMove(tab, () => this.#send(tab, 'Page.reload'));
    } else {
      refuseScheme(target);
      const before = tab.lastLoader;
      const started = await this.#send<{ loaderId?: string; errorText?: string; isDownload?: boolean }>(
        tab,
        'Page.navigate',
        { url: target },
        NAV_TIMEOUT_MS,
      );
      if (started.isDownload)
        throw new ToolError(
          'The address started a download instead of opening a page (see browser_state); the tab stayed where it was.',
        );
      if (started.errorText) throw new ToolError(navigateError(started.errorText));
      // absent for a same-document navigation (a #fragment)
      if (started.loaderId !== undefined) loaderId = await this.#waitForLoader(tab, started.loaderId, before);
      else await sleep(SETTLE_MS);
    }
    const page = await this.#pageInfo(tab);
    const status = loaderId !== undefined ? tab.documentStatus.get(loaderId) : undefined;
    const url = page.url !== '' ? page.url : target;
    return { url, ...(page.title ? { title: page.title } : {}), ...(status !== undefined ? { status } : {}) };
  }

  /** Back, forward or reload: start it, give it a moment to begin, then wait for the document to load. */
  async #historyMove(tab: Tab, start: () => Promise<unknown>): Promise<void> {
    const seq = tab.navSeq;
    await start();
    const startBy = Date.now() + 2_000;
    while (tab.navSeq === seq && !tab.loading && Date.now() < startBy) await sleep(25);
    if (!(await this.#whileLoading(tab, NAV_TIMEOUT_MS)))
      throw new ToolError(`navigate failed: the page did not load within ${NAV_TIMEOUT_MS / 1000} s`);
    if (tab.loadError !== undefined) throw new ToolError(`navigate failed: ${netError(tab.loadError)}.`);
  }

  /**
   * Wait for DOMContentLoaded of the document `Page.navigate` started (matched by loader id), not its subresources,
   * or of a newer document that replaced it (a page that redirects itself with script while loading). Returns the
   * loader that loaded. `before` is the loader committed before the navigation started.
   */
  async #waitForLoader(tab: Tab, loaderId: string, before: string | undefined): Promise<string> {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      if (tab.loadedLoaders.has(loaderId)) return loaderId;
      const newer = tab.lastLoader;
      if (newer !== undefined && newer !== before && newer !== loaderId && tab.loadedLoaders.has(newer)) return newer;
      if (!this.#tabs.has(tab.id)) throw new ToolError('navigate failed: the tab closed.');
      if (this.#cdp?.closed !== false) throw new ToolError('navigate failed: the browser connection closed.');
      if (Date.now() >= deadline)
        throw new ToolError(`navigate failed: the page did not load within ${NAV_TIMEOUT_MS / 1000} s`);
      await sleep(25);
    }
  }

  /**
   * `Page.captureScreenshot` of a tab. Chrome paints no frame for a background tab with focus emulation on, so a
   * background tab is brought to the front for the capture and the active tab put back after.
   */
  async #capture(tab: Tab, params: CdpParams): Promise<BetaScreenshotResult> {
    const background = tab.id !== this.#activeId;
    if (background) await this.#send(tab, 'Page.bringToFront').catch(() => undefined);
    try {
      const shot = await this.#send<{ data: string }>(
        tab,
        'Page.captureScreenshot',
        { format: 'png', ...params },
        SCREENSHOT_TIMEOUT_MS,
      );
      return { data: shot.data, mediaType: 'image/png' };
    } finally {
      const active = this.#activeId !== undefined ? this.#tabs.get(this.#activeId) : undefined;
      if (background && active !== undefined) await this.#send(active, 'Page.bringToFront').catch(() => undefined);
    }
  }

  protected override async screenshot(_ctx: Ctx, input: BetaBrowserScreenshotInput): Promise<BetaScreenshotResult> {
    return this.#capture(await this.#tab(input.tab_id), {});
  }

  /** A viewport region, scaled up to fit the viewport (so it is never larger than a full screenshot). */
  protected override async zoom(_ctx: Ctx, input: BetaBrowserZoomInput): Promise<BetaScreenshotResult> {
    const tab = await this.#tab(input.tab_id);
    const region: unknown = input.region;
    if (
      !Array.isArray(region) ||
      region.length !== 4 ||
      !region.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
      throw new ToolError('region: expected [x0, y0, x1, y1] in viewport pixels');
    const [x0, y0, x1, y1] = region as [number, number, number, number];
    const { width, height } = this.#viewport;
    if (!(x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height && x1 > x0 && y1 > y0))
      throw new ToolError(`region: needs 0 <= x0 < x1 <= ${width} and 0 <= y0 < y1 <= ${height}`);
    const w = x1 - x0;
    const h = y1 - y0;
    // the clip is in document coordinates, so offset the viewport region by the scroll position
    const { cssVisualViewport: view } = await this.#send<{ cssVisualViewport: { pageX: number; pageY: number } }>(
      tab,
      'Page.getLayoutMetrics',
    );
    return this.#capture(tab, {
      clip: { x: x0 + view.pageX, y: y0 + view.pageY, width: w, height: h, scale: Math.min(width / w, height / h) },
    });
  }

  // --- members: mouse --------------------------------------------------------------------------------------

  protected override left_click(_ctx: Ctx, input: BetaBrowserLeftClickInput): Promise<void> {
    return this.#click(input, 'left', 1);
  }
  protected override right_click(_ctx: Ctx, input: BetaBrowserRightClickInput): Promise<void> {
    return this.#click(input, 'right', 1);
  }
  protected override middle_click(_ctx: Ctx, input: BetaBrowserMiddleClickInput): Promise<void> {
    return this.#click(input, 'middle', 1);
  }
  protected override double_click(_ctx: Ctx, input: BetaBrowserDoubleClickInput): Promise<void> {
    return this.#click(input, 'left', 2);
  }
  protected override triple_click(_ctx: Ctx, input: BetaBrowserTripleClickInput): Promise<void> {
    return this.#click(input, 'left', 3);
  }

  protected override async hover(_ctx: Ctx, input: BetaBrowserHoverInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const at = await this.#point(tab, input.target, 'hover');
    await Input.hover(this.#sender(tab), at);
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async left_click_drag(_ctx: Ctx, input: BetaBrowserLeftClickDragInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const from = this.#coordinate(input.from, 'from');
    const to = this.#coordinate(input.target);
    await Input.drag(this.#sender(tab), from, to);
    tab.buttons = 0;
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async left_mouse_down(_ctx: Ctx, input: BetaBrowserLeftMouseDownInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const at = this.#coordinate(input.target);
    await Input.mouseDown(this.#sender(tab), at);
    tab.buttons = 1;
    tab.point = at;
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async left_mouse_up(_ctx: Ctx, input: BetaBrowserLeftMouseUpInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const before = this.#mark(tab);
    await Input.mouseUp(this.#sender(tab), this.#coordinate(input.target));
    tab.buttons = 0;
    await this.#settle(tab, before, true); // a release completes a click
  }

  protected override async mouse_move(_ctx: Ctx, input: BetaBrowserMouseMoveInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const at = this.#coordinate(input.target);
    await Input.mouseMove(this.#sender(tab), at, tab.buttons);
    tab.point = at;
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async scroll(_ctx: Ctx, input: BetaBrowserScrollInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const at = this.#coordinate(input.target);
    const direction: unknown = input.scroll_direction;
    if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right')
      throw new ToolError('scroll_direction: expected "up", "down", "left" or "right"');
    const amount = input.scroll_amount ?? 3;
    if (typeof amount !== 'number' || !(amount >= 1 && amount <= 10))
      throw new ToolError('scroll_amount: must be between 1 and 10');
    await Input.wheel(this.#sender(tab), at, direction, amount);
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async scroll_to(_ctx: Ctx, input: BetaBrowserScrollToInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    await this.#runtime<null>(tab, scrollToExpr(checkRef(input.target?.ref), this.#refs.reserve()));
    await this.#settle(tab, this.#mark(tab), false);
  }

  // --- members: keyboard and forms -------------------------------------------------------------------------

  protected override async type_(_ctx: Ctx, input: BetaBrowserTypeInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const text = checkText(input.text, 'text');
    const before = this.#mark(tab);
    await Input.typeText(this.#sender(tab), text);
    await this.#settle(tab, before, true);
  }

  protected override async key(_ctx: Ctx, input: BetaBrowserKeyInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const text = checkText(input.text, 'text');
    const repeat = input.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
      throw new ToolError('repeat: must be an integer from 1 to 100');
    const before = this.#mark(tab);
    await Input.pressKeys(this.#sender(tab), text, repeat);
    await this.#settle(tab, before, true);
  }

  protected override async hold_key(ctx: Ctx, input: BetaBrowserHoldKeyInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const text = checkText(input.text, 'text');
    await Input.holdKey(this.#sender(tab), text, checkDuration(input.duration, 30), ctx.signal);
    await this.#settle(tab, this.#mark(tab), false);
  }

  protected override async form_input(_ctx: Ctx, input: BetaBrowserFormInputInput): Promise<string | void> {
    const tab = await this.#tab(input.tab_id);
    const { summary } = await this.#runtime<{ summary: string }>(
      tab,
      formInputExpr(checkRef(input.target?.ref), input.value, this.#refs.reserve()),
    );
    await this.#settle(tab, this.#mark(tab), false);
    return typeof summary === 'string' ? summary : undefined;
  }

  // --- members: reading ------------------------------------------------------------------------------------

  protected override async read_page(_ctx: Ctx, input: BetaBrowserReadPageInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    const filter: unknown = input.filter;
    if (filter != null && filter !== 'all' && filter !== 'interactive')
      throw new ToolError('filter: expected "all" or "interactive", or omit it');
    const depth: unknown = input.depth;
    if (depth != null && (!Number.isInteger(depth) || (depth as number) < 1))
      throw new ToolError('depth: expected a positive integer');
    const ref = input.ref == null ? input.ref : checkRef(input.ref);
    return this.#runtime<string>(
      tab,
      readPageExpr({ filter, depth: depth as number | null | undefined, ref, base: this.#refs.reserve() }),
    );
  }

  protected override async find(_ctx: Ctx, input: BetaBrowserFindInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    const query = checkText(input.query, 'query').trim();
    if (query === '') throw new ToolError('query: describe the element to find');
    const text = await this.#runtime<string>(tab, findExpr(query, this.#refs.reserve()));
    return text !== '' ? text : 'No element matches the query. Try other words, or read_page.';
  }

  protected override async get_page_text(_ctx: Ctx, input: BetaBrowserGetPageTextInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    return this.#runtime<string>(tab, pageTextExpr(PAGE_TEXT_MAX, this.#refs.reserve()));
  }

  protected override async wait(ctx: Ctx, input: BetaBrowserWaitInput): Promise<void> {
    if (input.tab_id) await this.#tab(input.tab_id); // an unknown tab is still an error
    const seconds = checkDuration(input.duration, 30);
    await sleep(seconds * 1000, undefined, ctx.signal ? { signal: ctx.signal } : {});
  }

  // --- members: default-off --------------------------------------------------------------------------------

  protected override async file_upload(ctx: Ctx, input: BetaBrowserFileUploadInput): Promise<void> {
    const tab = await this.#tab(input.tab_id);
    const ref = checkRef(input.target?.ref);
    const paths = input.paths ?? [];
    const documents = input.document_ids ?? [];
    const before = this.#mark(tab);
    // Pin the actual node before reading or staging bytes; a reused ref after navigation cannot redirect the upload.
    const contextId = await this.#runtimeWorld(tab);
    const target = await this.#send<EvaluateResult>(tab, 'Runtime.evaluate', {
      expression: fileInputExpr(ref, paths.length + documents.length, this.#refs.reserve()),
      contextId,
      returnByValue: false,
      awaitPromise: true,
    });
    const objectId = target.result?.objectId;
    if (!objectId || target.exceptionDetails) throw new ToolError('file_upload: target could not be resolved');
    let directory: string | undefined;
    let stagedBytes = 0;
    let selected = false;
    try {
      if (target.result?.subtype !== 'node') {
        const details = await this.#send<EvaluateResult>(tab, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){return this.error}',
          returnByValue: true,
        });
        throw new ToolError(
          `file_upload: ${typeof details.result?.value === 'string' ? details.result.value : 'target must be a file input'}`,
        );
      }
      const node = await this.#send<{ node: { backendNodeId: number } }>(tab, 'DOM.describeNode', { objectId });
      const files = await prepareUploads(paths, documents, this.#uploadDocuments, ctx.signal);
      const bytes = files.reduce((sum, file) => sum + file.data.byteLength, 0);
      if (this.#uploadBytes + bytes > 50 * 1024 * 1024 || this.#uploadDirectories.size >= 100)
        throw new ToolError('file_upload: session staging limit reached; start a new browser session');
      ctx.signal?.throwIfAborted();
      const result = await staging(() =>
        this.sandbox.commands.run('umask 077; mktemp -d /tmp/e2b-browser-upload.XXXXXX'),
      );
      if (!/^\/tmp\/e2b-browser-upload\.[A-Za-z0-9]+$/.test(result.stdout.trim()))
        throw new ToolError('file_upload: could not create staging directory');
      directory = result.stdout.trim();
      this.#uploadDirectories.add(directory);
      this.#uploadBytes += bytes;
      stagedBytes = bytes;
      const staged: string[] = [];
      for (const [index, file] of files.entries()) {
        ctx.signal?.throwIfAborted();
        await staging(() => this.sandbox.files.makeDir(`${directory}/${index}`));
        const path = `${directory}/${index}/${file.name}`;
        await staging(() =>
          this.sandbox.files.write(
            path,
            file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer,
          ),
        );
        staged.push(path);
      }
      ctx.signal?.throwIfAborted();
      if (tab.navSeq !== before.seq || tab.navRequests !== before.requests)
        throw new ToolError('file_upload: page changed while staging files; inspect it and retry');
      const valid = await this.#send<EvaluateResult>(tab, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fileInputValidationFunction,
        arguments: fileInputValidationArguments(ref, paths.length + documents.length, this.#refs.reserve()),
        returnByValue: true,
        awaitPromise: true,
      });
      if (valid.result?.value !== true) throw new ToolError('file_upload: target changed while staging files');
      await this.#send(tab, 'DOM.setFileInputFiles', { backendNodeId: node.node.backendNodeId, files: staged });
      // Chrome's File objects read these paths lazily, including on a later form submission.
      selected = true;
      await this.#settle(tab, before, true);
    } finally {
      await this.#send(tab, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      if (directory !== undefined && !selected) {
        try {
          await this.sandbox.files.remove(directory);
          this.#uploadDirectories.delete(directory);
          this.#uploadBytes -= stagedBytes;
        } catch {
          /* Retain the directory and its quota so close() retries cleanup. */
        }
      }
    }
  }

  /**
   * Runs in the page's main world, with the page's authority (enabling it requires `confirm`). The value of the last
   * expression comes back as text: strings as they are, other values as JSON, DOM nodes by description.
   */
  protected override async javascript_exec(_ctx: Ctx, input: BetaBrowserJavascriptExecInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    const expression = checkText(input.text, 'text');
    const before = this.#mark(tab);
    let evaluated = await this.#send<EvaluateResult>(
      tab,
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: false, replMode: true, userGesture: true },
      SCRIPT_TIMEOUT_MS,
    );
    // replMode does not await a promise the script ends with (only one it awaits itself)
    const promise = evaluated.result?.subtype === 'promise' ? evaluated.result.objectId : undefined;
    if (promise !== undefined && !evaluated.exceptionDetails)
      evaluated = await this.#send<EvaluateResult>(
        tab,
        'Runtime.awaitPromise',
        { promiseObjectId: promise },
        SCRIPT_TIMEOUT_MS,
      );
    if (evaluated.exceptionDetails)
      throw new ToolError(`The script threw: ${exceptionText(evaluated.exceptionDetails)}`);
    const text = await this.#stringify(tab, evaluated.result);
    await this.#settle(tab, before, true);
    return cut(text, SCRIPT_RESULT_MAX);
  }

  async #stringify(tab: Tab, value: RemoteObject | undefined): Promise<string> {
    if (value === undefined || value.type === 'undefined') return 'undefined';
    if (value.objectId === undefined)
      return value.unserializableValue ?? (typeof value.value === 'string' ? value.value : JSON.stringify(value.value));
    try {
      if (value.subtype === 'node') return value.description ?? 'node';
      const json = await this.#send<EvaluateResult>(tab, 'Runtime.callFunctionOn', {
        objectId: value.objectId,
        functionDeclaration:
          'function () { try { return JSON.stringify(this, null, 2) ?? String(this); } catch { return String(this); } }',
        returnByValue: true,
      });
      return typeof json.result?.value === 'string' ? json.result.value : (value.description ?? value.type);
    } finally {
      void this.#send(tab, 'Runtime.releaseObject', { objectId: value.objectId }).catch(() => undefined);
    }
  }

  /** Console entries (and uncaught exceptions) since the tab attached or the last read; reading clears them. */
  protected override async read_console(_ctx: Ctx, input: BetaBrowserReadConsoleInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    const entries = tab.console.splice(0);
    return entries.length > 0 ? entries.join('\n') : 'No console messages since the last read.';
  }

  /** Requests since the tab attached or the last read, oldest first: method, status, URL, type, MIME, time. */
  protected override async read_network(_ctx: Ctx, input: BetaBrowserReadNetworkInput): Promise<string> {
    const tab = await this.#tab(input.tab_id);
    const entries = tab.network.splice(0);
    tab.requests.clear();
    if (entries.length === 0) return 'No network requests since the last read.';
    return entries
      .map((e) => {
        const status = e.error !== undefined ? `failed (${e.error})` : (e.status ?? 'pending');
        return [e.method, status, e.url, e.type, e.mime ?? '', e.ms !== undefined ? `${e.ms} ms` : '']
          .filter(Boolean)
          .join(' ');
      })
      .join('\n');
  }

  // --- members: tabs ---------------------------------------------------------------------------------------

  protected override async new_tab(): Promise<BetaBrowserStateTabEntry> {
    if (this.#tabs.size >= MAX_TABS)
      throw new ToolError(`${MAX_TABS} tabs are open, the most allowed. Close one first.`);
    const { targetId } = await this.#client().send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const tab = await this.#waitForTab(() => this.#tabByTarget(targetId));
    await this.#activate(tab);
    return this.#entry(tab);
  }

  protected override list_tabs(): BetaBrowserStateTabEntry[] {
    this.#client(); // after the browser died, the registry is stale
    return [...this.#tabs.values()].map((tab) => this.#entry(tab));
  }

  protected override async switch_tab(_ctx: Ctx, input: BetaBrowserSwitchTabInput): Promise<BetaBrowserStateTabEntry> {
    const tab = await this.#tab(checkTabId(input.tab_id));
    await this.#activate(tab);
    return this.#entry(tab);
  }

  /**
   * Closes the tab; if it was active, the most recently active tab left becomes active. The last tab is not closed:
   * a browser with no tab leaves every other member nothing to act on.
   */
  protected override async close_tab(_ctx: Ctx, input: BetaBrowserCloseTabInput): Promise<void> {
    const tab = await this.#tab(checkTabId(input.tab_id));
    if (this.#tabs.size === 1)
      throw new ToolError('This is the only open tab. Open another with new_tab before closing it.');
    await this.#client().send('Target.closeTarget', { targetId: tab.targetId });
    const deadline = Date.now() + 5_000;
    while (this.#tabs.has(tab.id) && Date.now() < deadline) await sleep(20);
    this.#remove(tab);
  }
}
