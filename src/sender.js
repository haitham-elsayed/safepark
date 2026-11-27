// Sender-facing pages: the QR landing page and the private follow-up page.

import { layout } from './html.js';
import { escapeHtml as e, maskPlate } from './util.js';

export const REASONS = [
  { key: 'blocking', ar: 'حاجزني', en: 'You are blocking me', urgent: false },
  { key: 'lights', ar: 'النور مولع', en: 'Your lights are on', urgent: true },
  { key: 'window', ar: 'الشباك مفتوح', en: 'A window is open', urgent: false },
  { key: 'scratch', ar: 'حصل احتكاك', en: 'There was a scrape/bump', urgent: true },
  { key: 'other', ar: 'سبب آخر', en: 'Other', urgent: false },
];

const T = {
  ar: {
    title: 'رسالة لصاحب العربية',
    thisCar: 'العربية:',
    plateIs: 'اللوحة:',
    confirmCar: 'اتأكد إن دي العربية اللي قدامك قبل الإرسال.',
    why: 'سبب الرسالة',
    msg: 'رسالتك',
    msgPh: 'اكتب رسالتك هنا…',
    photo: 'صورة (اختياري)',
    photoNote: 'الصورة تظهر مضببة لصاحب العربية لحد ما يضغط عليها، وبنمسح بيانات الموقع منها.',
    emailOpt: 'إيميلك (اختياري) لو عايز تنبيه لما يرد — مش هيظهر له',
    send: 'إرسال',
    plateDigits: 'آخر ٣ أرقام من اللوحة',
    captchaQ: 'تأكيد إنك إنسان: كم ناتج',
    scam: 'تحذير: الصفحة دي للتواصل عن العربية فقط. ممنوع أي طلب فلوس أو بيانات بنكية أو كلمات سر. لو حد طلب منك كده، بلّغ فوراً.',
    report: 'إبلاغ عن إساءة',
    sent: 'وصلت رسالتك لصاحب العربية.',
    sentNote: 'ده تأكيد إن النظام استلمها فقط. احتفظ باللينك الخاص ده لمتابعة الرد:',
    yourLink: 'لينك المتابعة الخاص بيك',
    waitReply: 'لو رد عليك، هيظهر هنا تلقائياً.',
    reply: 'رد صاحب العربية',
    you: 'أنت',
    sendMore: 'ابعت رسالة تانية',
    blocked: 'صاحب العربية قيّد الرسائل على المحادثة دي.',
    disabled: 'الملصق ده متعطل حالياً.',
    notFound: 'الكود ده مش موجود. اتأكد إنك مسحت الكود الصح على الدومين الرسمي.',
    rateLimit: 'وصلت للحد الأقصى للرسائل. جرب بعد شوية.',
    wrongCaptcha: 'إجابة التأكيد غلط، حاول تاني.',
    wrongPlate: 'أرقام اللوحة مش مطابقة.',
    photoRejected: 'الصورة مرفوضة: لازم تكون JPEG أو PNG أو WebP وحجمها أقل من ١٫٥ ميجا. الرسالة ما اتبعتتش، جرب من غير الصورة أو بصورة أصغر.',
    reportDone: 'وصل بلاغك. شكراً.',
    receivedOnly: 'تُظهر الصفحة استلام النظام فقط، ولا تُظهر قراءة صاحب العربية.',
  },
  en: {
    title: 'Message the car owner',
    thisCar: 'Car:',
    plateIs: 'Plate:',
    confirmCar: 'Confirm this is the car in front of you before sending.',
    why: 'Reason',
    msg: 'Your message',
    msgPh: 'Write your message here…',
    photo: 'Photo (optional)',
    photoNote: 'The photo appears blurred to the owner until tapped. Location metadata is removed.',
    emailOpt: 'Your email (optional) to get notified on reply — never shown to the owner',
    send: 'Send',
    plateDigits: 'Last 3 plate digits',
    captchaQ: 'Human check: what is',
    scam: 'Warning: this page is only for contacting about the car. Never send money, banking data or passwords. If anyone asks, report it.',
    report: 'Report abuse',
    sent: 'Your message was delivered to the owner.',
    sentNote: 'This only confirms the system received it. Keep your private link to follow the reply:',
    yourLink: 'Your private follow-up link',
    waitReply: 'If the owner replies, it appears here automatically.',
    reply: 'Owner reply',
    you: 'You',
    sendMore: 'Send another message',
    blocked: 'The owner has limited messages on this conversation.',
    disabled: 'This sticker is currently disabled.',
    notFound: 'Code not found. Make sure you scanned the official sticker on the official domain.',
    rateLimit: 'Message limit reached. Try again later.',
    wrongCaptcha: 'Wrong check answer, try again.',
    wrongPlate: 'Plate digits do not match.',
    photoRejected: 'Photo rejected: it must be a JPEG, PNG or WebP under 1.5 MB. Your message was not sent; try without the photo or with a smaller one.',
    reportDone: 'Your report was received. Thank you.',
    receivedOnly: 'The page shows system delivery only, never whether the owner read it.',
  },
};

export function tr(lang) {
  return T[lang] || T.en;
}

