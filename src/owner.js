// Owner-facing pages: dashboard, conversation, settings, printable sticker.

import { layout } from './html.js';
import { escapeHtml as e, maskPlate } from './util.js';

const T = {
  dashboard: 'لوحة التحكم',
  cars: 'عربياتي',
  addCar: 'أضف عربية',
  carType: 'النوع واللون',
  plate: 'اللوحة',
  convs: 'المحادثات',
  noConvs: 'لسه مفيش رسايل. امسح الكود من موبايل تاني وجرّب.',
  sticker: 'الملصق',
  senderLink: 'لينك المرسل',
  disable: 'تعطيل الملصق',
  enable: 'تفعيل الملصق',
  disabledTag: 'معطل',
  settings: 'الإعدادات',
  quiet: 'ساعات الهدوء (بتوقيت القاهرة)',
  from: 'من',
  to: 'إلى',
  unavailable: 'مش متاح دلوقتي (كل الإشعارات غير العاجلة تتأجل)',
  save: 'حفظ',
  telegram: 'إشعارات تيليجرام',
  telegramHow: 'افتح بوت SafePark في تيليجرام وابعت أمر الربط اللي فيه الكود ده (الكود بيظهر هنا بس وبيتلغي بعد أول ربط ناجح):',
  blockedTag: 'مقيّد',
  reportedTag: 'مُبلغ عنه',
  block: 'حظر المرسل',
  unblock: 'فك الحظر',
  replyPh: 'اكتب ردك…',
  quick: 'ردود سريعة',
  openThread: 'فتح',
  newMsg: 'وصلت رسالة جديدة',
};

export function dashboardPage({ owner, cars, convsByCar, origin }) {
  const carCards = cars
    .map((car) => {
      const convs = (convsByCar[car.id] || [])
        .map(
          (c) => `<div class="row"><span>${c.blocked ? `🚫 ${T.blockedTag} · ` : ''}${c.reported ? `⚠️ ${T.reportedTag} · ` : ''}${e(c.last_msg_at)}</span>
          <a class="btn secondary" href="/app/conv/${e(c.id)}">${T.openThread}</a></div>`,
        )
        .join('<hr>');
      return `<div class="card">
        <div class="row"><h2>${e(car.car_type)} ${car.disabled ? `<span class="muted">(${T.disabledTag})</span>` : ''}</h2>
        <span class="muted" dir="ltr">${e(maskPlate(car.plate))}</span></div>
        <div class="row">
          <a class="btn secondary" href="/sticker/${e(car.code)}">${T.sticker}</a>
          <form method="post" action="/api/cars/${e(car.id)}/${car.disabled ? 'enable' : 'disable'}">
            <button type="submit" class="${car.disabled ? '' : 'danger'}">${car.disabled ? T.enable : T.disable}</button>
          </form>
        </div>
        <p class="muted" dir="ltr">${T.senderLink}: ${e(origin)}/c/${e(car.code)}</p>
        ${convs || `<p class="muted">${T.noConvs}</p>`}
      </div>`;
    })
    .join('');

  const quietS = owner.quiet_start == null ? '' : fmtMin(owner.quiet_start);
  const quietE = owner.quiet_end == null ? '' : fmtMin(owner.quiet_end);
  const body = `
  <div class="brand"><div class="dot">SP</div><h1>${T.dashboard}</h1><span id="bell"></span></div>
  <div class="card"><h2>${T.addCar}</h2>
    <form method="post" action="/api/cars">
      <label>${T.carType}</label><input name="car_type" required>
      <label>${T.plate}</label><input name="plate" required>
      <button class="full" type="submit">${T.addCar}</button>
    </form>
  </div>
  ${carCards}
  <div class="card"><h2>${T.settings}</h2>
    <form method="post" action="/api/settings">
      <label>${T.quiet}</label>
      <div class="row">
        <span>${T.from} <input style="width:90px" type="time" name="quiet_start" value="${quietS}"></span>
        <span>${T.to} <input style="width:90px" type="time" name="quiet_end" value="${quietE}"></span>
      </div>
      <label class="row"><span>${T.unavailable}</span>
      <input style="width:auto" type="checkbox" name="unavailable" ${owner.unavailable ? 'checked' : ''}></label>
      <button class="full" type="submit">${T.save}</button>
    </form>
    <hr>
    <h2>${T.telegram}</h2>
    <p class="muted">${T.telegramHow}</p>
    ${owner.telegram_bind_token ? `<p dir="ltr" style="font-family:monospace">/start ${e(owner.telegram_bind_token)}</p>` : ''}
    <p class="muted" dir="ltr">${owner.telegram_chat_id ? '✅ linked' : 'not linked'}</p>
  </div>
  <script>
    let last = null;
    function beep(){
      try{
        const ctx = new (window.AudioContext||window.webkitAudioContext)();
        [880, 1174.66].forEach(function(f, i){
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
          g.gain.setValueAtTime(0.15, ctx.currentTime + i*0.18);
          o.start(ctx.currentTime + i*0.18); o.stop(ctx.currentTime + i*0.18 + 0.16);
        });
      }catch(_){}
    }
    async function poll(){
      try{
        const r = await fetch('/api/unseen');
        if(!r.ok) return;
        const d = await r.json();
        if(last !== null && d.latest !== last){ beep(); location.reload(); }
        last = d.latest;
      }catch(_){}
    }
    poll(); setInterval(poll, 10000);
  </script>`;
  return layout('ar', T.dashboard, body);
}

