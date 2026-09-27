const DEFAULT_RULES_URL = new URL('./rules.json', import.meta.url);

export class RuleTable {
  constructor(rules = {}) {
    this.rules = { ...rules };
  }

  static async load({ url = DEFAULT_RULES_URL, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required to load rules');
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`rules request failed: HTTP ${response.status}`);
    return new RuleTable(await response.json());
  }

  backendFor(event, terminal = null) {
    if (event?.event === 'request' && this.rules.request) return this.rules.request;
    if ((event?.event === 'touched_agent' || event?.event === 'request') && terminal?.backend) return terminal.backend;
    return this.rules[event?.event] || 'ollama';
  }
}

export { DEFAULT_RULES_URL };
