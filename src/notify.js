// Notification channels: Telegram bot, email (Resend), web push (VAPID tickle).
// Every channel is env-gated: with no key configured it is skipped silently.

import { SignJWT, importPKCS8 } from 'jose';

export async function notifyOwner(env, owner, conv, msg, car) {
  if (msg.held) return { held: true };
  const results = {};
  const origin = env.APP_ORIGIN || '';
  const convUrl = `${origin}/app/conv/${conv.id}`;
  const title = `رسالة جديدة عن ${car.car_type}`;
  const text = `${msg.reason ? msg.reason + ' — ' : ''}${msg.body}`;

  if (env.TELEGRAM_BOT_TOKEN && owner.telegram_chat_id) {
    results.telegram = await sendTelegram(env, owner.telegram_chat_id, title, text, convUrl, conv.id).catch((e) => `error: ${e.message}`);
  }
  if (env.RESEND_API_KEY && owner.notify_email && owner.email) {
    results.email = await sendEmail(env, owner.email, title, text, convUrl).catch((e) => `error: ${e.message}`);
  }
  if (env.VAPID_PRIVATE_KEY && owner.notify_push) {
    results.push = await sendPushTickles(env, owner.id).catch((e) => `error: ${e.message}`);
  }
  return results;
}

async function sendTelegram(env, chatId, title, text, convUrl, convId) {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'جاي في دقيقتين', callback_data: `qr:${convId}:1` },
        { text: 'جاي خلال ٥ دقايق', callback_data: `qr:${convId}:2` },
        { text: 'مش قادر دلوقتي', callback_data: `qr:${convId}:3` },
      ],
      [{ text: 'فتح المحادثة', url: convUrl }],
    ],
  };
  const res = await fetch(`${api}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${title}\n\n${text}`, reply_markup: keyboard }),
  });
  const data = await res.json();
  return data.ok ? 'sent' : `telegram: ${data.description}`;
}

async function sendEmail(env, to, subject, text, convUrl) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'SafePark <alerts@resend.dev>',
      to: [to],
      subject,
      html: `<p dir="rtl">${escape(text)}</p><p><a href="${convUrl}">فتح المحادثة</a></p>`,
    }),
  });
  return res.ok ? 'sent' : `email: HTTP ${res.status}`;
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Push "tickle": empty-payload push that wakes the service worker, which then
// fetches /api/unseen and shows a local notification. No payload encryption needed.
async function sendPushTickles(env, ownerId) {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subs WHERE owner_id = ?').bind(ownerId).all();
  if (!results?.length) return 'no subs';
  const pkcs8 = b64urlToPem(env.VAPID_PRIVATE_KEY);
  const key = await importPKCS8(pkcs8, 'ES256');
  let sent = 0;
  for (const { endpoint } of results) {
    try {
      const aud = new URL(endpoint).origin;
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
        .setAudience(aud)
        .setSubject(env.VAPID_SUBJECT || 'mailto:owner@example.com')
        .setExpirationTime('12h')
        .setIssuedAt()
        .sign(key);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, ttl: '2419200' },
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
      } else if (res.status >= 400) {
        return `push: HTTP ${res.status}`;
      } else sent++;
    } catch (e) {
      return `push: ${e.message}`;
    }
  }
  return `sent ${sent}`;
}

function b64urlToPem(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const body = b64.replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

// Telegram bot webhook: /start deep-link (bind chat), callback quick replies.
export async function handleTelegramUpdate(env, update) {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const post = (method, payload) =>
    fetch(`${api}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  const msg = update.message;
  if (msg?.text?.startsWith('/start')) {
    const owner = await env.DB.prepare('SELECT id, telegram_chat_id, telegram_bind_token FROM owners ORDER BY created_at LIMIT 1').first();
    if (!owner) return;
    const chatId = String(msg.chat.id);
    // Already bound to this chat: nothing to do, no token needed.
    if (owner.telegram_chat_id === chatId) {
      await post('sendMessage', { chat_id: msg.chat.id, text: 'إشعارات SafePark مربوطة بالحساب ده بالفعل.' });
      return;
    }
    // Binding (or rebinding to a different chat) requires the one-time code
    // shown only in the owner's dashboard. A bare /start must never bind:
    // anyone who finds the bot could otherwise hijack the owner's alerts.
    const token = msg.text.trim().split(/\s+/)[1] || '';
    if (!token || !owner.telegram_bind_token || token !== owner.telegram_bind_token) {
      await post('sendMessage', { chat_id: msg.chat.id, text: 'للربط، ابعت الكود اللي ظاهر في لوحة تحكم SafePark بالشكل ده: /start <الكود>' });
      return;
    }
    await env.DB.prepare('UPDATE owners SET telegram_chat_id = ?, telegram_bind_token = NULL WHERE id = ?').bind(chatId, owner.id).run();
    await post('sendMessage', { chat_id: msg.chat.id, text: 'تم ربط إشعارات SafePark بهذا الحساب.' });
    return;
  }
  const cq = update.callback_query;
  if (cq?.data?.startsWith('qr:')) {
    // Quick replies act as the owner: only accept them from the bound chat.
    const owner = await env.DB.prepare('SELECT telegram_chat_id FROM owners ORDER BY created_at LIMIT 1').first();
    const fromChat = cq.message?.chat?.id;
    if (!owner?.telegram_chat_id || fromChat == null || String(fromChat) !== String(owner.telegram_chat_id)) {
      await post('answerCallbackQuery', { callback_query_id: cq.id, text: 'الحساب ده مش مربوط بـ SafePark' });
      return;
    }
    const [, convId, choice] = cq.data.split(':');
    const replies = { 1: 'جاي في دقيقتين', 2: `جاي خلال ٥ دقايق (${arrivalTime(5)})`, 3: 'مش قادر دلوقتي' };
    const body = replies[choice];
    const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first();
    if (conv && body) {
      await env.DB.prepare(`INSERT INTO messages (id, conversation_id, direction, body) VALUES (?, ?, 'out', ?)`)
        .bind(crypto.randomUUID(), convId, body)
        .run();
      await post('answerCallbackQuery', { callback_query_id: cq.id, text: 'اتبعت الرد' });
      return;
    }
    await post('answerCallbackQuery', { callback_query_id: cq.id, text: 'المحادثة مش موجودة' });
  }
}

function arrivalTime(minutes) {
  const t = new Date(Date.now() + minutes * 60000);
  return new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', hour: 'numeric', minute: '2-digit' }).format(t);
}
