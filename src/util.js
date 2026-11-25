// Small shared helpers (WebCrypto only, worker-safe).

export function uid(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function carCode() {
  // 6-char unambiguous code for the QR URL.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => alphabet[x % alphabet.length]).join('');
}

const te = new TextEncoder();

export function buf2hex(buf) {
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? hex2buf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { hash: buf2hex(bits), salt: buf2hex(salt) };
}

function hex2buf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function maskPlate(plate) {
  if (!plate) return '';
  const chars = [...String(plate).replace(/\s+/g, ' ').trim()];
  if (chars.length <= 2) return chars.join('');
  return chars[0] + ' ' + chars.slice(1, -1).map((c) => (c === ' ' ? ' ' : '•')).join('') + ' ' + chars[chars.length - 1];
}

export function wantsArabic(acceptLanguage) {
  return /(^|[,;\s])ar([-,;]|$)/i.test(acceptLanguage || '');
}

export function minutesNowCairo() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = +(parts.find((p) => p.type === 'hour')?.value || 0);
  const m = +(parts.find((p) => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

export function inQuietHours(owner) {
  if (owner.unavailable) return true;
  if (owner.quiet_start == null || owner.quiet_end == null) return false;
  const now = minutesNowCairo();
  const s = owner.quiet_start, e = owner.quiet_end;
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}
