import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createApi } from '../cloud-functions/_lib/api.js';
import { canonical, generate } from '../cloud-functions/_lib/generator.js';

const secret = 'blob-test-secret-' + 'a'.repeat(48), adminKey = 'blob-test-admin-' + 'b'.repeat(32);
const origin = 'https://quiz.example.com';
const answers = option => Object.fromEntries(Array.from({ length: 24 }, (_, i) => ['Q' + String(i + 1).padStart(2, '0'), option]));
function setup() {
  const data = new Map(); let now = 100000, failure;
  const store = {
    async list({ prefix, cursor }) {
      const keys = [...data.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = Number(cursor || 0), end = offset + 2;
      return { blobs: keys.slice(offset, end).map(key => ({ key })), cursor: end < keys.length ? String(end) : undefined };
    },
    async get(key) { return structuredClone(data.get(key) || null); },
    async setJSON(key, value) {
      if (failure?.(key, value)) { failure = null; throw new Error('Injected storage failure'); }
      data.set(key, structuredClone(value));
    },
  };
  const handler = createApi({ store, secret, adminKey, publicOrigin: origin, clock: () => now });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, extra = {}) {
        const response = await handler(new Request(origin + '/api' + path, { method,
          headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { clientIp: 'test' });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const result = { status: response.status, headers: response.headers };
        if (response.headers.get('content-type').includes('application/json')) {
          result.data = await response.json(); if (path === '/session' && result.data.csrf) csrf = result.data.csrf;
        } else result.text = await response.text();
        return result;
      },
    };
  }
  const user = client();
  return { handler, user, client, data, advance: seconds => { now += seconds; }, failNext: pred => { failure = pred; } };
}
async function batch(h, count = 100, requestKey = randomUUID()) {
  assert.equal((await h.user.call('/session')).status, 200);
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey })).status, 200);
  const response = await h.user.call('/admin/batches', 'POST', { count, request_key: requestKey });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const csv = await h.user.call('/admin/batches/' + response.data.id + '/export');
  return { ...response.data, codes: csv.text.trim().split(/\r?\n/).slice(1).map(r => r.split(',')[0]), requestKey };
}
async function start(user, code, product = 'past') {
  const verified = await user.call('/codes/verify', 'POST', { code, product });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  const begun = await user.call('/attempts', 'POST', { grant_id: verified.data.grant_id, product });
  assert.equal(begun.status, 200, JSON.stringify(begun.data)); return begun.data;
}

