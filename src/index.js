// SafePark pilot — Cloudflare Worker entry.
// One owner, multiple cars, QR sender pages, owner dashboard, notifications.

import { Hono } from 'hono';
import QRCode from 'qrcode';
import piexif from 'piexifjs';

import { uid, carCode, hashPassword, escapeHtml as e, wantsArabic, inQuietHours } from './util.js';
import { getOwner, rateCount, rateHit, senderMessageCount } from './db.js';
import { notifyOwner, handleTelegramUpdate } from './notify.js';
import { landing, loginPage, setupPage } from './html.js';
import { senderPage, sentPage, threadPage, simplePage, tr, REASONS } from './sender.js';
import { dashboardPage, convPage, stickerPage } from './owner.js';

const app = new Hono();

// ---------- helpers ----------

function lang(c) {
  return wantsArabic(c.req.header('accept-language')) ? 'ar' : 'en';
}

function normDigits(s) {
  return String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

async function sessionOwner(c) {
  const cookie = c.req.header('cookie') || '';
  const token = cookie.match(/(?:^|;\s*)sp_session=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT o.* FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
  ).bind(token).first();
}

async function requireOwner(c) {
  const owner = await sessionOwner(c);
  if (!owner) return null;
  return owner;
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { location: path } });
}

function senderIp(c) {
  // cf-connecting-ip is authoritative in production; in local dev miniflare
  // sets it to a loopback address, so fall back to x-forwarded-for there.
  const cf = c.req.header('cf-connecting-ip');
  if (cf && cf !== '127.0.0.1' && cf !== '::1') return cf;
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || cf || 'local';
}

async function makeCaptcha(db) {
  const a = 2 + Math.floor(Math.random() * 7);
  const b = 1 + Math.floor(Math.random() * 8);
  const id = uid(8);
  await db.prepare(`INSERT INTO captchas (id, answer, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`)
    .bind(id, String(a + b)).run();
  return { id, question: `${a} + ${b}` };
}

async function checkCaptcha(db, id, answer) {
  if (!id) return false;
  const row = await db.prepare(`SELECT answer FROM captchas WHERE id = ? AND expires_at > datetime('now')`).bind(id).first();
  await db.prepare(`DELETE FROM captchas WHERE id = ?`).bind(id).run();
  return !!row && row.answer === normDigits(answer).trim();
}

