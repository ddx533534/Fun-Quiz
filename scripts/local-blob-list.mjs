import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export function localBlobList(folder) {
  return async ({ prefix = '', cursor, paginate = true } = {}) => {
    const keys = [];
    async function walk(dir, relative = '') {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const key = relative + item.name;
        if (item.isDirectory()) await walk(resolve(dir, item.name), key + '/');
        else if (item.isFile() && key.endsWith('.json') && key.startsWith(prefix)) keys.push(key.slice(0, -5));
      }
    }
    await walk(folder); keys.sort();
    const offset = Number(cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid cursor');
    const end = paginate ? keys.length : offset + 50;
    return { blobs: keys.slice(offset, end).map(key => ({ key, etag: 'local' })), cursor: end < keys.length ? String(end) : undefined };
  };
}
