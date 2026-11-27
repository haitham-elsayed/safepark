// SafePark pilot — Cloudflare Worker entry.
// One owner, multiple cars, QR sender pages, owner dashboard, notifications.

import { Hono } from 'hono';
import QRCode from 'qrcode';
import piexif from 'piexifjs';

import { uid, carCode, hashPassword, escapeHtml as e, wantsArabic, inQuietHours, timingSafeEqual } from './util.js';
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

function stripPng(buf) {
  // Drop text/EXIF/time chunks; keep everything that renders the image.
  const drop = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
  const parts = [buf.slice(0, 8)];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (off + 12 + len > buf.length) return buf; // malformed: keep original
    if (!drop.has(type)) parts.push(buf.slice(off, off + 12 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function stripWebp(buf) {
  // RIFF container: drop EXIF / XMP chunks and clear their VP8X flags.
  if (buf.length < 12) return buf;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kept = [];
  let dropped = false;
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = dv.getUint32(off + 4, true);
    const total = 8 + size + (size % 2);
    if (off + total > buf.length) return buf; // malformed: keep original
    if (fourcc === 'EXIF' || fourcc === 'XMP ') dropped = true;
    else kept.push([fourcc, buf.slice(off, off + total)]);
    off += total;
  }
  if (!dropped) return buf;
  let totalLen = 12;
  for (const [, chunk] of kept) totalLen += chunk.length;
  const out = new Uint8Array(totalLen);
  out.set(buf.slice(0, 4), 0); // 'RIFF'
  new DataView(out.buffer).setUint32(4, totalLen - 8, true);
  out.set(buf.slice(8, 12), 8); // 'WEBP'
  let pos = 12;
  for (const [fourcc, chunk] of kept) {
    out.set(chunk, pos);
    if (fourcc === 'VP8X') out[pos + 8] &= ~(0x08 | 0x04); // clear EXIF|XMP flags (first data byte)
    pos += chunk.length;
  }
  return out;
}

async function storePhoto(env, file) {
  if (!file || !file.size) return { key: null };
  if (file.size > 1500 * 1024) return { error: 'size' }; // D1 row limit is 2MB
  const type = (file.type || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return { error: 'type' };
  let buf = new Uint8Array(await file.arrayBuffer());
  try {
    if (type === 'image/jpeg') {
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const stripped = piexif.remove(bin);
      buf = new Uint8Array(stripped.length);
      for (let i = 0; i < stripped.length; i++) buf[i] = stripped.charCodeAt(i) & 0xff;
    } else if (type === 'image/png') {
      buf = stripPng(buf);
    } else if (type === 'image/webp') {
      buf = stripWebp(buf);
    }
  } catch (_) { /* keep original if stripping fails */ }
  const key = `${uid(16)}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
  await env.DB.prepare('INSERT INTO photos (key, content_type, data) VALUES (?, ?, ?)').bind(key, type, buf).run();
  return { key };
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
  // Server-side validation: the HTML form's constraints are not a boundary,
  // a direct API call must not be able to create a weak account.
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || !String(body.car_type || '').trim() || !String(body.plate || '').trim()) {
    return c.html(simplePage('ar', 'بيانات ناقصة', 'اتأكد من الإيميل، وكلمة سر من ٨ حروف على الأقل، ونوع العربية واللوحة.'), 400);
  }
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

function sessionCookie(c, token, maxAge) {
  // Secure on real (https) deployments; left off for plain-http local dev.
  const secure = c.req.url.startsWith('https://') ? '; Secure' : '';
  return `sp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

app.post('/api/login', async (c) => {
  const body = await c.req.parseBody();
  const ip = senderIp(c);
  // Brute-force brake: 10 failed attempts per IP per hour lock further tries.
  if (await rateCount(c.env.DB, 'login_fail', ip, 3600) >= 10) {
    const msg = lang(c) === 'ar' ? 'محاولات دخول كتير غلط. استنى شوية وحاول تاني.' : 'Too many failed sign-in attempts. Wait a while and try again.';
    return c.html(loginPage(lang(c), msg), 429);
  }
  const owner = await c.env.DB.prepare('SELECT * FROM owners WHERE email = ?').bind(String(body.email || '').toLowerCase()).first();
  let ok = false;
  if (owner) {
    const { hash } = await hashPassword(String(body.password), owner.password_salt);
    ok = timingSafeEqual(hash, owner.password_hash);
  } else {
    // Run the same PBKDF2 work for unknown emails so response timing does
    // not reveal whether the account exists.
    await hashPassword(String(body.password || ''), '00'.repeat(16));
  }
  if (!ok) {
    await rateHit(c.env.DB, 'login_fail', ip);
    return c.html(loginPage(lang(c), tr(lang(c)).wrongLogin), 401);
  }
  const token = uid(24);
  await c.env.DB.prepare(`INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))`)
    .bind(token, owner.id).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/app', 'set-cookie': sessionCookie(c, token, 604800) },
  });
});

app.get('/logout', async (c) => {
  // Invalidate the session server-side too: clearing the cookie alone would
  // leave a stolen token valid until it expires (7 days).
  const cookie = c.req.header('cookie') || '';
  const token = cookie.match(/(?:^|;\s*)sp_session=([a-f0-9]+)/)?.[1];
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': sessionCookie(c, '', 0) },
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
  // Error re-renders must carry a fresh captcha when one is required, or the
  // sender is stuck: the form asks for an answer it never shows.
  const err = async (m) => {
    const needsCaptcha = (await senderMessageCount(c.env.DB, ip, '')) >= 2;
    const captcha = needsCaptcha ? await makeCaptcha(c.env.DB) : null;
    return c.html(senderPage({ lang: l, car, captcha, plateCheck: !!car.plate_check, error: m, origin: c.env.APP_ORIGIN }), 400);
  };

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
  const photoFile = body.photo instanceof File ? body.photo : null;
  let photoKey = null;
  if (photoFile && photoFile.size) {
    const stored = await storePhoto(c.env, photoFile);
    if (stored.error) return err(t.photoRejected); // never drop a photo silently
    photoKey = stored.key;
  }
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
    // A report flags only the reporter's own conversations with this car.
    // The QR code is public: letting anyone flag every recent conversation
    // would let strangers extend retention on (and mark) other people's
    // conversations. Rate-limited per IP as well; the response page is the
    // same either way so nothing leaks.
    const ip = senderIp(c);
    if (await rateCount(c.env.DB, 'report', ip, 3600) < 5) {
      await rateHit(c.env.DB, 'report', ip);
      await c.env.DB.prepare(
        `UPDATE conversations SET reported = 1, report_reason = COALESCE(report_reason, 'sticker report')
         WHERE car_id = ? AND sender_ip = ? AND last_msg_at >= datetime('now', '-1 day')`,
      ).bind(car.id, ip).run();
    }
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
  // The send handler demands a captcha after 2 messages, so the form must
  // actually show one here — without it follow-up messages dead-end.
  const prior = await senderMessageCount(c.env.DB, senderIp(c), conv.sender_key);
  const captcha = prior >= 2 && !conv.blocked ? await makeCaptcha(c.env.DB) : null;
  return c.html(threadPage({ lang: l, conv, car, messages, canSend: !conv.blocked, captcha }));
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
    if (!ok) {
      // Back to the thread with a fresh captcha and the reason, not a dead end.
      const car2 = await c.env.DB.prepare('SELECT * FROM cars WHERE id = ?').bind(conv.car_id).first();
      const { results: messages } = await c.env.DB.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
      ).bind(conv.id).all();
      const captcha = await makeCaptcha(c.env.DB);
      return c.html(threadPage({ lang: l, conv, car: car2, messages, canSend: true, captcha, notice: t.wrongCaptcha }), 400);
    }
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

app.post('/api/cars/:id/edit', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const body = await c.req.parseBody();
  const carType = String(body.car_type || '').trim().slice(0, 80);
  const plate = String(body.plate || '').trim().slice(0, 30);
  if (!carType || !plate) return c.html(simplePage('ar', 'بيانات ناقصة', 'نوع العربية واللوحة لازم يكونوا موجودين.'), 400);
  await c.env.DB.prepare('UPDATE cars SET car_type = ?, plate = ? WHERE id = ? AND owner_id = ?')
    .bind(carType, plate, c.req.param('id'), owner.id).run();
  return redirect('/app');
});

app.post('/api/cars/:id/:op', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const op = c.req.param('op');
  if (!['disable', 'enable', 'delete'].includes(op)) return c.notFound();
  const carId = c.req.param('id');
  if (op === 'delete') {
    // Remove the car with everything attached: photos, messages, conversations.
    const car = await c.env.DB.prepare('SELECT id FROM cars WHERE id = ? AND owner_id = ?').bind(carId, owner.id).first();
    if (!car) return c.notFound();
    await c.env.DB.prepare(
      `DELETE FROM photos WHERE key IN (SELECT m.photo_key FROM messages m JOIN conversations co ON co.id = m.conversation_id WHERE co.car_id = ? AND m.photo_key IS NOT NULL)`,
    ).bind(carId).run();
    await c.env.DB.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE car_id = ?)').bind(carId).run();
    await c.env.DB.prepare('DELETE FROM conversations WHERE car_id = ?').bind(carId).run();
    await c.env.DB.prepare('DELETE FROM cars WHERE id = ? AND owner_id = ?').bind(carId, owner.id).run();
    return redirect('/app');
  }
  await c.env.DB.prepare('UPDATE cars SET disabled = ? WHERE id = ? AND owner_id = ?').bind(op === 'disable' ? 1 : 0, carId, owner.id).run();
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

app.post('/api/settings/password', async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return redirect('/login');
  const body = await c.req.parseBody();
  const { hash } = await hashPassword(String(body.current_password || ''), owner.password_salt);
  if (!timingSafeEqual(hash, owner.password_hash)) {
    return c.html(simplePage('ar', 'كلمة السر الحالية غلط', 'كلمة السر الحالية مش صح، فمفيش حاجة اتغيرت.'), 400);
  }
  const newPassword = String(body.new_password || '');
  if (newPassword.length < 8) {
    return c.html(simplePage('ar', 'كلمة سر ضعيفة', 'كلمة السر الجديدة لازم تكون ٨ حروف على الأقل.'), 400);
  }
  const fresh = await hashPassword(newPassword);
  await c.env.DB.prepare('UPDATE owners SET password_hash = ?, password_salt = ? WHERE id = ?').bind(fresh.hash, fresh.salt, owner.id).run();
  // A password change signs out every session, including this one.
  await c.env.DB.prepare('DELETE FROM sessions WHERE owner_id = ?').bind(owner.id).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/login', 'set-cookie': sessionCookie(c, '', 0) },
  });
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
  // Only the owner's own conversations may be counted.
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m
     JOIN conversations co ON co.id = m.conversation_id
     JOIN cars ca ON ca.id = co.car_id
     WHERE m.conversation_id = ? AND ca.owner_id = ?`,
  ).bind(c.req.param('id'), owner.id).first();
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

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#123c2b"/><text x="256" y="330" font-family="Arial, sans-serif" font-size="220" font-weight="700" fill="#ffffff" text-anchor="middle">SP</text></svg>`;

app.get('/icon.svg', (c) => new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } }));

app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'SafePark',
    short_name: 'SafePark',
    start_url: '/app',
    display: 'standalone',
    background_color: '#f6f7f6',
    theme_color: '#123c2b',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }),
);

app.get('/sw.js', (c) => {
  const js = `self.addEventListener('push', function(event){
  event.waitUntil((async function(){
    let title = 'SafePark', body = 'وصلت رسالة جديدة';
    try {
      // /api/unseen has no read-tracking, so never claim a count here:
      // the generic text stays true no matter how many messages exist.
      await fetch('/api/unseen');
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
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();

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
