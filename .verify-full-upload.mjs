import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "https://inventashif.tech/";
const OUT = process.env.HOME + "/.cache/hackerai";
const sample = `${OUT}/sample-upload.txt`;

writeFileSync(sample, "sandbox upload probe ".repeat(5000)); // ~1 MB

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const requests = [];
const failures = [];
page.on("request", (r) => {
  const u = r.url();
  if (/sandbox\/upload|generateS3UploadUrlAction|saveFile|fileActions|localSandbox|mutation/iu.test(u)) {
    requests.push({ method: r.method(), url: u.slice(0, 200) });
  }
});
page.on("requestfailed", (r) => {
  failures.push({ url: r.url().slice(0, 200), error: r.failure()?.errorText });
});
page.on("response", (r) => {
  const u = r.url();
  if (/sandbox\/upload|generateS3UploadUrlAction|saveFile|fileActions|mutation/iu.test(u)) {
    const status = r.status();
    if (status >= 400) {
      requests.push({ method: 'RESPONSE', url: u.slice(0, 200), status });
    }
  }
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
const input = page.getByTestId("chat-input");
await input.waitFor({ state: "visible", timeout: 60000 });

const fileInput = page.locator('input[type="file"]').first();
await fileInput.setInputFiles(sample).catch((e) => {
  console.log("setInputFiles_error", String(e).slice(0, 200));
});

await page.waitForTimeout(30000);
const text = await page.evaluate(() => document.body.innerText);
const toast = (text.match(/[^\n]*(upload|failed|error|size|limit|succeed|complete|saved|sandbox|not found|connected)[^\n]*/gi) || []).slice(0, 20);

await page.screenshot({ path: `${OUT}/full-upload-desktop.png` });
await browser.close();

console.log(JSON.stringify({ requests, failures, toast, sampleSize: 50000 }, null, 2));
