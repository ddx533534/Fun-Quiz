import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const origin = process.env.E2E_ORIGIN || 'http://127.0.0.1:8001';
const browser = await chromium.launch({ headless: true,
  ...(process.env.E2E_BROWSER_PATH ? { executablePath: process.env.E2E_BROWSER_PATH } : {}),
});
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const session = await (await context.request.get(origin + '/api/session')).json();
    const headers = { Origin: origin, 'X-CSRF-Token': session.csrf };
    const login = await context.request.post(origin + '/api/admin/login', { headers, data: { key: process.env.E2E_ADMIN_KEY } });
    assert.equal(login.status(), 200);
    const batch = await (await context.request.post(origin + '/api/admin/batches', {
      headers, data: { count: 1, request_key: randomUUID() },
    })).json();
    const csv = await (await context.request.get(origin + '/api/admin/batches/' + batch.id + '/export')).text();
    const code = csv.trim().split(/\r?\n/)[1].split(',')[0];
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().includes('/jev/assets/') && !response.ok()) errors.push('asset: ' + response.status());
    });
    let remaining = 3, verified = false;
    // Use real unified-code generation/verification; simulate paid decisions only.
    await page.route('**/api/jev/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data;
      if (path.endsWith('/redeem')) {
        assert.ok(route.request().headers()['x-csrf-token']);
        assert.equal(route.request().headers().authorization, undefined);
        verified = true;
        await route.continue(); return;
      } else if (path.endsWith('/credits')) {
        if (!verified) { await route.continue(); return; }
        data = { status: 'success', remainingUses: remaining };
      }
      else {
        const input = route.request().postDataJSON();
        assert.ok(input.request_key);
        assert.ok(route.request().headers()['x-csrf-token']);
        const labels = input.mode === 'choice' ? input.options : ['要', '不要'];
        data = { status: 'success', selectedOptionLabel: labels[0], verdict: 'recommend', confidence: 0.9,
          remainingUses: --remaining, options: labels.map((label, i) => ({ id: `option_${i + 1}`, label, probability: i ? 0.2 : 0.8 })) };
      }
      await route.fulfill({ json: data });
    });
    for (const path of ['/jev', '/jev/']) {
      await page.goto(origin + path);
      await page.getByRole('heading', { name: '不写小作文，直接帮你选' }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: '输入通用测评码，开始使用' }).waitFor();
    }
    await page.getByPlaceholder('例如：ABCD-EFGH-JKLM-NPQR').fill(code);
    await page.getByRole('button', { name: '验证测评码' }).click();
    await page.getByPlaceholder('例：我要不要接受这份新工作？').fill('周末要不要出门？');
    await page.locator('.context-input').fill('天气很好，今天有空。');
    await page.getByRole('button', { name: '让 JEV 选一下' }).click();
    await page.getByRole('heading', { name: '建议选：要' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '选哪个', exact: true }).click();
    await page.locator('.question-input').fill('周末去哪里？');
    await page.locator('.context-input').fill('希望在附近散步。');
    await page.getByPlaceholder('选项 A').fill('公园');
    await page.getByPlaceholder('选项 B').fill('商场');
    await page.getByRole('button', { name: '让 JEV 选一下' }).click();
    await page.getByRole('heading', { name: '建议选：公园' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(origin + '/quiz/past');
    await page.getByRole('heading', { name: '你的上一世是什么？', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('JEV mobile/desktop routes, reload, redemption, both decision modes and quiz entry passed.');
} finally { await browser.close(); }