function fmtMin(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function convPage({ conv, car, messages }) {
  const msgs = messages
    .map((m) => {
      const cls = m.direction === 'in' ? 'in' : 'out';
      const who = m.direction === 'in' ? 'المرسل' : 'أنت';
      const photo = m.photo_key
        ? `<br><img class="photo blurred" src="/photo/${e(m.photo_key)}" onclick="this.classList.remove('blurred')" loading="lazy">`
        : '';
      const held = m.held ? ' <span class="muted">(اتأجل إشعارها — ساعات هدوء)</span>' : '';
      return `<div class="msg ${cls}"><div class="muted">${e(who)}${held}</div>${m.reason ? `<strong>${e(m.reason)}</strong><br>` : ''}${e(m.body)}${photo}</div>`;
    })
    .join('');
  const body = `
  <div class="brand"><div class="dot">SP</div><h1>${e(car.car_type)}</h1></div>
  <div class="row">
    <a class="btn secondary" href="/app">← ${T.dashboard}</a>
    <form method="post" action="/api/conv/${e(conv.id)}/${conv.blocked ? 'unblock' : 'block'}">
      <button type="submit" class="${conv.blocked ? '' : 'danger'}">${conv.blocked ? T.unblock : T.block}</button>
    </form>
  </div>
  <div class="card thread">${msgs || '<p class="muted">…</p>'}</div>
  <div class="card">
    <h2>${T.quick}</h2>
    <div class="chips">
      <form method="post" action="/api/conv/${e(conv.id)}/reply"><input type="hidden" name="body" value="جاي في دقيقتين"><button class="chip" type="submit">جاي في دقيقتين</button></form>
      <form method="post" action="/api/conv/${e(conv.id)}/reply"><input type="hidden" name="body" value="جاي خلال ٥ دقايق"><button class="chip" type="submit">جاي خلال ٥ دقايق</button></form>
      <form method="post" action="/api/conv/${e(conv.id)}/reply"><input type="hidden" name="body" value="مش قادر دلوقتي"><button class="chip" type="submit">مش قادر دلوقتي</button></form>
    </div>
    <form method="post" action="/api/conv/${e(conv.id)}/reply">
      <textarea name="body" maxlength="1000" required placeholder="${T.replyPh}"></textarea>
      <button class="full" type="submit">إرسال</button>
    </form>
  </div>
  <script>
    setInterval(async function(){
      try{
        const r = await fetch('/api/convcount/${e(conv.id)}');
        if(!r.ok) return;
        const d = await r.json();
        if(d.count !== ${messages.length}) location.reload();
      }catch(_){}
    }, 8000);
  </script>`;
  return layout('ar', e(car.car_type), body);
}

export function stickerPage({ car, origin, qrSvg, minimal = false }) {
  const url = `${origin}/c/${car.code}`;
  const printNote = `<p class="noprint muted">اطبع الصفحة دي (Ctrl+P). مقاس مناسب: نص A4 للعربية، ربع A4 للموتوسيكل. استخدم ورق مقاوم للشمس أو غلّفه بلاستيك.</p>`;
  if (minimal) {
    const body = `
  <div class="card" style="border:2px dashed #999; text-align:center">
    <div style="display:flex;justify-content:center">${qrSvg}</div>
    <p><strong>محتاج صاحب العربية؟ امسح الكود وابعتله رسالة دلوقتي وهيرد عليك بسرعة</strong><br>
    <span class="muted" dir="ltr" style="font-size:13px">Need the car owner? Scan the code and send a message now. They&#39;ll reply quickly.</span></p>
  </div>
  <p class="noprint muted"><a href="/sticker/${e(car.code)}">النسخة الكاملة</a></p>
  ${printNote}`;
    return layout('ar', 'ملصق مختصر', body);
  }
  const body = `
  <div class="card" style="border:2px dashed #999; text-align:center">
    <h1>SafePark</h1>
    <div style="display:flex;justify-content:center">${qrSvg}</div>
    <h2>${e(car.car_type)}</h2>
    <p dir="ltr">${e(maskPlate(car.plate))}</p>
    <p><strong>امسح الكود وابعت رسالة لصاحب العربية</strong><br>
    <span class="muted" dir="ltr">Scan to message the car owner — no app needed</span></p>
    <p class="warn" style="text-align:start">متدفعش فلوس لأي حد عن طريق الصفحة، ومتبعتش بيانات بنكية.<br>
    <span dir="ltr">Never send money or banking details through this page.</span></p>
    <p class="muted" dir="ltr">${e(url)}</p>
  </div>
  <p class="noprint muted"><a href="/sticker/${e(car.code)}?minimal=1">نسخة مختصرة للطباعة (كود وسطر واحد بس)</a></p>
  ${printNote}`;
  return layout('ar', `SafePark — ${e(car.car_type)}`, body);
}
