import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const { apiUrl, siteUrl, readApiResponse } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);
const preview = 'https://quiz.edgeone.dev/?eo_token=test-token&eo_time=123';
assert.equal(apiUrl('/session', preview), '/api/session?eo_token=test-token&eo_time=123');
assert.equal(siteUrl('/quiz/cat', preview), '/quiz/cat?eo_token=test-token&eo_time=123');
const moved = new URL(siteUrl('/quiz/cat', preview), preview).href;
assert.equal(apiUrl('/catalog', moved), '/api/catalog?eo_token=test-token&eo_time=123');
assert.equal(apiUrl('/session', 'https://quiz.moting.com.cn/?eo_token=ignore&eo_time=123'), '/api/session');
assert.throws(() => siteUrl('https://other.example/steal', preview), /same-origin/);
await assert.rejects(readApiResponse(new Response('<!doctype html>', {
  status: 401, headers: { 'Content-Type': 'text/html' },
})), /重新生成链接/);
await assert.rejects(readApiResponse(new Response('<!doctype html>', {
  headers: { 'Content-Type': 'text/html' },
})), /后端函数部署/);
await assert.rejects(readApiResponse(new Response('broken', {
  headers: { 'Content-Type': 'application/json' },
})), /返回异常/);
assert.deepEqual(await readApiResponse(Response.json({ products: [] })), { products: [] });
await assert.rejects(readApiResponse(Response.json({ detail: '测评码已用完' }, { status: 409 })), /测评码已用完/);
console.log('API preview authorization and response handling checks passed.');
