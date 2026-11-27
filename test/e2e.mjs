// SafePark end-to-end test against `wrangler dev` on :8787.
// Usage: node test/e2e.mjs   (run.sh resets the local DB first)

import { execSync } from 'node:child_process';

const BASE = 'http://localhost:8787';
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { res, text, status: res.status, headers: res.headers };
}

function sql(query) {
  const out = execSync(`npx wrangler d1 execute safepark --local --json --command "${query.replace(/"/g, '\\"')}"`, {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
  return JSON.parse(out)[0].results;
}

const ip = (n) => ({ 'x-forwarded-for': `10.0.0.${n}`, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'ar-EG,ar;q=0.9' });
const form = (obj) => new URLSearchParams(obj).toString();

// --- basics ---
let r = await req('/health');
check('health endpoint', r.status === 200 && JSON.parse(r.text).ok);

r = await req('/');
check('landing page renders', r.status === 200 && r.text.includes('SafePark'));

r = await req('/setup?key=wrong');
check('setup rejects wrong key', r.status === 404);

r = await req('/setup?key=dev-setup-secret');
check('setup page renders', r.status === 200 && r.text.includes('name="car_type"'));

// --- setup + login ---
r = await req('/api/setup', {
  method: 'POST', headers: ip(1),
  body: form({ key: 'dev-setup-secret', email: 'Owner@Test.com', password: 'supersecret1', car_type: 'سيدان بيضاء', plate: '١٢٣ ن ق د' }),
});
check('setup creates owner and car', r.status === 302 && r.headers.get('location') === '/login');

r = await req('/api/login', { method: 'POST', headers: ip(1), body: form({ email: 'owner@test.com', password: 'wrongpass1' }) });
check('wrong password rejected', r.status === 401);

r = await req('/api/login', { method: 'POST', headers: ip(1), body: form({ email: 'owner@test.com', password: 'supersecret1' }) });
const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('login sets session cookie', r.status === 302 && cookie.startsWith('sp_session='));
const auth = { cookie };

r = await req('/app');
check('dashboard requires auth', r.status === 302);
r = await req('/app', { headers: auth });
check('dashboard shows the car', r.status === 200 && r.text.includes('سيدان بيضاء'));

const car = sql('SELECT id, code FROM cars LIMIT 1')[0];
check('car has a public code', /^[A-Z2-9]{6}$/.test(car.code));
const CODE = car.code;

// --- sticker ---
r = await req(`/sticker/${CODE}`, { headers: auth });
check('sticker page has QR and masked plate', r.status === 200 && r.text.includes('<svg') && r.text.includes('•') && !r.text.includes('١٢٣'));

// --- sender flow ---
r = await req(`/c/${CODE}`, { headers: { 'accept-language': 'ar-EG,ar;q=0.9' } });
check('sender page renders car, masked plate', r.status === 200 && r.text.includes('سيدان') && r.text.includes('•'));
check('sender page never shows the full plate', !r.text.includes('١٢٣ ن ق د'));
check('sender page shows scam warning', r.text.includes('ممنوع أي طلب فلوس') || r.text.includes('تحذير'));

r = await req(`/c/NOPE99`);
check('unknown code 404s', r.status === 404);

// message 1
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(2), body: form({ body: 'حاجزني يا فندم', reason: 'حاجزني', urgent: '0' }) });
check('first message accepted', r.status === 200 && r.text.includes('وصلت رسالتك'));
const m = r.text.match(/\/s\/([a-f0-9]+)\/([a-f0-9]+)/);
check('follow link issued', !!m);
const [convId, senderKey] = [m?.[1], m?.[2]];

r = await req(`/s/${convId}/${senderKey}`);
check('sender thread shows message', r.status === 200 && r.text.includes('حاجزني يا فندم'));

r = await req(`/s/${convId}/deadbeef`);
check('wrong sender key rejected', r.status === 404);

