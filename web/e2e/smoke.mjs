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
for (const [id, title] of [
  ["past", "你的上一世是什么？"],
  ["next", "你的下一世是什么？"],
  ["cat", "你是哪一种流浪猫？"],
  ["end", "末世来临，你会变成什么动物？"],
]) {
  await page.goto(origin + "/quiz/" + id);
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await page.getByLabel("测评码", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  assert.equal(await page.title(), title + " · 灵魂小馆");
}
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
  .getByRole("link")
  .filter({ has: page.getByRole("heading", { name: "你的上一世是什么？" }) })
  .click();
assert.equal(new URL(page.url()).pathname, "/quiz/past");
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
  if (i === 0) {
    await page.getByText("生活片段 02", { exact: true }).waitFor();
    await page.goto(origin + "/quiz/cat");
    await page
      .getByRole("heading", { name: "你是哪一种流浪猫？", exact: true })
      .waitFor();
    await page.getByLabel("测评码", { exact: true }).waitFor();
    assert.equal(await page.locator(".question").count(), 0);
    await page.goto(origin);
    await page.locator(".catalog").waitFor();
    await page.goto(origin + "/quiz/past");
    await page.getByText("生活片段 02", { exact: true }).waitFor();
  }
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
assert.equal(new URL(page.url()).pathname, "/quiz/past/result/" + resultId);
await page.reload();
await page.locator(".dossier").first().waitFor();
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
await sharePage.getByRole("button", { name: "我也测这款" }).click();
assert.equal(new URL(sharePage.url()).pathname, "/quiz/past");
await sharePage.getByLabel("测评码", { exact: true }).waitFor();
const privateResponse = await stranger.request.get(
  origin + "/api/results/" + resultId,
);
assert.equal(privateResponse.status(), 404);
// The same code can enter other products, but all products share its three uses.
for (const [product, remaining] of [
  ["next", 1],
  ["end", 0],
]) {
  await page.goto(origin + "/quiz/" + product);
  await page.getByLabel("测评码", { exact: true }).fill(code);
  await page.getByRole("button", { name: "解锁我的档案" }).click();
  await page.getByRole("button", { name: "开始测评" }).click();
  await page.getByText("生活片段 01", { exact: true }).waitFor();
  const aid = await page.evaluate(
    (id) => sessionStorage.getItem("quiz-attempt:" + id),
    product,
  );
  const session = await (
    await context.request.get(origin + "/api/session")
  ).json();
  const completion = await context.request.post(
    origin + "/api/attempts/" + aid + "/complete",
    {
      headers: { Origin: origin, "X-CSRF-Token": session.csrf },
      data: {
        answers: Object.fromEntries(
          Array.from({ length: 24 }, (_, i) => [
            "Q" + String(i + 1).padStart(2, "0"),
            "D",
          ]),
        ),
      },
    },
  );
  assert.equal(completion.status(), 200);
  assert.equal((await completion.json()).remaining, remaining);
  await page.reload();
  await page.locator(".dossier").first().waitFor();
  assert.equal(
    new URL(page.url()).pathname.startsWith("/quiz/" + product + "/result/"),
    true,
  );
}
await page.goto(origin + "/quiz/cat");
await page.getByLabel("测评码", { exact: true }).fill(code);
await page.getByRole("button", { name: "解锁我的档案" }).click();
await page
  .getByRole("alert")
  .getByText("这个测评码的三次机会已经用完")
  .waitFor();
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
  "PASS: four entries, separate progress, universal code across products with a shared 3-use limit, 100 unique codes, mobile flow, PNG, anonymous sharing, private ownership, desktop rendering.",
);
