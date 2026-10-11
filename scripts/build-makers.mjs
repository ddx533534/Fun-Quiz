// Freeze the authored JSON into a module that Makers can bundle with Node.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = process.cwd();
const library = JSON.parse(await readFile('engine/测评结果内容库-v1.1.json', 'utf8'));
const questions = JSON.parse(await readFile('content/questions-v1.json', 'utf8'));
await mkdir('cloud-functions/_lib', { recursive: true });
await writeFile('cloud-functions/_lib/content.js',
  '// Generated from frozen content. Do not edit by hand.\n' +
  'export const library = ' + JSON.stringify(library) + ';\n' +
  'export const questions = ' + JSON.stringify(questions) + ';\n');
// Delete ONLY obsolete generated Python bundle paths, verified inside the workspace.
for (const name of ['cloud-functions/api/index.py', 'cloud-functions/quiz_api.py',
  'cloud-functions/requirements.txt', 'cloud-functions/engine', 'cloud-functions/content']) {
  const target = resolve(root, name);
  if (relative(root, target).startsWith('..')) throw new Error('Unexpected bundle path');
  await rm(target, { force: true, recursive: true });
}
console.log('Makers Node.js Blob bundle ready (no database required).');
