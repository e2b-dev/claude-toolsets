/**
 * A small Chrome DevTools Protocol client over one WebSocket: commands with timeouts, flattened target sessions and
 * an event dispatcher. The driver needs events (dialogs, tabs, downloads, navigation), so unlike the quickstart's
 * client nothing is dropped: every event reaches the handlers registered for its method.
 *
 * Error text is model-facing: it names the CDP method and Chrome's own message, never the endpoint URL or host.
 */

import WebSocket from 'ws';
import { ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';

export type CdpParams = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** A CDP message: a reply (`id` with `result` or `error`) or an event (`method` and `params`, no `id`). */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

interface PendingCommand {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type Handler = (params: any, sessionId: string | undefined) => void;

/** One DevTools connection to a browser. Build it with `CdpClient.connect`, release it with `close()`. */
export class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #handlers = new Map<string, Set<Handler>>();
  readonly #closeHandlers: Array<() => void> = [];
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (raw) => this.#receive(String(raw)));
    socket.on('error', () => this.#shutDown('the browser connection failed'));
    socket.on('close', () => this.#shutDown('the browser connection closed'));
  }

  /**
   * Open the browser endpoint. `headers` go on the WebSocket handshake (the E2B traffic access token). A failure
   * reports only the HTTP status, if there was one, so the address and headers stay out of the message.
   */
  static async connect(url: string, headers: Record<string, string> = {}): Promise<CdpClient> {
    const socket = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error: Error) => {
        const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
        reject(new Error(`Could not connect to the browser${status ? ` (HTTP ${status})` : ''}`));
      });
    });
    return new CdpClient(socket);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Send one command and resolve with its result. `sessionId` routes it to an attached target (flat sessions);
   * without one it goes to the browser. Rejects with a `ToolError` on a CDP error, a timeout or a closed connection.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: CdpParams = {},
    sessionId?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new ToolError(`${method} failed: the browser connection is closed`));
    const id = this.#nextId++;
    const message: CdpMessage & { params: CdpParams } = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ToolError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (result: Record<string, unknown>) => void, reject, timer });
      this.#socket.send(JSON.stringify(message), (error) => {
        if (error) this.#settle(id, undefined, 'the browser connection failed');
      });
    });
  }

  /**
   * Call `handler` for every `method` event, with the session it came from (undefined for the browser session).
   * Returns the unsubscribe function. A handler that throws is isolated from the others and from the socket.
   */
  on(method: string, handler: Handler): () => void {
    let set = this.#handlers.get(method);
    if (set === undefined) this.#handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => void set.delete(handler);
  }

  /** Call `handler` once when the connection ends, whether closed here or lost. */
  onClose(handler: () => void): void {
    if (this.#closed) handler();
    else this.#closeHandlers.push(handler);
  }

  /** Close the socket and fail every command still waiting. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return this.#shutDown('the browser connection closed');
    const closed = new Promise<void>((resolve) => this.#socket.once('close', () => resolve()));
    this.#socket.close();
    const forced = setTimeout(() => this.#socket.terminate(), 2_000);
    await closed;
    clearTimeout(forced);
  }

  #receive(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      this.#settle(message.id, message);
      return;
    }
    if (message.method === undefined) return;
    for (const handler of this.#handlers.get(message.method) ?? []) {
      try {
        handler(message.params ?? {}, message.sessionId);
      } catch {
        // one broken handler must not stop the others or the socket
      }
    }
  }

  #settle(id: number, message: CdpMessage | undefined, failure?: string): void {
    const command = this.#pending.get(id);
    if (command === undefined) return;
    this.#pending.delete(id);
    clearTimeout(command.timer);
    if (failure !== undefined) command.reject(new ToolError(`${command.method} failed: ${failure}`));
    else if (message?.error)
      command.reject(new ToolError(`${command.method} failed: ${message.error.message ?? 'unknown error'}`));
    else command.resolve(message?.result ?? {});
  }

  #shutDown(reason: string): void {
    const first = !this.#closed;
    this.#closed = true;
    if (first)
      for (const handler of this.#closeHandlers.splice(0))
        try {
          handler();
        } catch {
          // a failing handler must not stop the others
        }
    for (const id of [...this.#pending.keys()]) this.#settle(id, undefined, reason);
  }
}