export function senderPage({ lang, car, captcha, plateCheck, error, origin }) {
  const t = tr(lang);
  const reasonChips = REASONS.map(
    (r) => `<button type="button" class="chip" data-reason="${e(r.key)}" data-urgent="${r.urgent ? 1 : 0}" data-label="${e(lang === 'ar' ? r.ar : r.en)}">${e(lang === 'ar' ? r.ar : r.en)}</button>`,
  ).join('');
  const captchaBlock = captcha
    ? `<label>${t.captchaQ} ${e(captcha.question)}؟</label>
       <input name="captcha_answer" inputmode="numeric" required>
       <input type="hidden" name="captcha_id" value="${e(captcha.id)}">`
    : '';
  const plateBlock = plateCheck
    ? `<label>${t.plateDigits}</label><input name="plate_digits" inputmode="numeric" maxlength="3" required>`
    : '';
  const err = error ? `<div class="warn">${e(error)}</div>` : '';
  const body = `
  <div class="brand"><div class="dot">SP</div><h1>${t.title}</h1></div>
  <div class="card">
    <div class="row"><strong>${t.thisCar}</strong><span>${e(car.car_type)}</span></div>
    ${car.plate ? `<div class="row"><strong>${t.plateIs}</strong><span dir="ltr">${e(maskPlate(car.plate))}</span></div>` : ''}
    <p class="muted">${t.confirmCar}</p>
  </div>
  ${err}
  <div class="card">
    <form method="post" action="/api/c/${e(car.code)}/send" enctype="multipart/form-data">
      <label>${t.why}</label>
      <div class="chips">${reasonChips}</div>
      <input type="hidden" name="reason" id="reason">
      <label>${t.msg}</label>
      <textarea name="body" placeholder="${t.msgPh}" maxlength="1000" required></textarea>
      ${plateBlock}
      ${captchaBlock}
      <label>${t.photo}</label>
      <input type="file" name="photo" accept="image/jpeg,image/png,image/webp">
      <p class="muted">${t.photoNote}</p>
      <label>${t.emailOpt}</label>
      <input type="email" name="sender_email">
      <button class="full" type="submit">${t.send}</button>
    </form>
  </div>
  <div class="warn">${t.scam}</div>
  <form method="post" action="/api/c/${e(car.code)}/report" onsubmit="return confirm('${t.report}?')">
    <button type="submit" class="secondary full">${t.report}</button>
  </form>
  <p class="muted">${t.receivedOnly}</p>
  <p class="muted" dir="ltr">${e(origin)}</p>
  <script>
    document.querySelectorAll('.chip').forEach(function(c){
      c.addEventListener('click', function(){
        document.querySelectorAll('.chip').forEach(function(x){x.classList.remove('on')});
        c.classList.add('on');
        document.getElementById('reason').value = c.dataset.label;
      });
    });
  </script>`;
  return layout(lang, t.title, body);
}

export function sentPage({ lang, conv, followUrl }) {
  const t = tr(lang);
  const body = `
  <div class="card">
    <h1>${t.sent}</h1>
    <p>${t.sentNote}</p>
    <p><a class="btn full" href="${e(followUrl)}">${t.yourLink}</a></p>
    <p class="muted">${t.waitReply}</p>
    <p class="muted">${t.receivedOnly}</p>
  </div>`;
  return layout(lang, t.sent, body);
}

export function threadPage({ lang, conv, car, messages, canSend, notice, captcha }) {
  const t = tr(lang);
  const msgs = messages
    .map((m) => {
      const cls = m.direction === 'in' ? 'in' : 'out';
      const who = m.direction === 'in' ? t.you : t.reply;
      const photo = m.photo_key
        ? `<br><img class="photo blurred" src="/photo/${e(m.photo_key)}?k=${e(conv.sender_key)}" onclick="this.classList.remove('blurred')" loading="lazy">`
        : '';
      return `<div class="msg ${cls}"><div class="muted">${e(who)}</div>${m.reason ? `<strong>${e(m.reason)}</strong><br>` : ''}${e(m.body)}${photo}</div>`;
    })
    .join('');
  const captchaBlock = captcha
    ? `<label>${t.captchaQ} ${e(captcha.question)}؟</label>
       <input name="captcha_answer" inputmode="numeric" required>
       <input type="hidden" name="captcha_id" value="${e(captcha.id)}">`
    : '';
  const sendBox = canSend
    ? `<form method="post" action="/api/thread/${e(conv.id)}/${e(conv.sender_key)}/send">
        <textarea name="body" maxlength="1000" required placeholder="${t.msgPh}"></textarea>
        ${captchaBlock}
        <button class="full" type="submit">${t.sendMore}</button>
      </form>`
    : `<div class="warn">${t.blocked}</div>`;
  const body = `
  <div class="brand"><div class="dot">SP</div><h1>${e(car.car_type)}</h1></div>
  ${notice ? `<div class="warn">${e(notice)}</div>` : ''}
  <div class="card thread" id="thread">${msgs}</div>
  ${sendBox}
  <p class="muted">${t.waitReply}</p>
  <script>
    setInterval(async function(){
      try{
        const r = await fetch('/api/thread/${e(conv.id)}/${e(conv.sender_key)}');
        if(!r.ok) return;
        const data = await r.json();
        if(data.count !== ${messages.length}) location.reload();
      }catch(_){}
    }, 8000);
  </script>`;
  return layout(lang, `${t.title} — ${e(car.car_type)}`, body);
}

export function simplePage(lang, title, message) {
  return layout(lang, title, `<div class="card"><h1>${e(title)}</h1><p>${e(message)}</p></div>`);
}