// owner sees it and replies
r = await req('/app', { headers: auth });
check('dashboard lists conversation', r.text.includes(`/app/conv/${convId}`));

r = await req(`/api/conv/${convId}/reply`, { method: 'POST', headers: { ...ip(1), cookie }, body: form({ body: 'جاي في دقيقتين' }) });
check('owner reply accepted', r.status === 302);

r = await req(`/s/${convId}/${senderKey}`);
check('sender sees owner reply', r.text.includes('جاي في دقيقتين'));

// message 2 via thread (no captcha yet: sender has 1 prior 'in' message)
r = await req(`/api/thread/${convId}/${senderKey}/send`, { method: 'POST', headers: ip(2), body: form({ body: 'لسه مستني' }) });
check('second message without captcha ok', r.status === 302);

// message 3: captcha now required
r = await req(`/api/thread/${convId}/${senderKey}/send`, { method: 'POST', headers: ip(2), body: form({ body: 'ثالث رسالة' }) });
check('third message requires captcha', r.status === 400);
check('failed captcha re-renders thread with a fresh captcha (no dead end)', r.text.includes('name="captcha_answer"'));
r = await req(`/s/${convId}/${senderKey}`, { headers: { 'x-forwarded-for': '10.0.0.2' } });
check('thread page itself shows a captcha after 2 messages', r.text.includes('name="captcha_answer"'));

// get a captcha from the sender page, solve it from DB
r = await req(`/c/${CODE}`, { headers: { 'x-forwarded-for': '10.0.0.2' } });
const cap = r.text.match(/name="captcha_id" value="([a-f0-9]+)"/);
check('captcha shown after 2 messages', !!cap);
let captchaPassed = false;
if (cap) {
  const answer = sql(`SELECT answer FROM captchas WHERE id = '${cap[1]}'`)[0]?.answer;
  r = await req(`/api/thread/${convId}/${senderKey}/send`, {
    method: 'POST', headers: ip(2), body: form({ body: 'ثالث رسالة', captcha_id: cap[1], captcha_answer: answer }),
  });
  captchaPassed = r.status === 302;
}
check('solved captcha lets message through', captchaPassed);

// rate limit: sender_hour is 3 for ip .2 — 4th must fail
r = await req(`/api/thread/${convId}/${senderKey}/send`, { method: 'POST', headers: ip(2), body: form({ body: 'رابعة' }) });
check('per-sender hourly limit enforced', r.status === 429);

// car daily limit: hit from other IPs until 10/day reached (already 3 today)
let limited = false, lastStatus = 0, lastSnippet = '';
for (let i = 3; i <= 12 && !limited; i++) {
  r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(i), body: form({ body: `test ${i}` }) });
  lastStatus = r.status; lastSnippet = (r.text.match(/class="warn">([^<]*)</) || [])[1] || r.text.slice(0, 120);
  // fresh sender IP: the only possible 400 here is the per-car daily cap
  if (r.status === 400) limited = true;
}
const carDayHits = sql(`SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'car_day' AND bucket = '${car.id}'`)[0].n;
check('per-car daily limit enforced (10/day)', limited && carDayHits === 10, `limited=${limited} carDayHits=${carDayHits} status=${lastStatus} snippet=${lastSnippet}`);
// reset the rate-limit budget so later scenarios are not blocked by it
sql('DELETE FROM rate_events');

// block sender
r = await req(`/api/conv/${convId}/block`, { method: 'POST', headers: { cookie } });
r = await req(`/s/${convId}/${senderKey}`, { headers: { 'accept-language': 'ar-EG,ar;q=0.9' } });
check('blocked sender sees restriction', r.text.includes('قيّد'));
r = await req(`/api/thread/${convId}/${senderKey}/send`, { method: 'POST', headers: ip(2), body: form({ body: 'x' }) });
check('blocked sender cannot send', r.status === 403);
await req(`/api/conv/${convId}/unblock`, { method: 'POST', headers: { cookie } });

