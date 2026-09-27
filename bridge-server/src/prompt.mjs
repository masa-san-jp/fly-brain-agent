import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');
const promptPath = path.join(promptDir, 'speech.ja.md');
const narratePromptPath = path.join(promptDir, 'narrate.ja.md');
const template = readFileSync(promptPath, 'utf8').trim();
const narrateTemplate = readFileSync(narratePromptPath, 'utf8').trim();

export function buildPrompt(validatedEvent) {
  const selectedTemplate = validatedEvent?.event === 'narrate' ? narrateTemplate : template;
  return [
    selectedTemplate,
    '',
    '検証済みイベントJSON:',
    '',
    '```json',
    JSON.stringify(validatedEvent),
    '```',
  ].join('\n');
}

export { narratePromptPath, narrateTemplate, promptPath, template };
