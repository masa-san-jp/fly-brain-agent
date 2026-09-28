import { Client } from './Client.js';
import { buildBciPayload, changedFacts } from './bci.js';
import { nothingAction, validateBciAction } from './arenaTools.js';

/** Browser live loop for ?bci=1. It sends only the decoded table to the bridge. */
export class BCIInterface {
  constructor({ url, backend = 'ollama', client, clientOptions, onDecision, onReply, onError, onState, onStatus } = {}) {
    this.backend = backend;
    this.onDecision = onDecision;
    this.onReply = onReply;
    this.onError = onError;
    this.onState = onState;
    this.client = client || new Client({ ...clientOptions, url, onReply: (reply, request) => this.handleReply(reply, request), onError: (error, request) => this.handleError(error, request), onStatus });
    this.inFlight = false;
    this.lastAt = -Infinity;
    this.lastSignature = null;
    this.lastTable = null;
    this.actions = [];
    this.contexts = new Map();
  }

  start() { return this.client.start(); }
  stop() { this.client.stop(); }

  observe({ agentId = 0, tMs, stateTable, pose } = {}) {
    if (!Array.isArray(stateTable) || !Number.isFinite(tMs)) return null;
    const signature = stateTable.map(item => `${item.fact}=${item.value}`).join('|');
    this.onState?.(stateTable, tMs);
    const stateChanged = signature !== this.lastSignature;
    const due = !this.inFlight && (this.lastSignature === null || (stateChanged && tMs - this.lastAt >= 5_000) || tMs - this.lastAt >= 20_000);
    if (!due) return null;
    const changed = changedFacts(this.lastTable, stateTable);
    const payload = buildBciPayload({ agentId, tMs, stateTable, changed, lastActions: this.actions });
    const context = { pose: structuredClone(pose), payload };
    this.inFlight = true;
    this.lastAt = tMs;
    this.lastSignature = signature;
    this.lastTable = stateTable.map(item => ({ ...item }));
    this.onDecision?.(context);
    const id = this.client.send({ backend: this.backend, payload, idPrefix: 'bci-' });
    if (!id) this.inFlight = false;
    else this.contexts.set(id, context);
    return id;
  }

  handleReply(reply, request) {
    const id = request?.request?.id;
    const context = this.contexts.get(id) || { payload: request?.payload };
    this.contexts.delete(id);
    const action = validateBciAction(reply?.action);
    this.actions.push(action); this.actions = this.actions.slice(-3);
    this.inFlight = false;
    this.onReply?.({ reply: { ...reply, action }, context });
  }

  handleError(error, request) {
    const id = request?.request?.id;
    const context = this.contexts.get(id) || { payload: request?.payload };
    this.contexts.delete(id);
    this.inFlight = false;
    this.onError?.({ error, context });
  }
}

export { nothingAction };