// report
r = await req(`/api/c/${CODE}/report`, { method: 'POST', headers: ip(9) });
check('report button works', r.status === 200 && (r.text.includes('بلاغك') || r.text.includes('report')));
check('report flagged in DB', sql(`SELECT reported FROM conversations WHERE id = '${convId}'`)[0].reported === 1);

// quiet hours: cover current Cairo time, then send from fresh IP
await req('/api/settings', { method: 'POST', headers: { ...ip(1), cookie }, body: form({ quiet_start: '00:00', quiet_end: '23:59' }) });
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(20), body: form({ body: 'رسالة أثناء الهدوء' }) });
check('message during quiet hours still delivered', r.status === 200, `status=${r.status} snippet=${r.text.slice(0, 200)}`);
const heldRow = sql(`SELECT held FROM messages WHERE body = 'رسالة أثناء الهدوء'`)[0];
check('notification held during quiet hours', heldRow && heldRow.held === 1);
// urgent bypass: urgency comes from the (urgent) reason alone
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(21), body: form({ body: 'النور مولع', reason: 'النور مولع' }) });
const urgRow = sql(`SELECT held, urgent FROM messages WHERE body = 'النور مولع'`)[0];
check('urgent reason bypasses quiet hours', urgRow && urgRow.held === 0 && urgRow.urgent === 1);
// a forged urgent=1 on a non-urgent reason must be ignored
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(22), body: form({ body: 'رسالة عادية بعلم عاجل مزور', reason: 'سبب آخر', urgent: '1' }) });
const forgedRow = sql(`SELECT held, urgent FROM messages WHERE body = 'رسالة عادية بعلم عاجل مزور'`)[0];
check('forged urgent flag ignored for non-urgent reason', forgedRow && forgedRow.held === 1 && forgedRow.urgent === 0);
// reset quiet hours
await req('/api/settings', { method: 'POST', headers: { ...ip(1), cookie }, body: form({ quiet_start: '', quiet_end: '' }) });

// disable / enable sticker
await req(`/api/cars/${car.id}/disable`, { method: 'POST', headers: { cookie } });
r = await req(`/c/${CODE}`);
check('disabled sticker blocked for senders', r.status === 410);
await req(`/api/cars/${car.id}/enable`, { method: 'POST', headers: { cookie } });
r = await req(`/c/${CODE}`);
check('re-enabled sticker works again', r.status === 200);

// plate check (abuse mode): wrong then right digits
sql(`UPDATE cars SET plate_check = 1 WHERE id = '${car.id}'`);
r = await req(`/c/${CODE}`, { headers: { 'x-forwarded-for': '10.0.0.30' } });
check('plate-digit field appears when abuse mode on', r.text.includes('name="plate_digits"'));
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(30), body: form({ body: 'check', plate_digits: '999' }) });
check('wrong plate digits rejected', r.status === 400);
r = await req(`/api/c/${CODE}/send`, { method: 'POST', headers: ip(30), body: form({ body: 'check', plate_digits: '123' }) });
check('right plate digits accepted (arabic plate normalized)', r.status === 200, `status=${r.status} snippet=${r.text.slice(0, 200)}`);
sql(`UPDATE cars SET plate_check = 0 WHERE id = '${car.id}'`);

// photo: JPEG with GPS EXIF -> stored stripped
import piexif from 'piexifjs';
import fs from 'node:fs';
const jpegB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAdQf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
let bin = Buffer.from(jpegB64, 'base64').toString('binary');
const exifObj = { GPS: { 0: [2, 3, 0, 0], 1: 'N', 3: 'E' }, '0th': {}, Exif: {}, '1st': {} };
bin = piexif.insert(piexif.dump(exifObj), bin);
fs.writeFileSync('/tmp/test-photo.jpg', Buffer.from(bin, 'binary'));

