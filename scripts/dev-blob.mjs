// Local-only Blob equivalent for browser checks; never used by the cloud entry.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApi } from '../cloud-functions/_lib/api.js';
const root = resolve(import.meta.dirname, '..'), folder = resolve(root, '.blob-local');
await mkdir(folder, { recursive: true });
const secretsPath = resolve(folder, 'secrets.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretsPath, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  let old;
  try { old = JSON.parse(await readFile(resolve(root, 'local-secrets.json'), 'utf8')); } catch {}
  secrets = { secret: randomBytes(48).toString('base64url'), admin: old?.admin || randomBytes(32).toString('base64url') };
  await writeFile(secretsPath, JSON.stringify(secrets));
}
const store = {
  async get(key) {
    try { return JSON.parse(await readFile(resolve(folder, key + '.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  },
  async setJSON(key, value) {
    const file = resolve(folder, key + '.json');
    if (!file.startsWith(folder + '\\') && !file.startsWith(folder + '/')) throw new Error('Invalid local key');
    await mkdir(resolve(file, '..'), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(value)); await rename(temp, file);
  },
};
const port = Number(process.env.PORT || 8001), origin = 'http://127.0.0.1:' + port;
const api = createApi({ store, secret: secrets.secret, adminKey: secrets.admin, publicOrigin: origin, production: false });
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const method = req.method;
      const response = await api(new Request(url, { method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(parts) } : {}) }), { clientIp: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      const dist = resolve(root, 'web/dist');
      const file = url.pathname.startsWith('/assets/') ? resolve(dist, '.' + url.pathname) : resolve(dist, 'index.html');
      if (!file.startsWith(dist)) { res.writeHead(404); res.end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    }
  } catch { res.writeHead(500); res.end('Local server error'); }
}).listen(port, '127.0.0.1', () => console.log('Local Blob preview:', origin));
