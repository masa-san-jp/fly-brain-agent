import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const promptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts/speech.ja.md');
const template = readFileSync(promptPath, 'utf8').trim();

export function buildPrompt(validatedEvent) {
  return [
    template,
    '',
    '検証済みイベントJSON:',
    '',
    '```json',
    JSON.stringify(validatedEvent),
    '```',
  ].join('\n');
}

export { promptPath, template };