const fd = new FormData();
fd.append('body', 'مع صورة');
fd.append('photo', new Blob([Buffer.from(bin, 'binary')], { type: 'image/jpeg' }), 'p.jpg');
r = await fetch(BASE + `/api/c/${CODE}/send`, { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.40', 'accept-language': 'ar-EG,ar;q=0.9' }, body: fd });
const photoText = await r.text();
const photoConv = photoText.match(/\/s\/([a-f0-9]+)\/([a-f0-9]+)/);
check('photo message accepted', !!photoConv, `status=${r.status} snippet=${photoText.slice(0, 200)}`);
if (photoConv) {
  const pkey = sql(`SELECT photo_key FROM messages WHERE conversation_id = '${photoConv[1]}'`)[0]?.photo_key;
  check('photo stored', !!pkey);
  if (pkey) {
    const pres = await fetch(BASE + `/photo/${pkey}?k=${photoConv[2]}`);
    check('photo readable with sender key', pres.status === 200);
    const buf = Buffer.from(await pres.arrayBuffer());
    const loaded = piexif.load(buf.toString('binary'));
    check('GPS EXIF stripped from stored photo', Object.keys(loaded.GPS || {}).length === 0);
    const noKey = await fetch(BASE + `/photo/${pkey}`);
    check('photo not public without key', noKey.status === 404);
  }
}

// telegram webhook: a bare /start must NOT bind (anyone can find the bot)
r = await req('/api/tg/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: { text: '/start', chat: { id: 777 } } }),
});
check('telegram webhook accepted', r.status === 200);
await new Promise((s) => setTimeout(s, 800));
check('bare /start does not bind chat id', !sql('SELECT telegram_chat_id FROM owners LIMIT 1')[0].telegram_chat_id);
// binding works only with the one-time code from the dashboard
await req('/app', { headers: { cookie } }); // dashboard visit generates the code
const bindToken = sql('SELECT telegram_bind_token FROM owners LIMIT 1')[0].telegram_bind_token;
check('dashboard generated a bind code', !!bindToken);
r = await req('/api/tg/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: { text: `/start ${bindToken}`, chat: { id: 777 } } }),
});
await new Promise((s) => setTimeout(s, 800));
check('chat id bound with the dashboard code', sql('SELECT telegram_chat_id FROM owners LIMIT 1')[0].telegram_chat_id === '777');
check('bind code is single-use (cleared after binding)', !sql('SELECT telegram_bind_token FROM owners LIMIT 1')[0].telegram_bind_token);
// and a later bare /start from a stranger cannot steal the binding
r = await req('/api/tg/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: { text: '/start', chat: { id: 888 } } }),
});
await new Promise((s) => setTimeout(s, 800));
check('stranger /start cannot rebind', sql('SELECT telegram_chat_id FROM owners LIMIT 1')[0].telegram_chat_id === '777');

// telegram quick-reply callback from a foreign chat must be ignored
const qrBefore = sql(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = '${convId}' AND direction = 'out' AND body = 'جاي في دقيقتين'`)[0].n;
r = await req('/api/tg/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callback_query: { id: 'cb0', data: `qr:${convId}:1`, message: { chat: { id: 999 } } } }),
});
await new Promise((s) => setTimeout(s, 800));
check('quick reply from foreign chat ignored',
  sql(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = '${convId}' AND direction = 'out' AND body = 'جاي في دقيقتين'`)[0].n === qrBefore);