async function storePhoto(env, file) {
  if (!file || !file.size) return null;
  if (file.size > 1500 * 1024) return null; // D1 row limit is 2MB
  const type = (file.type || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
  let buf = new Uint8Array(await file.arrayBuffer());
  if (type === 'image/jpeg') {
    try {
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const stripped = piexif.remove(bin);
      buf = new Uint8Array(stripped.length);
      for (let i = 0; i < stripped.length; i++) buf[i] = stripped.charCodeAt(i) & 0xff;
    } catch (_) { /* keep original if stripping fails */ }
  }
  const key = `${uid(16)}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
  await env.DB.prepare('INSERT INTO photos (key, content_type, data) VALUES (?, ?, ?)').bind(key, type, buf).run();
  return key;
}

// ---------- public pages ----------

app.get('/', (c) => c.html(landing(lang(c))));

app.get('/setup', async (c) => {
  if (c.req.query('key') !== c.env.SETUP_SECRET) return c.notFound();
  const existing = await getOwner(c.env.DB);
  if (existing) return c.html(simplePage('ar', 'تم', 'الإعداد اتعمل قبل كده.'));
  return c.html(setupPage('ar', c.env.SETUP_SECRET));
});

app.post('/api/setup', async (c) => {
  const body = await c.req.parseBody();
  if (body.key !== c.env.SETUP_SECRET) return c.notFound();
  const existing = await getOwner(c.env.DB);
  if (existing) return c.html(simplePage('ar', 'تم', 'الإعداد اتعمل قبل كده.'));
  const { hash, salt } = await hashPassword(String(body.password));
  const ownerId = uid();
  await c.env.DB.prepare('INSERT INTO owners (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)')
    .bind(ownerId, String(body.email).toLowerCase(), hash, salt).run();
  await c.env.DB.prepare('INSERT INTO cars (id, owner_id, code, car_type, plate) VALUES (?, ?, ?, ?, ?)')
    .bind(uid(), ownerId, carCode(), String(body.car_type), String(body.plate)).run();
  return redirect('/login');
});

app.get('/login', (c) => c.html(loginPage(lang(c))));

app.post('/api/login', async (c) => {
  const body = await c.req.parseBody();
  const owner = await c.env.DB.prepare('SELECT * FROM owners WHERE email = ?').bind(String(body.email || '').toLowerCase()).first();
  let ok = false;
  if (owner) {
    const { hash } = await hashPassword(String(body.password), owner.password_salt);
    ok = hash === owner.password_hash;
  }
  if (!ok) return c.html(loginPage(lang(c), tr(lang(c)).wrongLogin), 401);
  const token = uid(24);
  await c.env.DB.prepare(`INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))`)
    .bind(token, owner.id).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/app', 'set-cookie': `sp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` },
  });
});

app.get('/logout', async (c) => {
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': 'sp_session=; Path=/; HttpOnly; Max-Age=0' },
  });
});

// ---------- sender flow ----------

app.get('/c/:code', async (c) => {
  const l = lang(c);
  const t = tr(l);
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE code = ?').bind(c.req.param('code')).first();
  if (!car) return c.html(simplePage(l, 'SafePark', t.notFound), 404);
  if (car.disabled) return c.html(simplePage(l, 'SafePark', t.disabled), 410);
  const count = await senderMessageCount(c.env.DB, senderIp(c), '');
  const captcha = count >= 2 ? await makeCaptcha(c.env.DB) : null;
  return c.html(senderPage({ lang: l, car, captcha, plateCheck: !!car.plate_check, origin: c.env.APP_ORIGIN }));
});

app.post('/api/c/:code/send', async (c) => {
  const l = lang(c);
  const t = tr(l);
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE code = ?').bind(c.req.param('code')).first();
  if (!car) return c.html(simplePage(l, 'SafePark', t.notFound), 404);
  if (car.disabled) return c.html(simplePage(l, 'SafePark', t.disabled), 410);
  const owner = await c.env.DB.prepare('SELECT * FROM owners WHERE id = ?').bind(car.owner_id).first();
  const body = await c.req.parseBody();
  const ip = senderIp(c);
  const err = (m) => c.html(senderPage({ lang: l, car, captcha: null, plateCheck: !!car.plate_check, error: m, origin: c.env.APP_ORIGIN }), 400);

  const msgText = String(body.body || '').trim();
  if (!msgText) return err(t.msgPh);
  if (await rateCount(c.env.DB, 'sender_hour', ip, 3600) >= 3) return err(t.rateLimit);
  if (await rateCount(c.env.DB, 'car_day', car.id, 86400) >= 10) return err(t.rateLimit);

  const priorCount = await senderMessageCount(c.env.DB, ip, '');
  if (priorCount >= 2) {
    const ok = await checkCaptcha(c.env.DB, String(body.captcha_id || ''), String(body.captcha_answer || ''));
    if (!ok) return err(t.wrongCaptcha);
  }
  if (car.plate_check) {
    const want = normDigits(car.plate).replace(/\D/g, '').slice(-3);
    const got = normDigits(String(body.plate_digits || '')).replace(/\D/g, '');
    if (want && got !== want) return err(t.wrongPlate);
  }

  const convId = uid();
  const senderKey = uid(20);
  const email = String(body.sender_email || '').trim() || null;
  const photoKey = await storePhoto(c.env, body.photo instanceof File ? body.photo : null);
  // Urgency is derived here, never trusted from the client: a sender could
  // otherwise set urgent=1 by hand and bypass quiet hours / unavailable mode.
  const reasonText = String(body.reason || '');
  const urgent = REASONS.some((r) => r.urgent && (reasonText === r.ar || reasonText === r.en || reasonText === r.key)) ? 1 : 0;
  const held = inQuietHours(owner) && !urgent ? 1 : 0;

  await c.env.DB.prepare('INSERT INTO conversations (id, car_id, sender_key, sender_email, sender_ip) VALUES (?, ?, ?, ?, ?)')
    .bind(convId, car.id, senderKey, email, ip).run();
  await c.env.DB.prepare('INSERT INTO messages (id, conversation_id, direction, reason, body, photo_key, urgent, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), convId, 'in', String(body.reason || '').slice(0, 80), msgText.slice(0, 1000), photoKey, urgent, held).run();
  await rateHit(c.env.DB, 'sender_hour', ip);
  await rateHit(c.env.DB, 'car_day', car.id);

  const conv = { id: convId, sender_key: senderKey, sender_email: email };
  c.executionCtx.waitUntil(notifyOwner(c.env, owner, conv, { reason: body.reason, body: msgText, held }, car));
  const followUrl = `${c.env.APP_ORIGIN}/s/${convId}/${senderKey}`;
  return c.html(sentPage({ lang: l, conv, followUrl }));
});

app.post('/api/c/:code/report', async (c) => {
  const l = lang(c);
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE code = ?').bind(c.req.param('code')).first();
  if (car) {
    await c.env.DB.prepare(
      `UPDATE conversations SET reported = 1, report_reason = COALESCE(report_reason, 'sticker report')
       WHERE car_id = ? AND last_msg_at >= datetime('now', '-1 day')`,
    ).bind(car.id).run();
  }
  return c.html(simplePage(l, 'SafePark', tr(l).reportDone));
});

app.get('/s/:convId/:key', async (c) => {
  const l = lang(c);
  const t = tr(l);
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND sender_key = ?')
    .bind(c.req.param('convId'), c.req.param('key')).first();
  if (!conv) return c.html(simplePage(l, 'SafePark', t.notFound), 404);
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(conv.car_id).first();
  const { results: messages } = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
  ).bind(conv.id).all();
  return c.html(threadPage({ lang: l, conv, car, messages, canSend: !conv.blocked }));
});

app.get('/api/thread/:convId/:key', async (c) => {
  const conv = await c.env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND sender_key = ?')
    .bind(c.req.param('convId'), c.req.param('key')).first();
  if (!conv) return c.json({ error: 'not found' }, 404);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').bind(conv.id).first();
  return c.json({ count: row?.n || 0 });
});

app.post('/api/thread/:convId/:key/send', async (c) => {
  const l = lang(c);
  const t = tr(l);
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND sender_key = ?')
    .bind(c.req.param('convId'), c.req.param('key')).first();
  if (!conv) return c.html(simplePage(l, 'SafePark', t.notFound), 404);
  if (conv.blocked) return c.html(simplePage(l, 'SafePark', t.blocked), 403);
  const body = await c.req.parseBody();
  const ip = senderIp(c);
  if (await rateCount(c.env.DB, 'sender_hour', ip, 3600) >= 3) return c.html(simplePage(l, 'SafePark', t.rateLimit), 429);
  if (await rateCount(c.env.DB, 'car_day', conv.car_id, 86400) >= 10) return c.html(simplePage(l, 'SafePark', t.rateLimit), 429);
  const priorCount = await senderMessageCount(c.env.DB, ip, conv.sender_key);
  if (priorCount >= 2) {
    const ok = await checkCaptcha(c.env.DB, String(body.captcha_id || ''), String(body.captcha_answer || ''));
    if (!ok) return c.html(simplePage(l, 'SafePark', t.wrongCaptcha), 400);
  }
  const msgText = String(body.body || '').trim().slice(0, 1000);
  if (!msgText) return redirect(`/s/${conv.id}/${conv.sender_key}`);
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(conv.car_id).first();
  const owner = await c.env.DB.prepare('SELECT * FROM owners WHERE id = ?').bind(car.owner_id).first();
  const held = inQuietHours(owner) ? 1 : 0;
  await c.env.DB.prepare(`INSERT INTO messages (id, conversation_id, direction, body, held) VALUES (?, ?, 'in', ?, ?)`)
    .bind(uid(), conv.id, msgText, held).run();
  await c.env.DB.prepare(`UPDATE conversations SET last_msg_at = datetime('now') WHERE id = ?`).bind(conv.id).run();
  await rateHit(c.env.DB, 'sender_hour', ip);
  await rateHit(c.env.DB, 'car_day', conv.car_id);
  c.executionCtx.waitUntil(notifyOwner(c.env, owner, conv, { body: msgText, held }, car));
  return redirect(`/s/${conv.id}/${conv.sender_key}`);
});

// ---------- owner app ----------

app.get('/app', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  // Lazily create the one-time Telegram binding code the dashboard shows.
  if (!owner.telegram_bind_token) {
    owner.telegram_bind_token = uid(10);
    await c.env.DB.prepare('UPDATE owners SET telegram_bind_token = ? WHERE id = ?').bind(owner.telegram_bind_token, owner.id).run();
  }
  const { results: cars } = await c.env.DB.prepare('SELECT * FROM cars WHERE owner_id = ? ORDER BY created_at').bind(owner.id).all();
  const { results: convs } = await c.env.DB.prepare(
    `SELECT co.* FROM conversations co JOIN cars ca ON ca.id = co.car_id WHERE ca.owner_id = ? ORDER BY co.last_msg_at DESC LIMIT 100`,
  ).bind(owner.id).all();
  const convsByCar = {};
  for (const cv of convs) (convsByCar[cv.car_id] ||= []).push(cv);
  return c.html(dashboardPage({ owner, cars, convsByCar, origin: c.env.APP_ORIGIN }));
});

app.get('/app/conv/:id', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const conv = await c.env.DB.prepare(
    `SELECT co.* FROM conversations co JOIN cars ca ON ca.id = co.car_id WHERE co.id = ? AND ca.owner_id = ?`,
  ).bind(c.req.param('id'), owner.id).first();
  if (!conv) return c.notFound();
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(conv.car_id).first();
  const { results: messages } = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
  ).bind(conv.id).all();
  return c.html(convPage({ conv, car, messages }));
});

app.post('/api/cars', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const body = await c.req.parseBody();
  await c.env.DB.prepare('INSERT INTO cars (id, owner_id, code, car_type, plate) VALUES (?, ?, ?, ?, ?)')
    .bind(uid(), owner.id, carCode(), String(body.car_type || '').slice(0, 80), String(body.plate || '').slice(0, 30)).run();
  return redirect('/app');
});

app.post('/api/cars/:id/:op', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const op = c.req.param('op');
  const val = op === 'disable' ? 1 : 0;
  await c.env.DB.prepare('UPDATE cars SET disabled = ? WHERE id = ? AND owner_id = ?').bind(val, c.req.param('id'), owner.id).run();
  return redirect('/app');
});

app.post('/api/conv/:id/reply', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const conv = await c.env.DB.prepare(
    `SELECT co.* FROM conversations co JOIN cars ca ON ca.id = co.car_id WHERE co.id = ? AND ca.owner_id = ?`,
  ).bind(c.req.param('id'), owner.id).first();
  if (!conv) return c.notFound();
  const body = await c.req.parseBody();
  const text = String(body.body || '').trim().slice(0, 1000);
  if (text) {
    await c.env.DB.prepare(`INSERT INTO messages (id, conversation_id, direction, body) VALUES (?, ?, 'out', ?)`)
      .bind(uid(), conv.id, text).run();
    // Optional reply notice to the sender's email (address stays hidden from owner UI).
    if (conv.sender_email && c.env.RESEND_API_KEY) {
      const followUrl = `${c.env.APP_ORIGIN}/s/${conv.id}/${conv.sender_key}`;
      c.executionCtx.waitUntil(fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: c.env.EMAIL_FROM || 'SafePark <alerts@resend.dev>',
          to: [conv.sender_email],
          subject: 'وصلك رد من صاحب العربية',
          html: `<p dir="rtl">صاحب العربية رد على رسالتك. <a href="${followUrl}">افتح المحادثة</a></p>`,
        }),
      }));
    }
  }
  return redirect(`/app/conv/${conv.id}`);
});

app.post('/api/conv/:id/:op', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const op = c.req.param('op');
  if (!['block', 'unblock'].includes(op)) return c.notFound();
  await c.env.DB.prepare(
    `UPDATE conversations SET blocked = ? WHERE id = ? AND car_id IN (SELECT id FROM cars WHERE owner_id = ?)`,
  ).bind(op === 'block' ? 1 : 0, c.req.param('id'), owner.id).run();
  return redirect(`/app/conv/${c.req.param('id')}`);
});

app.post('/api/settings', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const body = await c.req.parseBody();
  const toMin = (v) => {
    const m = String(v || '').match(/^(\d{2}):(\d{2})$/);
    return m ? +m[1] * 60 + +m[2] : null;
  };
  await c.env.DB.prepare('UPDATE owners SET quiet_start = ?, quiet_end = ?, unavailable = ? WHERE id = ?')
    .bind(toMin(body.quiet_start), toMin(body.quiet_end), body.unavailable ? 1 : 0, owner.id).run();
  return redirect('/app');
});

app.get('/api/unseen', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: 'auth' }, 401);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(m.id) AS latest FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     JOIN cars ca ON ca.id = co.car_id
     WHERE ca.owner_id = ? AND m.direction = 'in'`,
  ).bind(owner.id).first();
  return c.json({ count: row?.n || 0, latest: row?.latest || null });
});

