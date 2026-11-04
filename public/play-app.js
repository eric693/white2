// 璃白冒險（/play）玩家 App 前端：分頁、送出鎖定、PWA 安裝、離線提示、推播
(function () {
  var TABS = ['home', 'play', 'farm', 'market', 'me'];
  var KEY = 'play-ui:' + location.pathname;
  var store = {
    get: function () { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set: function (v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} },
    clear: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  };

  // ---- 分頁 ----
  function show(tab, keepScroll) {
    if (TABS.indexOf(tab) < 0) tab = 'home';
    TABS.forEach(function (t) {
      var el = document.getElementById('tab-' + t);
      if (el) el.classList.toggle('on', t === tab);
    });
    [].forEach.call(document.querySelectorAll('.tabbar a'), function (a) {
      var on = a.getAttribute('data-go') === tab;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!keepScroll) window.scrollTo(0, 0);
    return tab;
  }
  var current;
  var saved = store.get();
  var fromHash = location.hash.slice(1);
  // 表單送出後會被重導回來、hash 會消失 → 用送出前記下的分頁與捲動位置還原
  if (!fromHash && saved && saved.tab) {
    current = show(saved.tab, true);
    window.scrollTo(0, saved.y || 0);
  } else {
    current = show(fromHash || 'home');
  }
  store.clear();
  // 把 ?msg= 從網址拿掉（重新整理才不會一直跳同一則提示），並補上目前分頁
  history.replaceState(null, '', location.pathname + '#' + current);

  window.addEventListener('hashchange', function () { current = show(location.hash.slice(1)); });
  document.querySelector('.tabbar').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-go]');
    if (!a) return;
    e.preventDefault();
    var tab = a.getAttribute('data-go');
    if (tab === current) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    history.replaceState(null, '', '#' + tab);
    current = show(tab);
  });

  // ---- 表單送出：鎖按鈕防連點、記住分頁 ----
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.dataset.sent) { e.preventDefault(); return; }
    if (!navigator.onLine) { e.preventDefault(); toast('目前離線，連上網路後再試一次。', false); return; }
    f.dataset.sent = '1';
    var b = f.querySelector('button');
    if (b) b.classList.add('busy');
    store.set({ tab: current, y: window.scrollY });
  });
  // 從上一頁快取（bfcache）回來時解除鎖定
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    [].forEach.call(document.querySelectorAll('form[data-sent]'), function (f) {
      delete f.dataset.sent;
      var b = f.querySelector('button'); if (b) b.classList.remove('busy');
    });
  });

  // ---- 提示 ----
  function hideLater(el) {
    setTimeout(function () { el.classList.add('hide'); setTimeout(function () { el.remove(); }, 400); }, 4500);
  }
  function toast(text, ok) {
    var old = document.querySelector('.toast'); if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast ' + (ok ? 'ok' : 'err'); el.setAttribute('role', 'status'); el.textContent = text;
    document.body.appendChild(el); hideLater(el);
  }
  var t0 = document.querySelector('.toast');
  if (t0) { hideLater(t0); t0.addEventListener('click', function () { t0.remove(); }); }

  // ---- 作物倒數 ----
  function fmtLeft(ms) {
    var m = Math.ceil(ms / 60000);
    if (m < 60) return m + ' 分鐘';
    var h = Math.floor(m / 60); m = m % 60;
    if (h < 24) return h + ' 小時' + (m ? ' ' + m + ' 分' : '');
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小時';
  }
  function tick() {
    [].forEach.call(document.querySelectorAll('[data-ready]'), function (el) {
      var at = Number(el.getAttribute('data-ready'));
      if (!at) return;
      var left = at - Date.now();
      el.textContent = left > 0 ? '還要 ' + fmtLeft(left) : '已成熟，重新整理';
    });
  }
  tick(); setInterval(tick, 30000);

  // ---- 切回 App 時自動更新（離開超過 1 分鐘）----
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 60000 && navigator.onLine) {
      store.set({ tab: current, y: window.scrollY });
      location.replace(location.pathname);
    }
  });

  // ---- 離線提示 ----
  var off = document.getElementById('offline');
  function net() { if (off) off.hidden = navigator.onLine; }
  window.addEventListener('online', net); window.addEventListener('offline', net); net();

  // ---- PWA：Service Worker、安裝 ----
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var installBtn = document.getElementById('installBtn');
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) installBtn.addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; installBtn.hidden = true; });
  });
  window.addEventListener('appinstalled', function () { if (installBtn) installBtn.hidden = true; toast('已安裝到主畫面 🎉', true); });
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var tip = document.getElementById('iosTip');
  if (tip && ios && !standalone) tip.hidden = false;

  // ---- 推播 ----
  var pushBtn = document.getElementById('pushbtn');
  var pushMsg = document.getElementById('pushmsg');
  if (pushBtn) {
    var VAPID = pushBtn.getAttribute('data-vapid');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushBtn.disabled = true;
      pushMsg.textContent = ios && !standalone
        ? 'iPhone 需要 iOS 16.4 以上，並先「加入主畫面」從主畫面開啟，才能開啟推播。'
        : '這個裝置或瀏覽器不支援推播。';
    } else {
      var b64 = function (s) {
        var p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
        var a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a;
      };
      pushBtn.addEventListener('click', function () {
        pushBtn.classList.add('busy'); pushMsg.textContent = '處理中…';
        var reg;
        navigator.serviceWorker.register('/sw.js').then(function (r) { reg = r; return navigator.serviceWorker.ready; })
          .then(function () { return Notification.requestPermission(); })
          .then(function (perm) {
            if (perm !== 'granted') throw new Error('你沒有允許通知');
            return reg.pushManager.getSubscription().then(function (sub) {
              return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID) });
            });
          })
          .then(function (sub) {
            return fetch(location.pathname.replace(/\/$/, '') + '/push-subscribe', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub)
            });
          })
          .then(function (res) {
            if (!res.ok) throw new Error('伺服器沒有收下訂閱');
            pushBtn.textContent = '🔔 推播已開啟'; pushMsg.textContent = '✅ 已開啟推播！重新整理就能看到測試按鈕。';
          })
          .catch(function (e) { pushMsg.textContent = '開啟失敗：' + ((e && e.message) || e); })
          .then(function () { pushBtn.classList.remove('busy'); });
      });
    }
  }
})();