test('100 universal codes, stable batch replay, export authentication, no plaintext code storage', async () => {
  const h = setup(), b = await batch(h);
  assert.equal(b.codes.length, 100); assert.equal(new Set(b.codes).size, 100);
  const replay = await h.user.call('/admin/batches', 'POST', { count: 100, request_key: b.requestKey });
  assert.equal(replay.data.id, b.id);
  assert.equal([...h.data.keys()].filter(k => k.startsWith('codes/')).length, 100);
  assert.ok(!JSON.stringify([...h.data.values()]).includes(b.codes[0]));
  assert.equal((await h.user.call('/admin/batches', 'POST', { count: 99, request_key: b.requestKey })).status, 409);
  const stranger = h.client(); await stranger.call('/session');
  assert.equal((await stranger.call('/admin/batches/' + b.id + '/export')).status, 403);
});
test('one code completes past, next and cat, rejects fourth; retries do not consume', async () => {
  const h = setup(), b = await batch(h, 1);
  for (const [i, product] of ['past', 'next', 'cat'].entries()) {
    const a = await start(h.user, b.codes[0], product);
    const done = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
    assert.equal(done.status, 200); assert.equal(done.data.remaining, 2 - i);
    assert.deepEqual((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') })).data, done.data);
    assert.equal((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('A') })).status, 409);
    const result = await h.user.call('/results/' + done.data.result_id);
    assert.equal(result.data.report.product, product);
  }
  assert.equal((await h.user.call('/codes/verify', 'POST', { code: b.codes[0], product: 'end' })).status, 409);
});
test('draft back/edit, resume same product, separate products, holds and revision conflicts', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  assert.equal((await start(h.user, b.codes[0])).id, a.id);
  const updated = await h.user.call('/attempts/' + a.id, 'PATCH', { answers: { Q01: 'A' }, revision: 0 });
  assert.equal(updated.data.remaining, 3); assert.equal(updated.data.revision, 1);
  assert.equal((await h.user.call('/attempts/' + a.id, 'PATCH', { answers: { Q01: 'D' }, revision: 0 })).status, 409);
  const edit = await h.user.call('/attempts/' + a.id, 'PATCH', { answers: { Q01: 'D' }, revision: 1 });
  assert.deepEqual(edit.data.answers, { Q01: 'D' });
  const next = await start(h.user, b.codes[0], 'next'), cat = await start(h.user, b.codes[0], 'cat');
  assert.notEqual(next.id, cat.id);
  const v = await h.user.call('/codes/verify', 'POST', { code: b.codes[0], product: 'end' });
  assert.equal((await h.user.call('/attempts', 'POST', { grant_id: v.data.grant_id, product: 'end' })).status, 409);
  assert.deepEqual((await h.user.call('/attempts/' + a.id)).data.answers, { Q01: 'D' });
});
test('invalid answers, unknown product and expired attempt never consume', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  assert.equal((await h.user.call('/codes/verify', 'POST', { code: b.codes[0], product: 'unknown' })).status, 422);
  assert.equal((await h.user.call('/attempts/' + a.id, 'PATCH', { answers: { Q25: 'A' }, revision: 0 })).status, 422);
  assert.equal((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: { Q01: 'A' } })).status, 422);
  h.advance(3601);
  assert.equal((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') })).status, 410);
  assert.equal((await start(h.user, b.codes[0], 'end')).remaining, 3);
});
test('private results belong to owner; public share has no answers/scores/evidence; revocation persists', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  const done = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  const result = await h.user.call('/results/' + done.data.result_id), stranger = h.client(); await stranger.call('/session');
  assert.equal((await stranger.call('/attempts/' + a.id)).status, 404);
  assert.equal((await stranger.call('/results/' + done.data.result_id)).status, 404);
  const token = result.data.share_url.split('/').pop(), shared = await stranger.call('/share/' + token);
  assert.equal(shared.status, 200);
  for (const key of ['scores', 'evidence', 'answer_key', 'answers']) assert.ok(!Object.hasOwn(shared.data.report, key));
  assert.equal((await stranger.call('/results/' + done.data.result_id + '/share', 'DELETE')).status, 404);
  assert.equal((await h.user.call('/results/' + done.data.result_id + '/share', 'DELETE')).status, 200);
  assert.equal((await stranger.call('/share/' + token)).status, 404);
  assert.equal((await h.user.call('/results/' + done.data.result_id)).data.share_url, null);
});
test('CSRF and Origin enforced, admin logout and rate limiting', async () => {
  const h = setup(); await h.user.call('/session');
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey }, { 'X-CSRF-Token': '' })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await h.user.call('/admin/login', 'POST', { key: 'bad' })).status, 403);
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey })).status, 429);
  h.advance(901);
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey })).status, 200);
  await h.user.call('/admin/logout', 'POST', {});
  assert.equal((await h.user.call('/admin/batches', 'POST', { count: 1, request_key: randomUUID() })).status, 403);
});
test('failed completion write does not charge or expose orphan pointers; retry recovers', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  h.failNext((key, value) => key.startsWith('codes/') && Object.keys(value.completed).length > 0);
  assert.equal((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') })).status, 503);
  assert.equal((await h.user.call('/attempts/' + a.id)).data.remaining, 3);
  const id = [...h.data.keys()].find(k => k.startsWith('results/')).slice(8);
  assert.equal((await h.user.call('/results/' + id)).status, 404);
  const retry = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  assert.equal(retry.data.result_id, id); assert.equal(retry.data.remaining, 2);
});
test('partial batch failure resumes with same codes and never resets existing usage', async () => {
  const h = setup(); await h.user.call('/session'); await h.user.call('/admin/login', 'POST', { key: adminKey });
  const request_key = randomUUID();
  h.failNext(key => key.startsWith('codes/'));
  assert.equal((await h.user.call('/admin/batches', 'POST', { count: 20, request_key })).status, 503);
  const retried = await h.user.call('/admin/batches', 'POST', { count: 20, request_key }); assert.equal(retried.status, 200);
  assert.equal([...h.data.keys()].filter(k => k.startsWith('codes/')).length, 20);
  const csv = await h.user.call('/admin/batches/' + retried.data.id + '/export');
  const code = csv.text.trim().split(/\r?\n/)[1].split(',')[0], a = await start(h.user, code);
  await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  await h.user.call('/admin/batches', 'POST', { count: 20, request_key });
  assert.equal((await h.user.call('/codes/verify', 'POST', { code, product: 'cat' })).data.remaining, 2);
});
test('snapshot publication failure after quota commit recovers without a second charge', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  h.failNext((key, value) => key.startsWith('results/') && value.committed);
  const failed = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  assert.equal(failed.status, 503);
  assert.equal((await h.user.call('/attempts/' + a.id)).data.remaining, 2);
  const retry = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  assert.equal(retry.status, 200); assert.equal(retry.data.remaining, 2);
  assert.equal((await h.user.call('/results/' + retry.data.result_id)).status, 200);
});
test('published result survives a later stale quota object overwrite', async () => {
  const h = setup(), b = await batch(h, 1), a = await start(h.user, b.codes[0]);
  const done = await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') });
  const before = await h.user.call('/results/' + done.data.result_id);
  // Simulate the accepted lost-update behavior of read/modify/write under concurrency.
  const code = [...h.data.entries()].find(([key]) => key.startsWith('codes/'))[1];
  code.completed = {};
  const after = await h.user.call('/results/' + done.data.result_id);
  assert.deepEqual(after.data, before.data);
  assert.equal((await h.user.call('/attempts/' + a.id)).data.result_id, done.data.result_id);
  const token = after.data.share_url.split('/').pop();
  assert.equal((await h.user.call('/share/' + token)).status, 200);
  assert.equal((await h.user.call('/attempts/' + a.id, 'PATCH', { answers: { Q01: 'A' }, revision: 0 })).status, 409);
});
test('storage exceptions are JSON without credential leakage; health checks real reads', async () => {
  const handler = createApi({ store: { get: async () => { throw new Error('secret credential'); } }, secret, adminKey, publicOrigin: origin });
  const result = await handler(new Request(origin + '/api/health'));
  assert.equal(result.status, 503); assert.match(result.headers.get('content-type'), /application\/json/);
  assert.ok(!(await result.text()).includes('secret credential'));
});
test('Node algorithm matches Python frozen reference, including all 96 variants and boundary modes', () => {
  const script = `import json,random\nfrom engine.generator import generate\nr=random.Random(130)\ncases=[]\nfor p in ['past','next','cat','end']:\n for code in ['---','--+','-+-','-++','+--','+-+','++-','+++']:\n  for d in ['A','B','D']:\n   opts=''.join(('A' if sign=='-' else 'D')*6 for sign in code)+d*6\n   a={f'Q{i+1:02d}':v for i,v in enumerate(opts)}\n   cases.append([p,a,generate(p,a)])\n for j in range(120):\n  a={f'Q{i:02d}':r.choice('ABCD') for i in range(1,25)}\n  cases.append([p,a,generate(p,a)])\n a={f'Q{i:02d}':('A' if i%2 else 'D') for i in range(1,25)}\n cases.append([p,a,generate(p,a)])\nprint(json.dumps(cases,ensure_ascii=False))`;
  const python = process.env.PYTHON || (process.platform === 'win32' ? '.venv/Scripts/python.exe' : 'python');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const variants = new Set();
  for (const [product, a, expected] of JSON.parse(result.stdout)) {
    const actual = generate(product, a);
    assert.equal(canonical(actual), canonical(expected), product + ': ' + JSON.stringify(a));
    assert.equal(canonical(generate(product, structuredClone(a))), canonical(actual));
    actual.cards.forEach(c => variants.add(c.variant_id));
  }
  assert.equal(variants.size, 96);
});
test('deployment uses tracked Node catch-all and SDK, with no generated Python dependency', async () => {
  const config = JSON.parse(await readFile('edgeone.json', 'utf8'));
  assert.equal(config.buildCommand, 'npm run build');
  const entry = await readFile('cloud-functions/api/[[default]].js', 'utf8');
  assert.match(entry, /onRequest/); assert.match(entry, /@edgeone\/pages-blob/);
  assert.ok(!entry.includes('DATABASE_URL'));
});


