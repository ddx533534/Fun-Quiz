import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApi } from '../cloud-functions/_lib/api.js';
import { apiUrl, sessionUrl } from '../jev/src/api.js';

const origin = 'https://quiz.example';
const input = { mode: 'whether', question: '周末要不要出门？', context: '天气很好，今天有空。' };
const adminKey = 'test-admin-' + 'a'.repeat(40);
function setup({ apiKey = 'test-key', upstream } = {}) {
  const data = new Map(); let calls = 0, failure;
  const handler = createApi({
    store: {
      get: async key => structuredClone(data.get(key) ?? null),
      setJSON: async (key, value) => {
        if (failure?.(key, value)) { failure = null; throw new Error('private credentials'); }
        data.set(key, structuredClone(value));
      },
    },
    secret: 'test-secret-' + 'b'.repeat(48), adminKey, publicOrigin: origin,
    jevApiKey: apiKey,
    fetch: async (...args) => {
      calls++;
      return upstream ? upstream(...args) : Response.json({ answers: { best_option: {
        choice: 'option_1', confidence: 0.9, probabilities: { option_1: 0.8, option_2: 0.2 },
      } } });
    },
  });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, extra = {}) {
        const response = await handler(new Request(origin + '/api' + path, {
          method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...extra },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }));
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const result = { status: response.status, headers: response.headers };
        if (response.headers.get('content-type').includes('application/json')) {
          result.data = await response.json();
          if (path === '/session' && result.data.csrf) csrf = result.data.csrf;
        } else result.text = await response.text();
        return result;
      },
    };
  }
  return { client, user: client(), data, calls: () => calls, failNext: predicate => { failure = predicate; } };
}
async function batch(h) {
  await h.user.call('/session');
  assert.equal((await h.user.call('/admin/login', 'POST', { key: adminKey })).status, 200);
  const r = await h.user.call('/admin/batches', 'POST', { count: 2, request_key: randomUUID() });
  assert.equal(r.status, 200);
  const csv = await h.user.call('/admin/batches/' + r.data.id + '/export');
  assert.match(csv.text, /四款测评及JEV通用/);
  return csv.text.trim().split(/\r?\n/).slice(1).map(row => row.split(',')[0]);
}
async function redeem(h) {
  const [code] = await batch(h);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code })).status, 200);
  return code;
}
const decision = (user, key = randomUUID(), values = input) => user.call('/jev/decide', 'POST', { ...values, request_key: key });

test('one admin-generated code shares three uses across quiz and JEV', async () => {
  const h = setup(), code = await redeem(h);
  const verified = await h.user.call('/codes/verify', 'POST', { code, product: 'past' });
  const attempt = await h.user.call('/attempts', 'POST', { product: 'past', grant_id: verified.data.grant_id });
  const answers = Object.fromEntries(Array.from({ length: 24 }, (_, i) => ['Q' + String(i + 1).padStart(2, '0'), 'A']));
  assert.equal((await h.user.call('/attempts/' + attempt.data.id + '/complete', 'POST', { answers })).data.remaining, 2);
  const key = randomUUID();
  assert.equal((await decision(h.user, key)).data.remainingUses, 1);
  assert.equal((await decision(h.user, key)).data.remainingUses, 1);
  assert.equal(h.calls(), 1);
  const second = h.client(); await second.call('/session');
  assert.equal((await second.call('/jev/credits')).status, 401);
  assert.equal((await second.call('/jev/redeem', 'POST', { code })).data.remainingUses, 1);
  assert.equal((await decision(second)).data.remainingUses, 0);
  assert.equal((await h.user.call('/jev/credits')).data.remainingUses, 0);
  assert.equal((await decision(h.user)).status, 409);
  assert.equal((await h.user.call('/codes/verify', 'POST', { code, product: 'cat' })).status, 409);
  assert.equal((await decision(h.user, key)).status, 200);
  assert.equal(h.calls(), 2);
  const batchId = [...h.data.entries()].find(([path]) => path.startsWith('batches/'))[1].id;
  const admin = await h.user.call('/admin/batches/' + batchId + '/codes');
  assert.equal(admin.status, 200);
  const row = admin.data.codes.find(row => row.code === code);
  assert.equal(row.used, 3);
  assert.equal(row.remaining, 0);
  assert.equal(row.status, 'exhausted');
});

