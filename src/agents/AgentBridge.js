import { EventDetector } from './EventDetector.js';
import { RuleTable } from './RuleTable.js';
import { Client } from './Client.js';
import { interpretBrainState } from './NeuralNarrator.js';
import { arenaItems } from './arenaTools.js';

function terminalMap(terminals) {
  return new Map((terminals || []).map(terminal => [String(terminal.id), terminal]));
}

/** Main-thread agent bridge: detector → rule table → WebSocket client. */
export class AgentBridge {
  constructor({ terminals = [], rules = new RuleTable(), client, clientOptions, onReply, onError, onStatus, getArenaSnapshot } = {}) {
    this.terminals = [...terminals];
    this.terminalsById = terminalMap(this.terminals);
    this.rules = rules;
    this.onReply = onReply;
    this.onError = onError;
    this.onStatus = onStatus;
    this.getArenaSnapshot = getArenaSnapshot;
    this.client = client || new Client({ ...clientOptions, onReply: (reply, request) => this.handleReply(reply, request), onError: (error, request) => this.handleError(error, request), onStatus });
    this.detectors = new Map();
    this.events = [];
    this.brainStates = new Map();
  }

  start() { return this.client.start(); }
  stop() { this.client.stop(); }

  setBrainState(flyId, state) {
    if (state?.state_table) this.brainStates.set(flyId, state);
  }

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

  narrate(payload) {
    return this.dispatch(payload, 'narr-');
  }

  dispatch(event, idPrefix = 'browser-') {
    const terminal = this.terminalsById.get(String(event.terminal_id));
    const payload = event.event === 'touched_agent' ? {
      ...event,
      event: 'request',
      request_kind: terminal?.kind || 'guide',
      request_text: terminal?.request || '',
      state_table: this.brainStates.get(event.agent_id)?.state_table || interpretBrainState([], event.state).state_table,
      arena: this.getArenaSnapshot?.({ event, terminal }) || { pose: { x: event.state.pos[0], y: event.state.pos[1], yaw: event.state.yaw }, items: [] },
    } : event;
    const backend = this.rules.backendFor(payload, terminal);
    const id = this.client.send({ backend, payload, idPrefix });
    this.events.push({ id, backend, payload });
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
