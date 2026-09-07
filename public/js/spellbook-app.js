/* 咒語簿 App 前端（純 JS，沒有框架，跟後台同一個路數）。
   兩個畫面：資料夾列表 → 資料夾內容。點內容 = 複製，向右滑 = 置頂。 */
(function () {
  const S = window.SPELL || {};
  const api = (p) => `/spell/${S.token}/api${p}`;
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let view = { name: 'list', folder: null, entries: [], folders: [] };

  // ---- 小工具 ----
  function toast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  async function req(method, path, body) {
    const r = await fetch(api(path), {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin'
    });
    let data = {};
    try { data = await r.json(); } catch { data = {}; }
    if (!r.ok) {
      if (r.status === 401 && data.login) { location.href = data.login; return null; }
      throw new Error(data.error || '操作失敗，請稍後再試。');
    }
    return data;
  }
  const guard = (fn) => (...a) => fn(...a).catch(e => toast(e.message || '出了點問題'));

  // iOS Safari 對剪貼簿很挑：優先用 Clipboard API，失敗再退回 execCommand。
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* 往下退回舊招 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  // ---- 彈出面板 ----
  function sheet(html, bind) {
    close();
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `<div class="sheet">${html}</div>`;
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    document.body.appendChild(mask);
    if (bind) bind(mask.querySelector('.sheet'), close);
    return mask;
  }
  function close() { document.querySelectorAll('.mask').forEach(m => m.remove()); }
  function confirmSheet(msg, okText, onOk) {
    sheet(`<h3>${esc(msg)}</h3>
      <div class="btns"><button class="btn gray" data-no>取消</button>
      <button class="btn danger" data-yes>${esc(okText)}</button></div>`, (el) => {
      el.querySelector('[data-no]').onclick = close;
      el.querySelector('[data-yes]').onclick = () => { close(); onOk(); };
    });
  }

  // ---- 向右滑＝置頂（列表與內容共用）----
  function bindSwipe(row, onPin) {
    let x0 = 0, dx = 0, moved = false;
    row.addEventListener('touchstart', (e) => {
      x0 = e.touches[0].clientX; dx = 0; moved = false; row.classList.add('dragging');
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      dx = Math.max(0, Math.min(110, e.touches[0].clientX - x0));
      if (dx > 8) moved = true;
      row.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    row.addEventListener('touchend', () => {
      row.classList.remove('dragging');
      row.style.transform = '';
      if (dx > 62) { moved = true; onPin(); }
      setTimeout(() => { moved = false; }, 60);
    });
    row.dataset.swipe = '1';
    row._moved = () => moved;
  }
  const tapped = (row) => !(row._moved && row._moved());

  // ---- 畫面一：資料夾列表 ----
  const listHTML = (folders) => `
    <div class="top">
      <button id="menu" title="更多">☰</button>
      <h1>📖 咒語簿</h1>
      <button id="add">＋</button>
    </div>
    <div class="wrap">
      ${S.notice ? `<div class="notice">${esc(S.notice)}</div>` : ''}
      <div class="hintbar">點資料夾看內容　·　<b>向右滑</b>可以置頂　·　右上角 ＋ 新增資料夾</div>
      ${folders.length ? folders.map(f => `
        <div class="swipe"><div class="behind">📌 ${f.pinned ? '取消置頂' : '置頂'}</div>
          <div class="row" data-fid="${f.id}">
            <div class="ic">${esc(f.emoji || '📁')}</div>
            <div class="mid">
              <div class="t">${esc(f.name)}${f.pinned ? '<span class="pin">📌</span>' : ''}</div>
              <div class="s">${f.count} 則內容</div>
            </div>
            <button class="more" data-fmore="${f.id}">⋯</button>
          </div></div>`).join('')
        : `<div class="empty">還沒有資料夾。<br>按右上角的 ＋ 建一個吧（例如「開場白」「常用招呼」）。</div>`}
    </div>
    <button class="fab" id="fab">＋ 新增資料夾</button>`;

  const load = guard(async function load() {
    const d = await req('GET', '/state');
    if (!d) return;
    S.notice = d.notice; S.share = d.share; S.maxLen = d.max_len;
    view = { name: 'list', folders: d.folders };
    app.innerHTML = listHTML(d.folders);
    document.getElementById('add').onclick = folderForm;
    document.getElementById('fab').onclick = folderForm;
    document.getElementById('menu').onclick = mainMenu;
    app.querySelectorAll('.row[data-fid]').forEach(row => {
      const fid = Number(row.dataset.fid);
      const f = d.folders.find(x => x.id === fid);
      bindSwipe(row, guard(async () => {
        await req('POST', `/folders/${fid}/pin`, { on: !f.pinned });
        toast(f.pinned ? '已取消置頂' : '📌 已置頂');
        load();
      }));
      row.onclick = (e) => {
        if (e.target.closest('[data-fmore]')) return;
        if (tapped(row)) openFolder(fid);
      };
    });
    app.querySelectorAll('[data-fmore]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); folderMenu(d.folders.find(x => x.id === Number(b.dataset.fmore))); };
    });
  });

  // ---- 畫面二：資料夾內容 ----
  const openFolder = guard(async function openFolder(fid) {
    const d = await req('GET', `/folders/${fid}`);
    if (!d) return;
    view = { name: 'folder', folder: d.folder, entries: d.entries };
    app.innerHTML = `
      <div class="top">
        <button id="back">‹</button>
        <h1>${esc(d.folder.emoji || '📁')} ${esc(d.folder.name)}</h1>
        <button id="add">＋</button>
      </div>
      <div class="wrap">
        <div class="hintbar">左邊是標題、右邊是要貼的字　·　<b>點一下＝複製</b>，切回聊天室長按貼上　·　<b>向右滑</b>置頂</div>
        ${d.entries.length ? d.entries.map(e => `
          <div class="swipe"><div class="behind">📌 ${e.pinned ? '取消置頂' : '置頂'}</div>
            <div class="row entry" data-eid="${e.id}">
              <div class="ttl">${e.pinned ? '📌 ' : ''}${esc(e.title || '（無標題）')}</div>
              <div class="txt">${esc(e.content)}</div>
              <button class="more" data-emore="${e.id}">⋯</button>
            </div></div>`).join('')
          : `<div class="empty">這個資料夾還沒有內容。<br>按右上角的 ＋ 新增一則。</div>`}
      </div>
      <button class="fab" id="fab">＋ 新增內容</button>`;
    document.getElementById('back').onclick = load;
    document.getElementById('add').onclick = () => entryForm(fid);
    document.getElementById('fab').onclick = () => entryForm(fid);
    app.querySelectorAll('.row[data-eid]').forEach(row => {
      const eid = Number(row.dataset.eid);
      const e = d.entries.find(x => x.id === eid);
      bindSwipe(row, guard(async () => {
        await req('POST', `/entries/${eid}/pin`, { on: !e.pinned });
        toast(e.pinned ? '已取消置頂' : '📌 已置頂');
        openFolder(fid);
      }));
      row.onclick = async (ev) => {
        if (ev.target.closest('[data-emore]')) return;
        if (!tapped(row)) return;
        const ok = await copyText(e.content);
        if (ok) { toast('✅ 已複製，切回聊天室貼上'); req('POST', `/entries/${eid}/copied`).catch(() => {}); }
        else showText(e);
      };
    });
    app.querySelectorAll('[data-emore]').forEach(b => {
      b.onclick = (ev) => { ev.stopPropagation(); entryMenu(d.entries.find(x => x.id === Number(b.dataset.emore)), fid); };
    });
  });

  // 複製失敗（少數瀏覽器擋掉）時，至少讓使用者自己選取
  function showText(e) {
    sheet(`<h3>${esc(e.title || '內容')}</h3>
      <label>自動複製被瀏覽器擋住了，請長按下面的文字全選複製</label>
      <textarea readonly>${esc(e.content)}</textarea>
      <div class="btns"><button class="btn" data-ok>關閉</button></div>`, (el) => {
      el.querySelector('textarea').select();
      el.querySelector('[data-ok]').onclick = close;
    });
  }

  // ---- 資料夾：新增／編輯／選單 ----
  function folderForm(f) {
    const edit = f && f.id;
    sheet(`<h3>${edit ? '編輯資料夾' : '新增資料夾'}</h3>
      <label>圖示（一個 emoji）</label><input name="emoji" maxlength="4" value="${esc(edit ? f.emoji : '📁')}">
      <label>名稱</label><input name="name" maxlength="40" placeholder="例：開場白" value="${esc(edit ? f.name : '')}">
      <div class="btns"><button class="btn gray" data-no>取消</button><button class="btn" data-ok>儲存</button></div>`,
      (el) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-ok]').onclick = guard(async () => {
          const body = { name: el.querySelector('[name=name]').value, emoji: el.querySelector('[name=emoji]').value };
          if (!body.name.trim()) return toast('請填名稱');
          if (edit) await req('PUT', `/folders/${f.id}`, body);
          else await req('POST', '/folders', body);
          close(); toast(edit ? '已更新' : '資料夾建好了'); load();
        });
        el.querySelector('[name=name]').focus();
      });
  }

  function folderMenu(f) {
    if (!f) return;
    sheet(`<h3>${esc(f.emoji || '📁')} ${esc(f.name)}</h3>
      <button class="menu-item" data-pin>${f.pinned ? '取消置頂' : '📌 置頂這個資料夾'}</button>
      <button class="menu-item" data-edit>✏️ 重新命名／換圖示</button>
      ${S.share ? '<button class="menu-item" data-share>🔗 分享這個資料夾（產生分享碼）</button>' : ''}
      <button class="menu-item danger" data-del>🗑️ 刪除資料夾（連內容一起）</button>`, (el) => {
      el.querySelector('[data-pin]').onclick = guard(async () => {
        await req('POST', `/folders/${f.id}/pin`, { on: !f.pinned }); close(); load();
      });
      el.querySelector('[data-edit]').onclick = () => folderForm(f);
      const sh = el.querySelector('[data-share]');
      if (sh) sh.onclick = () => shareForm(f);
      el.querySelector('[data-del]').onclick = () => confirmSheet(`確定刪除「${f.name}」？裡面的內容會一起不見。`, '刪除',
        guard(async () => { await req('DELETE', `/folders/${f.id}`); toast('已刪除'); load(); }));
    });
  }

  // ---- 內容：新增／編輯／選單 ----
  function entryForm(fid, e) {
    const edit = e && e.id;
    sheet(`<h3>${edit ? '編輯內容' : '新增內容'}</h3>
      <label>標題（自己看的，方便找）</label>
      <input name="title" maxlength="60" placeholder="例：早安招呼" value="${esc(edit ? e.title : '')}">
      <label>內容（點一下就會複製這一段）</label>
      <textarea name="content" maxlength="${S.maxLen || 4000}" placeholder="貼上你常用的那段話">${esc(edit ? e.content : '')}</textarea>
      <div class="btns"><button class="btn gray" data-no>取消</button><button class="btn" data-ok>儲存</button></div>`,
      (el) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-ok]').onclick = guard(async () => {
          const body = {
            folder_id: fid,
            title: el.querySelector('[name=title]').value,
            content: el.querySelector('[name=content]').value
          };
          if (!body.content.trim()) return toast('內容不能空白');
          if (edit) await req('PUT', `/entries/${e.id}`, body);
          else await req('POST', '/entries', body);
          close(); toast(edit ? '已更新' : '已新增'); openFolder(fid);
        });
        el.querySelector(edit ? '[name=content]' : '[name=title]').focus();
      });
  }

  function entryMenu(e, fid) {
    if (!e) return;
    sheet(`<h3>${esc(e.title || '（無標題）')}</h3>
      <button class="menu-item" data-copy>📋 複製</button>
      <button class="menu-item" data-pin>${e.pinned ? '取消置頂' : '📌 置頂'}</button>
      <button class="menu-item" data-edit>✏️ 編輯</button>
      <button class="menu-item danger" data-del>🗑️ 刪除</button>`, (el) => {
      el.querySelector('[data-copy]').onclick = async () => {
        close();
        const ok = await copyText(e.content);
        if (ok) { toast('✅ 已複製'); req('POST', `/entries/${e.id}/copied`).catch(() => {}); } else showText(e);
      };
      el.querySelector('[data-pin]').onclick = guard(async () => {
        await req('POST', `/entries/${e.id}/pin`, { on: !e.pinned }); close(); openFolder(fid);
      });
      el.querySelector('[data-edit]').onclick = () => entryForm(fid, e);
      el.querySelector('[data-del]').onclick = () => confirmSheet('確定刪除這一則？', '刪除',
        guard(async () => { await req('DELETE', `/entries/${e.id}`); toast('已刪除'); openFolder(fid); }));
    });
  }

  // ---- 主選單：分享匯入／備份／安裝說明／登出 ----
  function mainMenu() {
    sheet(`<h3>更多</h3>
      ${S.share ? '<button class="menu-item" data-imp>📥 用分享碼匯入資料夾</button>' : ''}
      <button class="menu-item" data-exp>💾 匯出備份（JSON 檔）</button>
      <button class="menu-item" data-impjson>📂 匯入備份檔</button>
      <button class="menu-item" data-how>📱 怎麼加到主畫面</button>
      <button class="menu-item danger" data-out>登出</button>`, (el) => {
      const imp = el.querySelector('[data-imp]');
      if (imp) imp.onclick = importForm;
      el.querySelector('[data-exp]').onclick = guard(async () => {
        const d = await req('GET', '/export');
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `咒語簿備份-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        close(); toast('已匯出備份檔');
      });
      el.querySelector('[data-impjson]').onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'application/json,.json';
        inp.onchange = guard(async () => {
          const file = inp.files && inp.files[0];
          if (!file) return;
          let data;
          try { data = JSON.parse(await file.text()); } catch { return toast('這個檔案讀不出來'); }
          const r = await req('POST', '/import-json', { data });
          close(); toast(`匯入完成：${r.folders} 個資料夾、${r.entries} 則`); load();
        });
        inp.click();
      };
      el.querySelector('[data-how]').onclick = () => sheet(`<h3>📱 加到主畫面</h3>
        <p style="font-size:14px;line-height:1.9;color:#8b85a3;margin:0 0 14px">
        <b>iPhone</b>：用 Safari 開這一頁 → 底下「分享」鍵 → 選「加入主畫面」。<br>
        <b>Android</b>：Chrome 右上角 ⋮ → 「安裝應用程式／加到主畫面」。<br><br>
        之後桌面上就有一顆咒語簿圖示，開起來跟 App 一樣（沒有網址列）。<br>
        用法：<b>開咒語簿 → 點內容複製 → 切回 Discord 貼上</b>。</p>
        <div class="btns"><button class="btn" data-ok>知道了</button></div>`,
        (e2) => { e2.querySelector('[data-ok]').onclick = close; });
      el.querySelector('[data-out]').onclick = () => { location.href = `/spell/${S.token}/logout`; };
    });
  }

  // ---- 分享：產生分享碼（可設密碼）----
  function shareForm(f) {
    sheet(`<h3>🔗 分享「${esc(f.name)}」</h3>
      <label>密碼（可空白＝任何人有碼就能匯入）</label>
      <input name="pw" type="text" autocomplete="off" placeholder="設一組密碼，只告訴要給的人">
      <label>有效天數</label>
      <select name="days"><option value="7">7 天</option><option value="30" selected>30 天</option>
        <option value="90">90 天</option><option value="365">365 天</option></select>
      <div class="btns"><button class="btn gray" data-no>取消</button><button class="btn" data-ok>產生分享碼</button></div>`,
      (el) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-ok]').onclick = guard(async () => {
          const pw = el.querySelector('[name=pw]').value;
          const r = await req('POST', '/share', { folder_id: f.id, password: pw, days: Number(el.querySelector('[name=days]').value) });
          sheet(`<h3>分享碼產生好了</h3>
            <div class="code">${esc(r.code)}</div>
            <p style="font-size:13.5px;line-height:1.8;color:#8b85a3;margin:0 0 14px">
              把這組分享碼${r.encrypted ? '和密碼' : ''}給對方，他在咒語簿的「☰ → 用分享碼匯入資料夾」輸入就會拿到這 ${r.count} 則內容。
              ${r.encrypted ? '<br>內容已用密碼加密（AES-GCM），沒有密碼誰都解不開。' : '<br>這份沒設密碼，拿到碼的人就能匯入。'}
            </p>
            <div class="btns"><button class="btn gray" data-ok>關閉</button><button class="btn" data-copy>複製分享碼</button></div>`,
            (e2) => {
              e2.querySelector('[data-ok]').onclick = close;
              e2.querySelector('[data-copy]').onclick = async () => {
                await copyText(r.code); toast('已複製分享碼');
              };
            });
        });
      });
  }

  function importForm() {
    sheet(`<h3>📥 用分享碼匯入</h3>
      <label>分享碼</label><input name="code" autocomplete="off" placeholder="對方給你的那一串" style="text-transform:uppercase">
      <label>密碼（對方有設才要填）</label><input name="pw" type="text" autocomplete="off">
      <div class="btns"><button class="btn gray" data-no>取消</button><button class="btn" data-ok>匯入</button></div>`,
      (el) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-ok]').onclick = guard(async () => {
          const r = await req('POST', '/import', {
            code: el.querySelector('[name=code]').value, password: el.querySelector('[name=pw]').value
          });
          close(); toast(`匯入完成，收到 ${r.count} 則內容`); load();
        });
        el.querySelector('[name=code]').focus();
      });
  }

  // ---- 啟動 ----
  load();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/spell/sw.js').catch(() => {}));
  }
})();