test('JEV uses shared CSRF, Origin and code records; old generation endpoint is gone', async () => {
  const h = setup(), [code] = await batch(h);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code: 'ABCD-EFGH' })).status, 400);
  assert.equal((await h.user.call('/jev/admin/codes', 'POST', { count: 1 })).status, 404);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code })).status, 200);
  assert.equal((await h.user.call('/jev/redeem', 'POST', { code })).data.remainingUses, 3);
});

test('invalid input, upstream failure and missing configuration preserve shared uses', async () => {
  for (const config of [{}, { upstream: async () => new Response('', { status: 500 }) }, { apiKey: '' }]) {
    const h = setup(config); await redeem(h);
    assert.equal((await decision(h.user, randomUUID(), { ...input, question: '' })).status, 400);
    if (config.upstream) assert.equal((await decision(h.user)).status, 502);
    if (config.apiKey === '') assert.equal((await decision(h.user)).status, 503);
    assert.equal((await h.user.call('/jev/credits')).data.remainingUses, 3);
  }
});

test('choice labels and input-bound retries; failed snapshot repair does not charge twice', async () => {
  const h = setup(); await redeem(h);
  const key = randomUUID(), choice = { ...input, mode: 'choice', options: ['公园', '商场', '书店', '咖啡馆'] };
  h.failNext(path => path.startsWith('jev-results/'));
  const failed = await decision(h.user, key, choice);
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.data).includes('private credentials'), false);
  const retry = await decision(h.user, key, choice);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.remainingUses, 2);
  assert.equal(retry.data.selectedOptionLabel, '公园');
  assert.deepEqual(retry.data.options.map(option => option.label), choice.options);
  assert.equal(h.calls(), 1);
  assert.equal((await decision(h.user, key, { ...choice, question: '另一个问题' })).status, 409);
  assert.equal((await decision(h.user, randomUUID(), { ...choice, options: ['公园', '公园'] })).status, 400);
});

test('failed authoritative code write does not debit JEV usage', async () => {
  const h = setup(); await redeem(h);
  const key = randomUUID();
  h.failNext((path, row) => path.startsWith('codes/') && Object.keys(row.completed).length > 0);
  assert.equal((await decision(h.user, key)).status, 503);
  assert.equal((await h.user.call('/jev/credits')).data.remainingUses, 3);
  assert.equal((await decision(h.user, key)).data.remainingUses, 2);
});

test('JEV respects quiz reservations before invoking the paid upstream', async () => {
  const h = setup(), code = await redeem(h);
  for (const product of ['past', 'next', 'cat']) {
    const grant = await h.user.call('/codes/verify', 'POST', { code, product });
    assert.equal((await h.user.call('/attempts', 'POST', { product, grant_id: grant.data.grant_id })).status, 200);
  }
  assert.equal((await decision(h.user)).status, 409);
  assert.equal(h.calls(), 0);
});

test('JEV session and decision requests retain EdgeOne preview credentials', () => {
  const page = 'https://x.edgeone.app/quiz/jev?eo_token=abc&eo_time=123';
  assert.equal(apiUrl('/credits', page), '/api/jev/credits?eo_token=abc&eo_time=123');
  assert.equal(sessionUrl(page), '/api/session?eo_token=abc&eo_time=123');
  assert.equal(apiUrl('/credits', 'https://quiz.example/quiz/jev?eo_token=abc'), '/api/jev/credits');
});

test('JEV deployment rewrites entry pages without capturing scripts, styles or favicon', async () => {
  const config = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'));
  const routes = config.rewrites.filter(rule => rule.source.startsWith('/quiz/jev'));
  const matches = (source, path) => new RegExp('^' + source.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(path);
  for (const page of ['/quiz/jev', '/quiz/jev/']) {
    assert.equal(routes.find(rule => matches(rule.source, page))?.destination, '/quiz/jev/index.html');
  }
  for (const asset of ['/quiz/jev/assets/app.js', '/quiz/jev/assets/app.css', '/quiz/jev/favicon.svg']) {
    assert.equal(routes.some(rule => matches(rule.source, asset)), false, asset + ' must remain a static asset');
  }
  for (const legacy of ['/jev', '/jev/']) {
    assert.equal(config.redirects.find(rule => rule.source === legacy)?.destination, '/quiz/jev');
  }
});