app.get('/api/convcount/:id', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: 'auth' }, 401);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').bind(c.req.param('id')).first();
  return c.json({ count: row?.n || 0 });
});

app.get('/sticker/:code', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const car = await c.env.DB.prepare('SELECT * FROM cars WHERE code = ? AND owner_id = ?').bind(c.req.param('code'), owner.id).first();
  if (!car) return c.notFound();
  const url = `${c.env.APP_ORIGIN}/c/${car.code}`;
  const qrSvg = await QRCode.toString(url, { type: 'svg', width: 220, margin: 1 });
  const minimal = c.req.query('minimal') === '1';
  return c.html(stickerPage({ car, origin: c.env.APP_ORIGIN, qrSvg, minimal }));
});



app.get('/photo/:key', async (c) => {
  const key = c.req.param('key');
  const owner = await sessionOwner(c);
  let allowed = !!owner;
  if (!allowed) {
    const k = c.req.query('k') || '';
    const row = await c.env.DB.prepare(
      `SELECT m.id FROM messages m JOIN conversations co ON co.id = m.conversation_id WHERE m.photo_key = ? AND co.sender_key = ?`,
    ).bind(key, k).first();
    allowed = !!row;
  }
  if (!allowed) return c.notFound();
  const row2 = await c.env.DB.prepare('SELECT content_type, data FROM photos WHERE key = ?').bind(key).first();
  if (!row2) return c.notFound();
  // D1 returns BLOB as ArrayBuffer in production, as a number array in local dev.
  const bytes = row2.data instanceof ArrayBuffer ? row2.data : Uint8Array.from(row2.data);
  return new Response(bytes, { headers: { 'content-type': row2.content_type || 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
});

app.post('/api/push/subscribe', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: 'auth' }, 401);
  const sub = await c.req.json().catch(() => null);
  if (!sub?.endpoint) return c.json({ error: 'bad' }, 400);
  await c.env.DB.prepare('INSERT OR IGNORE INTO push_subs (id, owner_id, endpoint) VALUES (?, ?, ?)')
    .bind(uid(), owner.id, String(sub.endpoint)).run();
  return c.json({ ok: true });
});

