import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { catalog, generate, validProduct, validAnswers, publicReport } from './generator.js';
import { decide } from './jev/decide.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const equal = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
const keyPart = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const random = () => randomBytes(32).toString('base64url');

// Best-effort read/modify/write; deliberately no distributed lock or transaction.
// Completed records and quota are committed in the SAME code object. Pointers
// are written first and never confer access unless that authoritative record exists.
export function createApi({ store, secret, adminKey, publicOrigin, production = true, clock = () => Date.now() / 1000, jevApiKey, fetch: fetcher }) {
  if (secret?.length < 40 || !secret || adminKey?.length < 32 || !adminKey || secret.includes('REPLACE') || adminKey.includes('REPLACE')) throw new Error('APP_SECRET >= 40 and ADMIN_KEY >= 32 are required');
  const origin = new URL(publicOrigin).origin;
  if (production && !origin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must be HTTPS');
  const digest = value => createHmac('sha256', secret).update(value).digest('hex');
  const encryptionKey = createHash('sha256').update('encryption:' + secret).digest();
  const encrypt = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  };
  const decrypt = value => {
    const raw = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', encryptionKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(-16));
    return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8');
  };
  const get = key => store.get(key, { type: 'json', consistency: 'strong' });
  const put = (key, value) => store.setJSON(key, value);
  const remaining = code => Math.max(0, 3 - Object.keys(code.completed).length);
  const view = async (attempt, code) => ({ id: attempt.id, product: attempt.product, answers: attempt.answers,
    revision: attempt.revision, result_id: (await get('results/' + digest('result:' + attempt.id)))?.committed?.id || code.completed[attempt.id]?.id || null,
    remaining: remaining(code), expires: attempt.expires });
  async function rate(namespace, id, limit, seconds) {
    const key = 'rates/' + digest(namespace + ':' + id), now = clock();
    let row = await get(key);
    if (!row || row.reset <= now) row = { count: 0, reset: now + seconds };
    row.count++;
    await put(key, row);
    return row.count <= limit;
  }
  async function visitor(request, admin = false) {
    const token = /(?:^|;\s*)quiz_session=([A-Za-z0-9_-]+)/.exec(request.headers.get('cookie') || '')?.[1];
    const row = token ? await get('sessions/' + digest('session:' + token)) : null;
    if (!row || row.expires <= clock()) fail(401, '会话已过期，请重新输入测评码');
    if (admin && row.admin_until <= clock()) fail(403, '请先登录管理端');
    if (!['GET', 'HEAD'].includes(request.method) && !equal(request.headers.get('x-csrf-token'), row.csrf)) fail(403, '页面验证失效，请刷新后重试');
    return row;
  }
  async function owned(request, id) {
    if (!keyPart(id)) fail(404, '未找到你的测评');
    const user = await visitor(request), a = await get('attempts/' + id);
    if (!a || a.visitor !== user.id) fail(404, '未找到你的测评');
    const code = await get('codes/' + a.code);
    if (!code || !code.active) fail(403, '这个测评码已停用');
    return { user, a, code };
  }
  async function storedResult(pointer) {
    if (!pointer) return null;
    if (pointer.committed) return pointer.committed;
    if (pointer.result) {
      const snapshot = await get('results/' + pointer.result);
      if (snapshot?.committed) return snapshot.committed;
    }
    const code = await get('codes/' + pointer.code);
    return code?.completed[pointer.attempt] || null;
  }
  async function route(request, context) {
    const url = new URL(request.url), method = request.method;
    // Handler mode supplies the original path, unlike the old Python framework adapter.
    const path = url.pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const actual = request.headers.get('origin');
      const preview = /\.edgeone\.(dev|app)$/.test(url.hostname) && actual === url.origin;
      if (actual !== origin && !preview) fail(403, '请求来源不匹配');
    }
    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      if (Number(request.headers.get('content-length') || 0) > 16384) fail(413, '请求内容过大');
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 16384) fail(413, '请求内容过大');
      try { body = JSON.parse(raw); } catch { fail(422, '请求格式不正确'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, '请求格式不正确');
    }
    if (method === 'GET' && path === '/api/health') {
      // A real read checks Blob connectivity without persisting a test object.
      await get('system/health');
      return { ok: true, storage: 'makers-blob', result_version: '1.1.0' };
    }
    if (method === 'GET' && path === '/api/catalog') return catalog();
    if (method === 'GET' && path === '/api/session') {
      let token = /(?:^|;\s*)quiz_session=([A-Za-z0-9_-]+)/.exec(request.headers.get('cookie') || '')?.[1];
      let row = token ? await get('sessions/' + digest('session:' + token)) : null;
      if (!row || row.expires <= clock()) {
        token = random();
        row = { id: digest('session:' + token), csrf: random(), expires: clock() + 86400 * 30, admin_until: 0 };
        await put('sessions/' + row.id, row);
        context.cookie = `quiz_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${production ? '; Secure' : ''}`;
      }
      return { csrf: row.csrf, admin: row.admin_until > clock() };
    }
    if (method === 'POST' && (path === '/api/codes/verify' || path === '/api/jev/redeem')) {
      const product = path === '/api/jev/redeem' ? 'jev' : body.product;
      if (!(validProduct(product) || product === 'jev') || typeof body.code !== 'string' || body.code.length > 32) fail(422, '测评码或产品格式不正确');
      const user = await visitor(request);
      if (!await rate('verify-ip', context.ip, 30, 600) || !await rate('verify-user', user.id, 15, 600)) fail(429, '尝试次数较多，请十分钟后再试');
      const clean = body.code.replace(/[- ]/g, '').toUpperCase(), codeKey = digest('code:' + clean);
      const code = await get('codes/' + codeKey);
      if (!code?.active) fail(400, '测评码不正确或已停用');
      if (!remaining(code)) fail(409, '这个测评码的三次机会已经用完');
      const id = digest('grant:' + user.id + ':' + codeKey);
      await put('grants/' + id, { visitor: user.id, code: codeKey });
      if (product === 'jev') {
        user.jev_grant = id;
        await put('sessions/' + user.id, user);
      }
      return { grant_id: id, remaining: remaining(code), remainingUses: remaining(code), product };
    }
    if ((method === 'GET' && path === '/api/jev/credits') || (method === 'POST' && path === '/api/jev/decide')) {
      const user = await visitor(request), grant = user.jev_grant ? await get('grants/' + user.jev_grant) : null;
      if (!grant || grant.visitor !== user.id) fail(401, '请先输入通用测评码');
      let code = await get('codes/' + grant.code);
      if (!code?.active) fail(403, '这个测评码已停用');
      if (method === 'GET') return { status: 'success', remainingUses: remaining(code) };
      if (!keyPart(body.request_key) || body.request_key.length < 16) fail(422, '请求编号不正确，请刷新后重试');
      const input = { mode: body.mode, question: body.question, context: body.context, options: body.options };
      const inputKey = digest('jev-input:' + JSON.stringify(input));
      const id = digest('jev-result:' + grant.code + ':' + user.id + ':' + body.request_key);
      const snapshotKey = 'jev-results/' + id;
      const saved = await get(snapshotKey), old = saved?.committed || code.completed[id];
      if (old) {
        if (old.input_key !== inputKey) fail(409, '请求编号已用于其他问题，请重新提交');
        if (!saved?.committed) await put(snapshotKey, { committed: old });
        return { ...old.decision, remainingUses: remaining(code) };
      }
      if (!remaining(code)) fail(409, '这个测评码的三次机会已经用完');
      const holds = Object.entries(code.holds).filter(([key, hold]) => hold.expires > clock() && !code.completed[key] && key !== id);
      if (Object.keys(code.completed).length + holds.length >= 3) fail(409, '机会已用完或有其他设备正在测评，请稍后重试');
      code.holds = Object.fromEntries(holds);
      code.holds[id] = { visitor: user.id, product: 'jev', expires: clock() + 120 };
      await put('codes/' + grant.code, code);
      const response = await decide(input, { apiKey: jevApiKey, fetch: fetcher });
      code = await get('codes/' + grant.code);
      if (!response.ok) {
        if (code) { delete code.holds[id]; await put('codes/' + grant.code, code); }
        return response;
      }
      if (!code?.active) fail(403, '这个测评码已停用');
      if (code.completed[id]) return { ...code.completed[id].decision, remainingUses: remaining(code) };
      if (!remaining(code)) fail(409, '这个测评码的三次机会已经用完');
      const decision = await response.json();
      code.completed[id] = { id, visitor: user.id, product: 'jev', input_key: inputKey, decision, created: clock() };
      delete code.holds[id];
      // The decision and shared usage commit together; retry repairs snapshot publication.
      await put('codes/' + grant.code, code);
      await put(snapshotKey, { committed: code.completed[id] });
      return { ...decision, remainingUses: remaining(code) };
    }
    if (method === 'POST' && path === '/api/attempts') {
      if (!validProduct(body.product) || !keyPart(body.grant_id)) fail(422, '未知测评或授权格式不正确');
      const user = await visitor(request), grant = await get('grants/' + body.grant_id);
      if (!grant || grant.visitor !== user.id) fail(404, '请先验证测评码');
      const code = await get('codes/' + grant.code);
      if (!code?.active) fail(403, '这个测评码已停用');
      const now = clock();
      const holds = Object.entries(code.holds).filter(([id, hold]) => hold.expires > now && !code.completed[id]);
      for (const [id, hold] of holds) {
        if (hold.visitor === user.id && hold.product === body.product) {
          const a = await get('attempts/' + id);
          if (a) return view(a, code);
        }
      }
      if (Object.keys(code.completed).length + holds.length >= 3) fail(409, '机会已用完或有其他设备正在测评，请稍后重试');
      const a = { id: randomUUID(), visitor: user.id, code: grant.code, product: body.product,
        created: now, expires: now + 3600, answers: {}, revision: 0 };
      await put('attempts/' + a.id, a);
      code.holds = Object.fromEntries(holds);
      code.holds[a.id] = { visitor: user.id, product: body.product, expires: a.expires };
      await put('codes/' + grant.code, code);
      return view(a, code);
    }
    const attemptMatch = /^\/api\/attempts\/([a-zA-Z0-9_-]+)(\/complete)?$/.exec(path);
    if (attemptMatch) {
      const { user, a, code } = await owned(request, attemptMatch[1]);
      if (method === 'GET' && !attemptMatch[2]) return view(a, code);
      if (method === 'PATCH' && !attemptMatch[2]) {
        if (!validAnswers(body.answers) || !Number.isInteger(body.revision) || body.revision < 0) fail(422, '答案格式不正确');
        if (code.completed[a.id] || (await get('results/' + digest('result:' + a.id)))?.committed) fail(409, '这次测评已完成，结果不能改写');
        if (a.expires <= clock()) fail(410, '这次测评已过期，请重新开始');
        if (a.revision !== body.revision) fail(409, '另一页面已更新答案，请刷新以载入最新进度');
        a.answers = body.answers; a.revision++; a.expires = Math.min(clock() + 3600, a.created + 86400);
        // Extend the live reservation before publishing the draft.
        code.holds[a.id] = { visitor: user.id, product: a.product, expires: a.expires };
        await put('codes/' + a.code, code);
        await put('attempts/' + a.id, a);
        return view(a, code);
      }
      if (method === 'POST' && attemptMatch[2]) {
        if (!validAnswers(body.answers, true)) fail(422, '请完成全部24题，选项仅允许A、B、C、D');
        const report = generate(a.product, body.answers), id = digest('result:' + a.id);
        const saved = await get('results/' + id), old = saved?.committed || code.completed[a.id];
        if (old) {
          if (old.report.answer_key !== report.answer_key) fail(409, '本次测评已提交，请开始新一轮测评');
          // Repair a snapshot publication that failed after quota was already saved.
          if (!saved?.committed) await put('results/' + id, { code: a.code, attempt: a.id, committed: old });
          return { result_id: old.id, remaining: remaining(code) };
        }
        if (a.expires <= clock()) fail(410, '测评已过期，请重新开始；本次未扣次数');
        if (!remaining(code)) fail(409, '机会已经用完');
        const share = digest('share-token:' + a.id);
        const pointer = { code: a.code, attempt: a.id };
        // Failed pointer writes leave no charge; retries use exactly the same IDs.
        await put('results/' + id, pointer);
        await put('shares/' + digest('share:' + share), { ...pointer, result: id });
        code.completed[a.id] = { id, visitor: user.id, report, answers: body.answers, share_encrypted: encrypt(share), created: clock() };
        delete code.holds[a.id];
        // Sole authoritative completion write: report + usage entry together.
        await put('codes/' + a.code, code);
        // Preserve successful reports independently of later concurrent code rewrites.
        // A failure here is recovered by the same attempt's next complete request.
        await put('results/' + id, { ...pointer, committed: code.completed[a.id] });
        return { result_id: id, remaining: remaining(code) };
      }
    }
    const resultMatch = /^\/api\/results\/([a-zA-Z0-9_-]+)(\/share)?$/.exec(path);
    if (resultMatch) {
      const user = await visitor(request), row = await storedResult(await get('results/' + resultMatch[1]));
      if (!row || row.visitor !== user.id) fail(404, '未找到你的结果');
      const revoked = await get('revoked/' + row.id);
      if (method === 'GET' && !resultMatch[2]) return { report: row.report, share_url: revoked ? null : origin + '/s/' + decrypt(row.share_encrypted) };
      if (method === 'DELETE' && resultMatch[2]) {
        // Separate tombstone cannot be undone by a stale code object overwrite.
        await put('revoked/' + row.id, { at: clock() }); return { ok: true };
      }
    }
    const shareMatch = /^\/api\/share\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
    if (method === 'GET' && shareMatch) {
      const row = await storedResult(await get('shares/' + digest('share:' + shareMatch[1])));
      if (!row || await get('revoked/' + row.id)) fail(404, '分享链接无效或已取消');
      return { report: publicReport(row.report), share_url: origin + '/s/' + shareMatch[1] };
    }
    if (method === 'POST' && path === '/api/admin/login') {
      const user = await visitor(request);
      if (!await rate('admin-login', context.ip, 5, 900)) fail(429, '请十五分钟后再试');
      if (typeof body.key !== 'string' || !equal(body.key, adminKey)) fail(403, '管理密钥不正确');
      user.admin_until = clock() + 3600;
      await put('sessions/' + user.id, user); return { ok: true };
    }
    if (method === 'POST' && path === '/api/admin/logout') {
      const user = await visitor(request); user.admin_until = 0;
      await put('sessions/' + user.id, user); return { ok: true };
    }
    if (method === 'GET' && path === '/api/admin/batches') {
      await visitor(request, true);
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && cursor.length > 2048) fail(422, '分页参数不正确');
      const listing = await store.list({ prefix: 'batches/', paginate: false, cursor, consistency: 'strong' });
      const batches = [];
      for (let i = 0; i < listing.blobs.length; i += 10) {
        const part = await Promise.all(listing.blobs.slice(i, i + 10).map(async item => {
          const b = await get(item.key);
          return b ? { id: b.id, count: b.count, ready: !!b.ready, created: b.created ?? b.expires - 86400 } : null;
        }));
        batches.push(...part.filter(Boolean));
      }
      batches.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
      return { batches, next_cursor: listing.cursor || null };
    }
    const batchCodesMatch = /^\/api\/admin\/batches\/([a-zA-Z0-9_-]+)\/codes$/.exec(path);
    if (method === 'GET' && batchCodesMatch) {
      await visitor(request, true);
      const batch = await get('batches/' + batchCodesMatch[1]);
      if (!batch) fail(404, '未找到这个批次');
      if (!batch.ready) fail(409, '这个批次尚未完成，请使用原生成请求重试');
      const values = JSON.parse(decrypt(batch.encrypted)), codes = [];
      for (let i = 0; i < values.length; i += 10) {
        codes.push(...await Promise.all(values.slice(i, i + 10).map(async value => {
          const code = await get('codes/' + digest('code:' + value.replaceAll('-', '')));
          const used = code ? Object.keys(code.completed).length : 0;
          const left = code ? remaining(code) : 0;
          const status = !code ? 'missing' : !code.active ? 'disabled' : !left ? 'exhausted' : used ? 'partial' : 'unused';
          return { code: value, used, remaining: left, status };
        })));
      }
      return { batch: { id: batch.id, count: batch.count, created: batch.created ?? batch.expires - 86400 }, codes,
        summary: { total: codes.length, available: codes.filter(c => ['unused', 'partial'].includes(c.status)).length,
          exhausted: codes.filter(c => c.status === 'exhausted').length, used: codes.reduce((sum, c) => sum + c.used, 0) } };
    }
    if (method === 'POST' && path === '/api/admin/batches') {
      await visitor(request, true);
      const count = body.count ?? 100;
      if (!Number.isInteger(count) || count < 1 || count > 100 || typeof body.request_key !== 'string' || body.request_key.length < 16 || body.request_key.length > 80) fail(422, '批次参数不正确');
      const id = digest('batch:' + body.request_key), key = 'batches/' + id;
      let batch = await get(key);
      if (batch && batch.count !== count) fail(409, '请求编号已用于其他批次');
      if (!batch) {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const codes = Array.from({ length: count }, (_, i) => {
          const bytes = createHmac('sha256', secret).update('batch-code:' + body.request_key + ':' + i).digest();
          const raw = Array.from(bytes.subarray(0, 16), byte => alphabet[byte & 31]).join('');
          return raw.match(/.{4}/g).join('-');
        });
        batch = { id, count, encrypted: encrypt(JSON.stringify(codes)), created: clock(), expires: clock() + 86400, ready: false };
        await put(key, batch);
      }
      if (!batch.ready) {
        // Resume failed initialization, never reset an existing code's usage.
        const codes = JSON.parse(decrypt(batch.encrypted));
        for (let i = 0; i < codes.length; i += 10) {
          await Promise.all(codes.slice(i, i + 10).map(async value => {
            const codeKey = 'codes/' + digest('code:' + value.replaceAll('-', ''));
            if (!await get(codeKey)) await put(codeKey, { active: true, completed: {}, holds: {}, batch: id });
          }));
        }
        batch.ready = true; await put(key, batch);
      }
      return { id: batch.id, count: batch.count, expires: batch.expires };
    }
    const exportMatch = /^\/api\/admin\/batches\/([a-zA-Z0-9_-]+)\/export$/.exec(path);
    if (method === 'GET' && exportMatch) {
      await visitor(request, true);
      const batch = await get('batches/' + exportMatch[1]);
      if (!batch?.ready) fail(404, '未找到可导出的批次');
      const codes = JSON.parse(decrypt(batch.encrypted));
      return new Response('\ufeff测评码,测评,可用次数\r\n' + codes.map(c => c + ',四款测评及JEV通用（合计3次）,3\r\n').join(''), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quiz-codes-all-${batch.id}.csv"` },
      });
    }
    fail(404, '接口不存在');
  }
  return async (request, context = {}) => {
    const state = { ip: context.clientIp || 'unknown' };
    let response;
    try {
      const data = await route(request, state);
      response = data instanceof Response ? data : Response.json(data);
    } catch (error) {
      // Never expose storage credentials, signed URLs or raw exception messages.
      response = Response.json({ detail: error instanceof HttpError ? error.message : '存储服务暂时不可用，请稍后重试；失败未确认时可使用原测评重试。' }, { status: error instanceof HttpError ? error.status : 503 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    if (state.cookie) response.headers.set('Set-Cookie', state.cookie);
    return response;
  };
}