test('history authentication, pagination and metadata', async () => {
  const h = setup(), b = await batch(h, 3), stranger = h.client();
  await stranger.call('/session');
  for (const path of ['/admin/batches', '/admin/batches/' + b.id + '/codes']) {
    const response = await stranger.call(path);
    assert.equal(response.status, 403); assert.ok(!JSON.stringify(response.data).includes(b.codes[0]));
  }
  await batch(h, 1); await batch(h, 2);
  const first = await h.user.call('/admin/batches');
  assert.equal(first.status, 200); assert.equal(first.data.batches.length, 2);
  const second = await h.user.call('/admin/batches?cursor=' + first.data.next_cursor);
  assert.equal(second.data.batches.length, 1); assert.equal(second.data.next_cursor, null);
  const all = [...first.data.batches, ...second.data.batches];
  assert.equal(new Set(all.map(row => row.id)).size, 3);
  assert.deepEqual(all.map(row => row.count).sort(), [1, 2, 3]);
  assert.ok(all.every(row => row.created === 100000 && row.ready && !row.encrypted));
  assert.equal((await h.user.call('/admin/batches?cursor=' + 'x'.repeat(2049))).status, 422);
});
test('legacy batches remain viewable and exportable beyond 24 hours', async () => {
  const h = setup(), b = await batch(h, 2);
  delete h.data.get('batches/' + b.id).created;
  h.advance(86401); await h.user.call('/session'); await h.user.call('/admin/login', 'POST', { key: adminKey });
  const detail = await h.user.call('/admin/batches/' + b.id + '/codes');
  assert.equal(detail.status, 200); assert.deepEqual(detail.data.codes.map(row => row.code), b.codes);
  assert.equal(detail.data.batch.created, 100000);
  assert.deepEqual(detail.data.summary, { total: 2, available: 2, exhausted: 0, used: 0 });
  assert.equal((await h.user.call('/admin/batches/' + b.id + '/export')).status, 200);
});
test('code list reflects usage without mutating quota or exposing answers', async () => {
  const h = setup(), b = await batch(h, 3);
  for (const [code, products] of [[b.codes[0], ['past']], [b.codes[1], ['past', 'next', 'cat']]]) {
    for (const product of products) {
      const a = await start(h.user, code, product);
      assert.equal((await h.user.call('/attempts/' + a.id + '/complete', 'POST', { answers: answers('D') })).status, 200);
    }
  }
  const before = JSON.stringify([...h.data]);
  const response = await h.user.call('/admin/batches/' + b.id + '/codes');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.codes.map(({ used, remaining, status }) => ({ used, remaining, status })), [
    { used: 1, remaining: 2, status: 'partial' }, { used: 3, remaining: 0, status: 'exhausted' }, { used: 0, remaining: 3, status: 'unused' },
  ]);
  assert.deepEqual(response.data.summary, { total: 3, available: 2, exhausted: 1, used: 4 });
  assert.ok(!JSON.stringify(response.data).includes('answers')); assert.equal(JSON.stringify([...h.data]), before);
  assert.equal((await h.user.call('/admin/batches/missing/codes')).status, 404);
  h.data.get('batches/' + b.id).ready = false;
  assert.equal((await h.user.call('/admin/batches/' + b.id + '/codes')).status, 409);
});
test('disabled and missing codes are excluded from availability', async () => {
  const h = setup(), b = await batch(h, 2), keys = [...h.data.keys()].filter(key => key.startsWith('codes/'));
  h.data.get(keys[0]).active = false; h.data.delete(keys[1]);
  const response = await h.user.call('/admin/batches/' + b.id + '/codes');
  assert.deepEqual(response.data.codes.map(row => row.status), ['disabled', 'missing']); assert.equal(response.data.summary.available, 0);
});