// ---------- telegram webhook ----------

app.post('/api/tg/webhook', async (c) => {
  // When a webhook secret is configured, only Telegram (which sends it back
  // as a header) may post updates. Unset = pilot behaviour, still protected
  // by the binding-code and bound-chat checks in handleTelegramUpdate.
  if (c.env.TELEGRAM_WEBHOOK_SECRET && c.req.header('x-telegram-bot-api-secret-token') !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const update = await c.req.json().catch(() => null);
  if (update) c.executionCtx.waitUntil(handleTelegramUpdate(c.env, update));
  return c.json({ ok: true });
});

// ---------- pwa ----------

app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'SafePark',
    short_name: 'SafePark',
    start_url: '/app',
    display: 'standalone',
    background_color: '#f6f7f6',
    theme_color: '#123c2b',
    icons: [],
  }),
);

app.get('/sw.js', (c) => {
  const js = `self.addEventListener('push', function(event){
  event.waitUntil((async function(){
    let title = 'SafePark', body = 'وصلت رسالة جديدة';
    try {
      const r = await fetch('/api/unseen');
      if (r.ok) { const d = await r.json(); body = 'عندك ' + d.count + ' رسالة'; }
    } catch(_) {}
    await self.registration.showNotification(title, { body: body, dir: 'rtl', lang: 'ar' });
  })());
});
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(clients.openWindow('/app'));
});`;
  return new Response(js, { headers: { 'content-type': 'text/javascript' } });
});

