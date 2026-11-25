// Visual pass: screenshot the main pages against the local dev server.
// Usage: node test/shots.mjs <carCode> <convUrl> <sessionCookie>
import { chromium } from 'playwright-core';

const [, , code, convPath, cookie] = process.argv;
const BASE = 'http://localhost:8787';
const out = (n) => `/tmp/shot-${n}.png`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-EG' });
if (cookie) {
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: BASE }]);
}
const page = await ctx.newPage();
const shot = async (url, name, opts = {}) => {
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: out(name), fullPage: true, ...opts });
  console.log('saved', out(name));
};

await shot('/', 'landing');
await shot(`/c/${code}`, 'sender-ar');
const ctxEn = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US' });
const pageEn = await ctxEn.newPage();
await pageEn.goto(BASE + `/c/${code}`, { waitUntil: 'networkidle' });
await pageEn.screenshot({ path: out('sender-en'), fullPage: true });
console.log('saved', out('sender-en'));
await ctxEn.close();
await shot(convPath, 'thread');
await shot('/app', 'dashboard');
await shot(convPath.replace('/s/', '/app/conv/').replace(/\/[a-f0-9]{40}$/, ''), 'conv-owner');
await shot(`/sticker/${code}`, 'sticker');
await browser.close();
console.log('done');
