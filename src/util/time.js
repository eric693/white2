// 台北時區的牆上時鐘工具。前端 datetime-local 送來的是本地時間字串，
// 全站排程一律以台北時間字串比較，避免 UTC 誤差。
const TZ = 'Asia/Taipei';

function parts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  }).formatToParts(date);
  const g = t => (f.find(p => p.type === t) || {}).value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: +g('year'), mo: +g('month'), d: +g('day'),
    hh: g('hour'), mm: g('minute'), ss: g('second'),
    dow: dowMap[g('weekday')]
  };
}

// 'YYYY-MM-DDTHH:MM'（分鐘精度，供與 datetime-local 比較）
function localNowMinute(date = new Date()) {
  const p = parts(date);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${p.hh}:${p.mm}`;
}

// 台北的今天 'YYYY-MM-DD'
function localToday(date = new Date()) {
  const p = parts(date);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// 台北本週一的 'YYYY-MM-DD'（週任務的期間代碼用）
function localWeekStart(date = new Date()) {
  const p = parts(date);
  const back = (p.dow + 6) % 7;                 // 週一為一週開始
  return localToday(new Date(date.getTime() - back * 86400000));
}

// 台北「今天 23:59:59」的 unix 毫秒
function endOfLocalDayMs(date = new Date()) {
  return new Date(localToday(date) + 'T23:59:59+08:00').getTime();
}

// 台北牆上時間字串（'YYYY-MM-DDTHH:MM'）轉 unix 秒。台灣固定 +08:00 無日光節約。
function toUnix(localStr) {
  if (!localStr) return 0;
  const s = localStr.length <= 16 ? localStr + ':00' : localStr;
  const t = new Date(s + '+08:00').getTime();
  return isNaN(t) ? 0 : Math.floor(t / 1000);
}

// 現在的 unix 秒
function nowUnix() { return Math.floor(Date.now() / 1000); }

module.exports = {
  parts, localNowMinute, localToday, localWeekStart, endOfLocalDayMs,
  toUnix, nowUnix, TZ
};
