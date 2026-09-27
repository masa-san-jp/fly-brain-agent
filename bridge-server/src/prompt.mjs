import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');
const promptPath = path.join(promptDir, 'speech.ja.md');
const narratePromptPath = path.join(promptDir, 'narrate.ja.md');
const toolPromptPath = path.join(promptDir, 'tool.ja.md');
const template = readFileSync(promptPath, 'utf8').trim();
const narrateTemplate = readFileSync(narratePromptPath, 'utf8').trim();
const toolTemplate = readFileSync(toolPromptPath, 'utf8').trim();

export function buildPrompt(validatedEvent) {
  const selectedTemplate = validatedEvent?.event === 'narrate' ? narrateTemplate : validatedEvent?.event === 'request' ? toolTemplate : template;
  const promptEvent = validatedEvent?.event === 'narrate'
    ? { event: 'narrate', state_table: validatedEvent.state_table, changed: validatedEvent.changed, previous_line: validatedEvent.previous_line }
    : validatedEvent?.event === 'request'
      ? { event: 'request', request_kind: validatedEvent.request_kind, request_text: validatedEvent.request_text,
        state_table: validatedEvent.state_table, recent_behaviors: validatedEvent.recent_behaviors, arena: validatedEvent.arena }
    : validatedEvent;
  return [
    selectedTemplate,
    '',
    '検証済みイベントJSON:',
    '',
    '```json',
    JSON.stringify(promptEvent),
    '```',
  ].join('\n');
}

export { narratePromptPath, narrateTemplate, promptPath, template, toolPromptPath, toolTemplate };
