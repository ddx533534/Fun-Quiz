import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = process.env.E2E_ORIGIN || "http://127.0.0.1:8000";
const adminKey =
  process.env.E2E_ADMIN_KEY ||
  JSON.parse(await readFile("../local-secrets.json", "utf8")).admin;
await mkdir("../test-artifacts", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.E2E_BROWSER_PATH
    ? { executablePath: process.env.E2E_BROWSER_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(origin + "/admin");
await page.getByLabel("管理密钥").fill(adminKey);
await page.getByRole("button", { name: "登录管理端" }).click();
await page.getByRole("button", { name: "批量生成100个测评码" }).click();
await page.getByText("已生成 100 个测评码").waitFor();
const url = await page
  .getByRole("link", { name: "下载测评码 CSV" })
  .getAttribute("href");
const csv = await (await context.request.get(origin + url)).text();
const rows = csv.trim().split(/\r?\n/);
assert.equal(rows.length, 101);
const code = rows[1].split(",")[0];
assert.equal(new Set(rows.slice(1).map((r) => r.split(",")[0])).size, 100);
await page.goto(origin);
await page.getByRole("heading", { name: "如果换一种身份，" }).waitFor();
await page.screenshot({
  path: "../test-artifacts/home-mobile.png",
  fullPage: true,
});
assert.equal(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
  true,
);
await page
  .getByRole("button")
  .filter({ has: page.getByRole("heading", { name: "你的上一世是什么？" }) })
  .click();
await page.getByLabel("测评码", { exact: true }).fill(code);
await page.getByRole("button", { name: "解锁我的档案" }).click();
await page.getByRole("button", { name: "开始测评" }).click();
for (let i = 0; i < 24; i++) {
  await page
    .getByText(`生活片段 ${String(i + 1).padStart(2, "0")}`, { exact: true })
    .waitFor();
  if (i === 0)
    await page.screenshot({
      path: "../test-artifacts/question-mobile.png",
      fullPage: true,
    });
  await page
    .locator(".options button")
    .nth(i % 4)
    .click();
}
// Go back and change the preceding answer, then return to last question.
await page.getByRole("button", { name: "上一题" }).click();
await page.getByText("生活片段 23", { exact: true }).waitFor();
await page.locator(".options button").nth(3).click();
await page.getByRole("button", { name: "查看我的身份" }).click();
await page.locator(".dossier").first().waitFor();
await page.screenshot({
  path: "../test-artifacts/result-mobile.png",
  fullPage: true,
});
assert.equal(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
  true,
);
const resultId = new URL(page.url()).pathname.split("/").pop();
const data = await (
  await context.request.get(origin + "/api/results/" + resultId)
).json();
await page.getByRole("button", { name: "保存结果图片" }).click();
await page.getByRole("dialog").getByRole("img").waitFor();
const poster = await page
  .getByRole("dialog")
  .getByRole("img")
  .getAttribute("src");
const bytes = await page.evaluate(
  async (url) =>
    Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
  poster,
);
await writeFile("../test-artifacts/poster.png", Buffer.from(bytes));
await page.getByRole("button", { name: "关闭 ×" }).click();
const stranger = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const sharePage = await stranger.newPage();
await sharePage.goto(data.share_url);
await sharePage.locator(".dossier").first().waitFor();
assert.equal(
  await sharePage.locator(".result-title h1").textContent(),
  data.report.headline,
);
const privateResponse = await stranger.request.get(
  origin + "/api/results/" + resultId,
);
assert.equal(privateResponse.status(), 404);
const desktop = await browser.newContext({
  viewport: { width: 1365, height: 900 },
});
const desktopPage = await desktop.newPage();
await desktopPage.goto(origin);
await desktopPage.locator(".product").first().waitFor();
await desktopPage.screenshot({
  path: "../test-artifacts/home-desktop.png",
  fullPage: true,
});
assert.deepEqual(errors, []);
await browser.close();
console.log(
  "PASS: mobile navigation, 100 unique codes, 24 questions, back/edit, result, PNG, anonymous sharing, private ownership, desktop rendering.",
);
