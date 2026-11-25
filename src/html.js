// Shared HTML layout and owner-auth pages (landing, setup, login).

import { escapeHtml as e } from './util.js';

export const STR = {
  ar: {
    appName: 'SafePark',
    tagline: 'ملصق على عربيتك يخلّي أي حد يبعتلك رسالة من غير ما يظهر رقمك.',
    login: 'دخول المالك',
    email: 'البريد الإلكتروني',
    password: 'كلمة السر',
    enter: 'دخول',
    wrongLogin: 'بيانات الدخول غير صحيحة.',
    setupTitle: 'إعداد أول مرة',
    carType: 'نوع ولون العربية (مثال: سيدان بيضاء)',
    plate: 'رقم اللوحة (لن يظهر كامل للمرسل)',
    start: 'ابدأ',
    setupDone: 'تم الإعداد. سجّل دخولك دلوقتي.',
    what: 'إزاي بيشتغل؟',
    how1: 'اطبع الملصق وحطّه على زجاج عربيتك.',
    how2: 'أي حد يمسح الكود يفتح صفحة ويكتب لك من غير حساب ولا تطبيق.',
    how3: 'يوصلك إشعار وترد عليه من نفس المكان. رقمك لا يظهر أبداً.',
  },
  en: {
    appName: 'SafePark',
    tagline: 'A sticker on your car lets anyone message you without revealing your number.',
    login: 'Owner sign-in',
    email: 'Email',
    password: 'Password',
    enter: 'Sign in',
    wrongLogin: 'Wrong email or password.',
    setupTitle: 'First-time setup',
    carType: 'Car type and color (e.g. White sedan)',
    plate: 'Plate number (never shown in full)',
    start: 'Start',
    setupDone: 'Setup complete. You can sign in now.',
    what: 'How it works',
    how1: 'Print the sticker and place it on your windshield.',
    how2: 'Anyone scans the code and writes to you. No account, no app.',
    how3: 'You get a notification and reply from the same place. Your number is never shown.',
  },
};

export function layout(lang, title, body, extraHead = '') {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#123c2b">
<link rel="manifest" href="/manifest.webmanifest">
<title>${e(title)}</title>
<style>
:root{--g:#123c2b;--a:#1f7a4d;--bg:#f6f7f6;--warn:#fff7e6;--danger:#b3261e}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;background:var(--bg);color:#1c1c1c}
.wrap{max-width:560px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:14px;padding:18px;margin:12px 0;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:1.35rem;margin:.2em 0;color:var(--g)}
h2{font-size:1.05rem;margin:.4em 0;color:var(--g)}
.brand{display:flex;align-items:center;gap:10px;padding:14px 0}
.brand .dot{width:34px;height:34px;border-radius:10px;background:var(--g);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
label{display:block;font-size:.9rem;margin:10px 0 4px;color:#444}
input,textarea,select{width:100%;padding:11px;border:1px solid #cfd6d2;border-radius:10px;font-size:1rem;background:#fff}
textarea{min-height:90px;resize:vertical}
button,.btn{display:inline-block;background:var(--a);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:1rem;cursor:pointer;text-decoration:none;text-align:center}
button.secondary,.btn.secondary{background:#e6ece9;color:var(--g)}
button.danger{background:var(--danger)}
.full{width:100%;margin-top:12px}
.muted{color:#6b7770;font-size:.85rem}
.warn{background:var(--warn);border:1px solid #f0dfae;border-radius:10px;padding:10px;font-size:.85rem;margin:10px 0}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.chip{border:1px solid var(--a);color:var(--g);background:#eef6f1;border-radius:999px;padding:8px 14px;font-size:.9rem;cursor:pointer}
.chip.on{background:var(--a);color:#fff}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between}
.msg{padding:10px 12px;border-radius:12px;margin:8px 0;max-width:90%}
.msg.in{background:#eef2f0;align-self:flex-start}
.msg.out{background:#dff0e6;align-self:flex-end;margin-inline-start:auto}
.thread{display:flex;flex-direction:column}
.blurred{filter:blur(14px);cursor:pointer;transition:filter .2s}
img.photo{max-width:100%;border-radius:10px;margin-top:6px}
hr{border:0;border-top:1px solid #e3e8e5;margin:14px 0}
@media print{.noprint{display:none!important}body{background:#fff}}
</style>
${extraHead}
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

export function landing(lang) {
  const t = STR[lang];
  return layout(
    lang,
    t.appName,
    `<div class="brand"><div class="dot">SP</div><h1>${t.appName}</h1></div>
     <div class="card"><p>${t.tagline}</p>
     <h2>${t.what}</h2><ol><li>${t.how1}</li><li>${t.how2}</li><li>${t.how3}</li></ol></div>
     <a class="btn full" href="/login">${t.login}</a>`,
  );
}

export function loginPage(lang, error = '') {
  const t = STR[lang];
  return layout(
    lang,
    t.login,
    `<div class="card"><h1>${t.login}</h1>
     ${error ? `<div class="warn">${e(error)}</div>` : ''}
     <form method="post" action="/api/login">
       <label>${t.email}</label><input name="email" type="email" required>
       <label>${t.password}</label><input name="password" type="password" required>
       <button class="full" type="submit">${t.enter}</button>
     </form></div>`,
  );
}

export function setupPage(lang, key = '') {
  const t = STR[lang];
  return layout(
    lang,
    t.setupTitle,
    `<div class="card"><h1>${t.setupTitle}</h1>
     <form method="post" action="/api/setup">
       <input type="hidden" name="key" value="${e(key)}">
       <label>${t.email}</label><input name="email" type="email" required>
       <label>${t.password}</label><input name="password" type="password" minlength="8" required>
       <label>${t.carType}</label><input name="car_type" required>
       <label>${t.plate}</label><input name="plate" required>
       <button class="full" type="submit">${t.start}</button>
     </form></div>`,
  );
}
