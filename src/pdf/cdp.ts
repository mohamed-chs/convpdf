/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Chrome reads commands from fd 3 and writes responses/events to fd 4, each
 * message being a JSON document terminated by a NUL byte. We use "flat"
 * session mode so every page session is multiplexed over the same pipe via a
 * `sessionId` field.
 */
import type { Readable, Writable } from 'node:stream';

type Params = Record<string, unknown>;
/** CDP results are loosely typed; callers narrow them. */
export type CdpResult = any;

interface Pending {
  resolve: (value: CdpResult) => void;
  reject: (err: Error) => void;
  method: string;
}

export interface CdpEvent {
  method: string;
  params: CdpResult;
  sessionId?: string;
}

type Listener = (event: CdpEvent) => void;

export class CdpError extends Error {
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class CdpConnection {
  #out: Writable;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<Listener>();
  #chunks: Buffer[] = [];
  #closedError: Error | null = null;

  constructor(input: Readable, output: Writable) {
    this.#out = output;
    input.on('data', (data: Buffer) => this.#onData(data));
    input.on('close', () => this.dispose(new Error('Browser connection closed')));
    input.on('error', (err) => this.dispose(err));
    output.on('error', (err) => this.dispose(err));
  }

  #onData(data: Buffer): void {
    let start = 0;
    let end = data.indexOf(0);
    while (end !== -1) {
      this.#chunks.push(data.subarray(start, end));
      const message = Buffer.concat(this.#chunks).toString('utf8');
      this.#chunks = [];
      this.#dispatch(message);
      start = end + 1;
      end = data.indexOf(0, start);
    }
    if (start < data.length) this.#chunks.push(data.subarray(start));
  }

  #dispatch(raw: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new CdpError(pending.method, msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const event: CdpEvent = { method: msg.method, params: msg.params, sessionId: msg.sessionId };
      for (const listener of this.#listeners) listener(event);
    }
  }

  send(method: string, params: Params = {}, sessionId?: string): Promise<CdpResult> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const id = this.#nextId++;
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#out.write(payload + '\0');
    });
  }

  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolve with the params of the first matching event. */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number, predicate?: (params: CdpResult) => boolean): Promise<CdpResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      const off = this.on((event) => {
        if (event.method !== method || event.sessionId !== sessionId) return;
        if (predicate && !predicate(event.params)) return;
        clearTimeout(timer);
        off();
        resolve(event.params);
      });
    });
  }

  dispose(err: Error): void {
    if (this.#closedError) return;
    this.#closedError = err;
    for (const pending of this.#pending.values()) pending.reject(err);
    this.#pending.clear();
    this.#listeners.clear();
  }

  get closed(): boolean {
    return this.#closedError !== null;
  }
}