// ---- 外觀主題：節日／季節配色、自訂背景圖、飄落動畫（設定只存在這台裝置）----
(function () {
  var root = document.documentElement;
  var SKEY = 'play-skin', BGKEY = 'play-bg';
  var DECO = {
    christmas: ['❄', '❅', '❆', '✦'], halloween: ['🎃', '🦇', '🍬', '👻'], newyear: ['🧧', '✨', '🏮', '🎆'],
    sakura: ['🌸', '🌸', '💮', '🩷'], osmanthus: ['✿', '❀', '🍂', '✿']
  };
  function load() { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } }
  function persist(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); return true; } catch (e) { return false; } }
  function resolve(k) {
    if (k && k !== 'auto') return k;
    var d = new Date(), m = d.getMonth() + 1, n = d.getDate();
    if ((m === 10 && n >= 15) || (m === 11 && n === 1)) return 'halloween';
    if (m === 12 && n <= 26) return 'christmas';
    if (m === 1 || (m === 2 && n <= 15)) return 'newyear';
    return 'default';
  }
  var s = load();
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function decorate() {
    var old = document.querySelector('.deco'); if (old) old.remove();
    var set = DECO[root.getAttribute('data-skin')];
    if (!set || s.deco === false || reduced) return;
    var box = document.createElement('div'); box.className = 'deco'; box.setAttribute('aria-hidden', 'true');
    var count = window.innerWidth < 600 ? 14 : 22;
    for (var i = 0; i < count; i++) {
      var el = document.createElement('i');
      el.textContent = set[i % set.length];
      el.style.left = (Math.random() * 100) + 'vw';
      el.style.fontSize = (12 + Math.random() * 14) + 'px';
      el.style.animationDuration = (9 + Math.random() * 10) + 's';
      el.style.animationDelay = (-Math.random() * 18) + 's';
      el.style.setProperty('--drift', (Math.random() * 120 - 60) + 'px');
      el.style.setProperty('--spin', (Math.random() * 540 - 270) + 'deg');
      box.appendChild(el);
    }
    document.body.appendChild(box);
  }
  function applySkin() { root.setAttribute('data-skin', resolve(s.skin)); decorate(); }
  function applyBg() {
    var bg = null; try { bg = localStorage.getItem(BGKEY); } catch (e) {}
    var thumb = document.getElementById('bgThumb'), clear = document.getElementById('bgClear'), dimRow = document.getElementById('dimRow');
    if (bg) { root.setAttribute('data-hasbg', ''); root.style.setProperty('--bgimg', 'url(' + bg + ')'); }
    else { root.removeAttribute('data-hasbg'); root.style.removeProperty('--bgimg'); }
    root.style.setProperty('--dim', ((s.dim == null ? 35 : s.dim) / 100));
    if (thumb) { thumb.style.backgroundImage = bg ? 'url(' + bg + ')' : ''; thumb.classList.toggle('set', !!bg); }
    if (clear) clear.hidden = !bg;
    if (dimRow) dimRow.hidden = !bg;
  }
  applySkin();

  // 主題選擇
  var current = s.skin || 'auto';
  [].forEach.call(document.querySelectorAll('input[name="skin"]'), function (r) {
    r.checked = r.value === current;
    r.addEventListener('change', function () { s.skin = r.value; persist(s); applySkin(); });
  });
  var deco = document.getElementById('decoOn');
  if (deco) { deco.checked = s.deco !== false; deco.addEventListener('change', function () { s.deco = deco.checked; persist(s); decorate(); }); }
  var dim = document.getElementById('bgDim'), dimOut = document.getElementById('bgDimOut');
  if (dim) {
    var showDim = function () { dimOut.textContent = (100 - dim.value) + '%'; };
    dim.value = s.dim == null ? 35 : s.dim; showDim();
    dim.addEventListener('input', function () { s.dim = +dim.value; root.style.setProperty('--dim', dim.value / 100); showDim(); });
    dim.addEventListener('change', function () { persist(s); });
  }
  applyBg();

  // 自訂背景圖：在手機上先縮成長邊 1600px 的 JPEG，再存進這台裝置
  var file = document.getElementById('bgFile');
  if (file) file.addEventListener('change', function () {
    var f = file.files && file.files[0]; file.value = '';
    if (!f || !/^image\//.test(f.type)) return;
    var url = URL.createObjectURL(f), img = new Image();
    img.onload = function () {
      var max = 1600, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      var data = c.toDataURL('image/jpeg', 0.82);
      // 太大存不進去時再壓一次
      try { localStorage.setItem(BGKEY, data); }
      catch (e) {
        try { localStorage.setItem(BGKEY, c.toDataURL('image/jpeg', 0.6)); }
        catch (e2) { alert('圖片太大，這台裝置存不下，請換一張小一點的圖。'); return; }
      }
      applyBg();
    };
    img.onerror = function () { URL.revokeObjectURL(url); alert('讀不到這張圖片，請換一張試試。'); };
    img.src = url;
  });
  var clearBtn = document.getElementById('bgClear');
  if (clearBtn) clearBtn.addEventListener('click', function () { try { localStorage.removeItem(BGKEY); } catch (e) {} applyBg(); });
})();