// telegram quick-reply callback from the bound chat inserts an owner reply
r = await req('/api/tg/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callback_query: { id: 'cb1', data: `qr:${convId}:1`, message: { chat: { id: 777 } } } }),
});
check('quick-reply callback accepted', r.status === 200);
await new Promise((s) => setTimeout(s, 800));
check('quick reply stored as owner message',
  sql(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = '${convId}' AND direction = 'out' AND body = 'جاي في دقيقتين'`)[0].n > qrBefore);

// retention: fake an old conversation, run the scheduled handler
sql(`INSERT INTO conversations (id, car_id, sender_key, last_msg_at) VALUES ('oldconv', '${car.id}', 'oldkey', datetime('now', '-40 days'))`);
sql(`INSERT INTO messages (id, conversation_id, direction, body, photo_key, created_at) VALUES ('oldmsg', 'oldconv', 'in', 'old', 'oldphoto', datetime('now', '-40 days'))`);
sql(`INSERT INTO photos (key, content_type, data) VALUES ('oldphoto', 'image/jpeg', X'FFD8FFE0')`);
r = await req('/__scheduled?cron=*+*+*+*');
check('scheduled endpoint runs', r.status === 200);
await new Promise((s) => setTimeout(s, 800));
check('old conversations purged (30d rule)', sql(`SELECT COUNT(*) AS n FROM conversations WHERE id = 'oldconv'`)[0].n === 0);
check('photos of purged conversations are deleted too', sql(`SELECT COUNT(*) AS n FROM photos WHERE key = 'oldphoto'`)[0].n === 0);
check('reported conversation kept (90d rule)', sql(`SELECT COUNT(*) AS n FROM conversations WHERE id = '${convId}'`)[0].n === 1);

// pwa bits
r = await req('/manifest.webmanifest');
check('PWA manifest served', r.status === 200 && JSON.parse(r.text).name === 'SafePark');
r = await req('/sw.js');
check('service worker served', r.status === 200 && r.text.includes('push'));
r = await req('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: 'https://push.example.com/sub/1' }) });
check('push subscription stored', r.status === 200 && sql('SELECT COUNT(*) AS n FROM push_subs')[0].n === 1);

// english sender page
r = await req(`/c/${CODE}`, { headers: { 'accept-language': 'en-US,en;q=0.9' } });
check('english auto-detected for sender', r.text.includes('Message the car owner'));

// --- phase 1: setup validation, login brake, logout, manifest ---
r = await req('/api/setup', { method: 'POST', headers: ip(1), body: form({ key: 'dev-setup-secret', email: 'new@test.com', password: 'short', car_type: 'x', plate: 'y' }) });
check('setup rejects a short password server-side', r.status === 400);

for (let i = 0; i < 10; i++) {
  await req('/api/login', { method: 'POST', headers: ip(99), body: form({ email: 'owner@test.com', password: 'wrongpass1' }) });
}
r = await req('/api/login', { method: 'POST', headers: ip(99), body: form({ email: 'owner@test.com', password: 'supersecret1' }) });
check('login locked after 10 failed attempts (even with right password)', r.status === 429);

r = await req('/api/login', { method: 'POST', headers: ip(1), body: form({ email: 'owner@test.com', password: 'supersecret1' }) });
const cookie2 = (r.headers.get('set-cookie') || '').split(';')[0];
r = await req('/app', { headers: { cookie: cookie2 } });
check('second session works before logout', r.status === 200);
await req('/logout', { headers: { cookie: cookie2 } });
r = await req('/app', { headers: { cookie: cookie2 } });
check('logout invalidates the session server-side', r.status === 302);

sql(`INSERT INTO sessions (token, owner_id, expires_at) VALUES ('deadbeefdeadbeef', (SELECT id FROM owners LIMIT 1), datetime('now', '-1 day'))`);
await req('/__scheduled?cron=*+*+*+*');
await new Promise((s) => setTimeout(s, 800));
check('expired sessions purged by scheduled job', sql(`SELECT COUNT(*) AS n FROM sessions WHERE token = 'deadbeefdeadbeef'`)[0].n === 0);

r = await req('/manifest.webmanifest');
check('manifest declares an icon', (JSON.parse(r.text).icons || []).length >= 1);
r = await req('/icon.svg');
check('icon is served as svg', r.status === 200 && r.text.includes('<svg'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