app.get('/health', (c) => c.json({ ok: true, service: 'safepark', time: new Date().toISOString() }));

// ---------- scheduled: retention + quiet-hours flush ----------

async function runScheduled(env) {
  // Retention: conversations older than 30 days, reports kept 90 days.
  // Photos go first: they live in their own table, and deleting only the
  // messages would leave the image data in D1 forever, breaking the
  // retention promise (and leaking storage).
  for (const [reported, days] of [[0, 30], [1, 90]]) {
    await env.DB.prepare(
      `DELETE FROM photos WHERE key IN (
         SELECT m.photo_key FROM messages m JOIN conversations co ON co.id = m.conversation_id
         WHERE m.photo_key IS NOT NULL AND co.reported = ? AND co.last_msg_at < datetime('now', ?))`,
    ).bind(reported, `-${days} days`).run();
    await env.DB.prepare(
      `DELETE FROM messages WHERE conversation_id IN (
         SELECT id FROM conversations WHERE reported = ? AND last_msg_at < datetime('now', ?))`,
    ).bind(reported, `-${days} days`).run();
    await env.DB.prepare(`DELETE FROM conversations WHERE reported = ? AND last_msg_at < datetime('now', ?)`).bind(reported, `-${days} days`).run();
  }
  await env.DB.prepare(`DELETE FROM rate_events WHERE created_at < datetime('now', '-2 days')`).run();
  await env.DB.prepare(`DELETE FROM captchas WHERE expires_at < datetime('now')`).run();

  // Flush notifications held by quiet hours once the window has passed.
  const owner = await getOwner(env.DB);
  if (owner && !inQuietHours(owner)) {
    const { results: held } = await env.DB.prepare(
      `SELECT m.id, m.conversation_id, m.reason, m.body, co.car_id FROM messages m
       JOIN conversations co ON co.id = m.conversation_id WHERE m.held = 1`,
    ).all();
    if (held.length) {
      await env.DB.prepare('UPDATE messages SET held = 0 WHERE held = 1').run();
      const text = `عندك ${held.length} رسالة اتأجلت أثناء ساعات الهدوء.`;
      if (env.TELEGRAM_BOT_TOKEN && owner.telegram_chat_id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: owner.telegram_chat_id, text }),
        }).catch(() => {});
      }
    }
  }
}

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(runScheduled(env)),
};
