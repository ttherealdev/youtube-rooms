import { type ClientMessage, type ServerMessage, serverMessageSchema } from '@playercn/protocol';
import { api } from '~/lib/api';
import { backoffDelay } from '~/lib/utils';
import { ClockEstimator, monotonicNow, startProbing } from './clock';

/**
 * The room socket.
 *
 * All transport concerns live here — ticket handshake, reconnection, clock
 * probing, message validation. Feature code subscribes to typed messages and
 * never touches a `WebSocket`, which is what makes the WebTransport migration
 * in ADR 0004 a new implementation rather than a refactor.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'open'
  | 'reconnecting'
  | 'closed';

type Listener = (message: ServerMessage) => void;
type StateListener = (state: ConnectionState, detail?: string) => void;

export class RoomSocket {
  readonly clock = new ClockEstimator();

  #roomId: string;
  #ws: WebSocket | null = null;
  #state: ConnectionState = 'idle';
  #listeners = new Set<Listener>();
  #stateListeners = new Set<StateListener>();
  #attempt = 0;
  #stopProbing: (() => void) | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #intentionallyClosed = false;
  /** Queued while the socket is down, flushed on `ready`. */
  #outbox: ClientMessage[] = [];

  constructor(roomId: string) {
    this.#roomId = roomId;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  onMessage(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  #setState(state: ConnectionState, detail?: string): void {
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state, detail);
  }

  async connect(): Promise<void> {
    if (this.#state === 'connecting' || this.#state === 'open') return;

    this.#intentionallyClosed = false;
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    let ticket: string;
    try {
      // A fresh single-use ticket per attempt: they expire in 30 seconds, so a
      // cached one would fail every reconnect after the first (ADR 0007).
      const response = await api<{ ticket: string }>('/api/auth/ws-ticket', {
        method: 'POST',
        body: { roomId: this.#roomId },
      });
      ticket = response.ticket;
    } catch {
      this.#scheduleReconnect();
      return;
    }

    // Next's rewrites proxy HTTP but not WebSocket upgrades, so in development
    // this must point at the API origin directly rather than relying on the
    // same-origin proxy that `/api` uses. In production the reverse proxy
    // terminates both on one origin and the fallback is correct.
    const url = new URL(
      `/ws/rooms/${this.#roomId}`,
      process.env.NEXT_PUBLIC_WS_URL ?? window.location.origin,
    );
    url.protocol = url.protocol.replace('http', 'ws');

    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#setState('authenticating');
      // The ticket is the *first frame*, never a query parameter — query
      // strings land in every access log between here and the server.
      ws.send(JSON.stringify({ t: 'authenticate', ticket }));
    };

    ws.onmessage = (event) => this.#handleRaw(event.data);

    ws.onerror = () => {
      // `onclose` always follows, so reconnection is driven from there alone.
    };

    ws.onclose = (event) => {
      this.#teardownProbing();
      this.#ws = null;

      if (this.#intentionallyClosed) {
        this.#setState('closed');
        return;
      }
      this.#scheduleReconnect(event.reason);
    };
  }

  #handleRaw(data: unknown): void {
    if (typeof data !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    // Validate at the boundary. The server is ours, but a schema mismatch
    // after a partial deploy is exactly the situation where silently accepting
    // a malformed message produces the worst bug (ADR 0011).
    const result = serverMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[socket] dropped unrecognised message', result.error.issues[0]);
      return;
    }

    const message = result.data;

    if (message.t === 'pong') {
      this.clock.addSample(message.clientSent, message.serverTime);
      return;
    }

    if (message.t === 'ready') {
      this.#attempt = 0;
      this.clock.seed(message.serverTime);
      this.#setState('open');
      this.#startProbing();
      this.#flushOutbox();
    }

    for (const listener of this.#listeners) listener(message);
  }

  #startProbing(): void {
    this.#teardownProbing();
    this.#stopProbing = startProbing(() => {
      this.send({ t: 'ping', clientSent: monotonicNow() });
    });
  }

  #teardownProbing(): void {
    this.#stopProbing?.();
    this.#stopProbing = undefined;
  }

  #scheduleReconnect(reason?: string): void {
    this.#setState('reconnecting', reason);
    // The route may be completely different after a reconnect, so prior RTT
    // samples say nothing useful about the new one.
    this.clock.reset();

    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;

    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  send(message: ClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
      return;
    }

    // Buffer user-initiated actions across a blip, but never buffer clock
    // probes or drift reports: a probe replayed after reconnect measures
    // nothing, and a stale drift sample would poison the estimate.
    if (message.t !== 'ping' && message.t !== 'sync_report') {
      this.#outbox.push(message);
      if (this.#outbox.length > 32) this.#outbox.shift();
    }
  }

  #flushOutbox(): void {
    const pending = this.#outbox;
    this.#outbox = [];
    for (const message of pending) this.send(message);
  }

  close(): void {
    this.#intentionallyClosed = true;
    this.#teardownProbing();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#ws?.close(1000, 'client left');
    this.#ws = null;
    this.#setState('closed');
  }
}
