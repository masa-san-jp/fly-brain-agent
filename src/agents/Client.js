const DEFAULT_BACKOFF = Object.freeze({ initialMs: 250, maxMs: 5_000 });

function validWebSocketUrl(value) {
  try {
    const url = new URL(value, globalThis.location?.href || 'http://localhost/');
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Browser-only WebSocket client. It contains no credential or backend secret. */
export class Client {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, onReply, onError, onStatus, backoff = {} } = {}) {
    this.url = validWebSocketUrl(url);
    this.WebSocketImpl = WebSocketImpl;
    this.onReply = onReply;
    this.onError = onError;
    this.onStatus = onStatus;
    this.backoff = { ...DEFAULT_BACKOFF, ...backoff };
    this.socket = null;
    this.queue = [];
    this.pending = new Map();
    this.sequence = 0;
    this.retryMs = this.backoff.initialMs;
    this.retryTimer = null;
    this.closed = false;
  }

  start() {
    if (!this.url || !this.WebSocketImpl || this.closed) return false;
    this.connect();
    return true;
  }

  connect() {
    if (this.closed || !this.url || this.socket) return;
    this.onStatus?.('connecting');
    let socket;
    try { socket = new this.WebSocketImpl(this.url); } catch (error) { this.fail(error); return; }
    this.socket = socket;
    socket.addEventListener?.('open', () => this.open());
    socket.addEventListener?.('message', event => this.message(event.data));
    socket.addEventListener?.('error', error => this.fail(error));
    socket.addEventListener?.('close', () => this.closeSocket());
    // Small WebSocket test doubles often expose on* rather than addEventListener.
    if (!socket.addEventListener) {
      socket.onopen = () => this.open();
      socket.onmessage = event => this.message(event.data);
      socket.onerror = error => this.fail(error);
      socket.onclose = () => this.closeSocket();
    }
  }

  open() {
    this.retryMs = this.backoff.initialMs;
    this.onStatus?.('connected');
    this.flush();
  }

  closeSocket() {
    this.socket = null;
    if (this.closed) return;
    this.onStatus?.('disconnected');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.backoff.maxMs, this.retryMs * 2);
  }

  fail(error) {
    this.onError?.({ type: 'client_error', error });
    try { this.socket?.close(); } catch { /* best effort */ }
  }

  message(raw) {
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : raw.data); } catch { return; }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.type === 'reply') this.onReply?.(message, request);
    else this.onError?.(message, request);
  }

  nextId(prefix = 'browser-') {
    this.sequence += 1;
    return `${prefix}${Date.now()}-${this.sequence}`;
  }

  send({ backend, payload, idPrefix = 'browser-' }) {
    if (!this.url) return null;
    const id = this.nextId(idPrefix);
    const request = { type: 'event', id, backend, payload };
    this.pending.set(id, { request, payload, backend });
    this.queue.push(request);
    this.flush();
    return id;
  }

  flush() {
    if (!this.socket || this.socket.readyState !== 1) return;
    while (this.queue.length) this.socket.send(JSON.stringify(this.queue.shift()));
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.queue = [];
    try { this.socket?.close(); } catch { /* best effort */ }
    this.socket = null;
    this.onStatus?.('stopped');
  }
}

export { DEFAULT_BACKOFF, validWebSocketUrl };
