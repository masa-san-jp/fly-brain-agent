import { EventDetector } from './EventDetector.js';
import { RuleTable } from './RuleTable.js';
import { Client } from './Client.js';

function terminalMap(terminals) {
  return new Map((terminals || []).map(terminal => [String(terminal.id), terminal]));
}

/** Main-thread agent bridge: detector → rule table → WebSocket client. */
export class AgentBridge {
  constructor({ terminals = [], rules = new RuleTable(), client, clientOptions, onReply, onError, onStatus } = {}) {
    this.terminals = [...terminals];
    this.terminalsById = terminalMap(this.terminals);
    this.rules = rules;
    this.onReply = onReply;
    this.onError = onError;
    this.onStatus = onStatus;
    this.client = client || new Client({ ...clientOptions, onReply: (reply, request) => this.handleReply(reply, request), onError: (error, request) => this.handleError(error, request), onStatus });
    this.detectors = new Map();
    this.events = [];
  }

  start() { return this.client.start(); }
  stop() { this.client.stop(); }

  addFly(fly) {
    const detector = new EventDetector({ terminals: this.terminals });
    this.detectors.set(fly.id, detector);
    return detector;
  }

  observe(fly, pose) {
    const detector = this.detectors.get(fly.id) || this.addFly(fly);
    for (const event of detector.feed({ ...pose, id: fly.id })) this.dispatch(event);
  }

  debugTouch(fly, terminalId) {
    if (!fly?.last) return null;
    const detector = this.detectors.get(fly.id) || this.addFly(fly);
    const event = detector.syntheticTouch({ ...fly.last, id: fly.id }, terminalId);
    if (!event) return null;
    return this.dispatch(event, 'debug-');
  }

  dispatch(event, idPrefix = 'browser-') {
    const terminal = this.terminalsById.get(String(event.terminal_id));
    const backend = this.rules.backendFor(event, terminal);
    const id = this.client.send({ backend, payload: event, idPrefix });
    this.events.push({ id, backend, payload: event });
    return id;
  }

  handleReply(reply, request) {
    const sent = request?.payload ? { payload: request.payload, backend: request.backend } : null;
    this.onReply?.({ reply, request: sent });
  }

  handleError(error, request) {
    const sent = request?.payload ? { payload: request.payload, backend: request.backend } : null;
    this.onError?.({ error, request: sent });
  }
}

export async function loadAgentBridgeRules(options = {}) {
  return RuleTable.load(options);
}
