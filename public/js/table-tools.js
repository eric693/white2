// ===== 表格工具列：搜尋 / 欄位篩選 / 排序 / 分頁 =====
//
// 後台有 80 幾張清單表格，每一張都手寫一套搜尋篩選不切實際，
// 所以做成「掛上去就有」的通用層：只要頁面上出現 <table class="list">，
// 這裡就會自動在它上面補一條工具列，並讓表頭可以點擊排序。
//
// 設計原則：
//  * 純前端、只動 DOM，不碰任何頁面既有的邏輯與 API，所以不會影響原本的編輯/刪除按鈕。
//  * 資料換掉（重新 render）時會重新掛一次，靠 MutationObserver 偵測，頁面不用改。
//  * 不想要工具列的表格，在 <table> 上加 data-no-tools 就會跳過。
const Tbl = {
  MIN_ROWS: 6,          // 少於這個列數就不加工具列（例如只有 3 筆的設定表，加了反而礙眼）
  MIN_ROWS_PAGE: 40,    // 超過這個列數才出現「每頁筆數」選單（預設仍是全部顯示）
  AUTO_PAGE: 200,       // 只有超過這個列數才自動分頁（稱號 59、食譜 36 這種要一眼看完）
  FILTER_MAX: 12,       // 一欄的相異值少於這個數字才適合做成下拉篩選

  // 取一格的比較用文字（去掉多餘空白）
  cellText(td) { return (td.textContent || '').replace(/\s+/g, ' ').trim(); },

  // 數字排序：抓得到純數字（含千分位、%、+/-、單位後綴）就用數字比，否則用文字比
  num(s) {
    const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m && /^[^A-Za-z一-鿿]*-?[\d.,]+/.test(String(s).trim()) ? parseFloat(m[0]) : null;
  },

  // 日期排序：YYYY-MM-DD HH:MM 這種格式直接用字串比就是正確順序，不用特別處理
  enhance(table) {
    if (!table || table.dataset.tblReady === '1' || table.hasAttribute('data-no-tools')) return;
    const tbody = table.tBodies[0];
    const thead = table.tHead;
    if (!tbody || !thead || !thead.rows.length) return;

    // 只有一列而且是「尚無資料」那種佔位列 → 不處理
    // 可編輯的表格（格子裡直接放 input／select，例如稅率級距）不掛工具列：
    // 那種表格的列是表單的一部分，會被新增/刪除，排序與分頁只會幫倒忙。
    if (tbody.querySelector('input, select, textarea')) return;

    const rows = Array.from(tbody.rows).filter(r => !r.querySelector('td.empty') && r.cells.length > 1);
    if (rows.length < Tbl.MIN_ROWS) return;
    table.dataset.tblReady = '1';

    const headRow = thead.rows[thead.rows.length - 1];
    const cols = Array.from(headRow.cells);
    // 最後一欄若是操作欄（沒有標題文字，或裡面全是按鈕）→ 不排序、不篩選
    const isActionCol = (idx) =>
      !Tbl.cellText(cols[idx]) || rows.every(r => r.cells[idx] && r.cells[idx].querySelector('button, a.btn'));

    // ---- 工具列 ----
    const bar = document.createElement('div');
    bar.className = 'tbl-bar';
    const wrap = table.closest('.table-wrap') || table;

    // 可做成下拉篩選的欄位：相異值不多、不是操作欄、每格都有純文字
    const filterCols = [];
    cols.forEach((th, idx) => {
      if (isActionCol(idx)) return;
      const vals = new Set();
      let ok = true;
      for (const r of rows) {
        const td = r.cells[idx];
        if (!td) { ok = false; break; }
        const t = Tbl.cellText(td);
        if (t.length > 20) { ok = false; break; }   // 長文字欄位不適合做下拉
        vals.add(t);
        if (vals.size > Tbl.FILTER_MAX) { ok = false; break; }
      }
      if (ok && vals.size > 1) filterCols.push({ idx, name: Tbl.cellText(th), vals: [...vals].sort() });
    });

    bar.innerHTML = `
      <input class="tbl-q" type="search" placeholder="🔍 搜尋這張表…" aria-label="搜尋表格">
      ${filterCols.map(f => `
        <select class="tbl-f" data-col="${f.idx}" aria-label="依${UI.esc(f.name)}篩選">
          <option value="">${UI.esc(f.name)}：全部</option>
          ${f.vals.map(v => `<option value="${UI.esc(v)}">${UI.esc(v || '（空白）')}</option>`).join('')}
        </select>`).join('')}
      <span class="tbl-count"></span>
      <span class="tbl-spacer"></span>
      <button type="button" class="btn tiny secondary tbl-reset" hidden>清除條件</button>
      ${rows.length >= Tbl.MIN_ROWS_PAGE ? `
        <select class="tbl-size" aria-label="每頁筆數">
          <option value="0"${rows.length >= Tbl.AUTO_PAGE ? '' : ' selected'}>全部顯示</option>
          <option value="25">每頁 25 筆</option>
          <option value="50">每頁 50 筆</option>
          <option value="100"${rows.length >= Tbl.AUTO_PAGE ? ' selected' : ''}>每頁 100 筆</option>
        </select>
        <span class="tbl-pager">
          <button type="button" class="btn tiny secondary tbl-prev">‹</button>
          <span class="tbl-page"></span>
          <button type="button" class="btn tiny secondary tbl-next">›</button>
        </span>` : ''}`;
    if (!wrap.parentNode) return;
    wrap.parentNode.insertBefore(bar, wrap);

    // ---- 狀態 ----
    const st = { q: '', filters: {}, sort: -1, dir: 1, page: 1, size: rows.length >= Tbl.AUTO_PAGE ? 100 : 0 };
    // 原始順序：排序後要能還原
    rows.forEach((r, n) => { r.dataset.tblIdx = n; });
    // 每列的搜尋字串先算好，打字時就不用每次重掃 DOM
    const hay = rows.map(r => Array.from(r.cells).map(c => Tbl.cellText(c)).join(' ').toLowerCase());

    const els = {
      q: bar.querySelector('.tbl-q'),
      count: bar.querySelector('.tbl-count'),
      reset: bar.querySelector('.tbl-reset'),
      size: bar.querySelector('.tbl-size'),
      page: bar.querySelector('.tbl-page'),
      prev: bar.querySelector('.tbl-prev'),
      next: bar.querySelector('.tbl-next'),
      pager: bar.querySelector('.tbl-pager')
    };

    const apply = () => {
      // 1) 篩選
      const q = st.q.toLowerCase();
      const hit = new Set();
      rows.forEach((r, n) => {
        if (st.extra && !st.extra(r)) return;
        if (q && !hay[n].includes(q)) return;
        for (const [idx, v] of Object.entries(st.filters)) {
          if (v === '') continue;
          if (Tbl.cellText(r.cells[idx]) !== v) return;
        }
        hit.add(r);
      });

      // 2) 排序（重新排整個 tbody，未命中的列排在後面反正會被隱藏）
      const ordered = rows.slice().sort((a, b) => {
        if (st.sort < 0) return a.dataset.tblIdx - b.dataset.tblIdx;
        const ta = Tbl.cellText(a.cells[st.sort]), tb = Tbl.cellText(b.cells[st.sort]);
        const na = Tbl.num(ta), nb = Tbl.num(tb);
        if (na !== null && nb !== null && na !== nb) return (na - nb) * st.dir;
        return ta.localeCompare(tb, 'zh-Hant') * st.dir;
      });
      const frag = document.createDocumentFragment();
      ordered.forEach(r => frag.appendChild(r));
      tbody.appendChild(frag);

      // 3) 分頁
      const visible = ordered.filter(r => hit.has(r));
      const size = st.size || visible.length || 1;
      const pages = Math.max(1, Math.ceil(visible.length / size));
      if (st.page > pages) st.page = pages;
      const from = (st.page - 1) * size, to = from + size;

      rows.forEach(r => { r.style.display = 'none'; });
      visible.slice(from, to).forEach(r => { r.style.display = ''; });

      // 4) 空結果提示
      let none = tbody.querySelector('tr.tbl-none');
      if (!visible.length) {
        if (!none) {
          none = document.createElement('tr');
          none.className = 'tbl-none';
          none.innerHTML = `<td class="empty" colspan="${cols.length}">找不到符合條件的資料</td>`;
          tbody.appendChild(none);
        }
        none.style.display = '';
      } else if (none) none.style.display = 'none';

      // 5) 狀態文字
      const filtered = visible.length !== rows.length;
      els.count.textContent = filtered ? `顯示 ${visible.length} / ${rows.length} 筆` : `共 ${rows.length} 筆`;
      els.count.classList.toggle('on', filtered);
      els.reset.hidden = !filtered && st.sort < 0;
      if (els.pager) {
        els.pager.style.display = pages > 1 ? '' : 'none';
        els.page.textContent = `${st.page} / ${pages}`;
        els.prev.disabled = st.page <= 1;
        els.next.disabled = st.page >= pages;
      }
    };

    // ---- 事件 ----
    let timer;
    els.q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { st.q = els.q.value.trim(); st.page = 1; apply(); }, 150);
    });
    bar.querySelectorAll('.tbl-f').forEach(sel => sel.addEventListener('change', () => {
      st.filters[sel.dataset.col] = sel.value; st.page = 1; apply();
    }));
    els.reset.addEventListener('click', () => {
      els.q.value = ''; st.q = ''; st.filters = {}; st.sort = -1; st.dir = 1; st.page = 1;
      bar.querySelectorAll('.tbl-f').forEach(s => { s.value = ''; });
      cols.forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
      apply();
    });
    if (els.size) els.size.addEventListener('change', () => { st.size = parseInt(els.size.value, 10); st.page = 1; apply(); });
    if (els.prev) els.prev.addEventListener('click', () => { if (st.page > 1) { st.page--; apply(); } });
    if (els.next) els.next.addEventListener('click', () => { st.page++; apply(); });

    // ---- 表頭排序 ----
    cols.forEach((th, idx) => {
      if (isActionCol(idx)) return;
      th.classList.add('sortable');
      th.title = '點一下排序';
      th.addEventListener('click', () => {
        if (st.sort === idx) st.dir = -st.dir; else { st.sort = idx; st.dir = 1; }
        cols.forEach(c => c.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(st.dir === 1 ? 'sort-asc' : 'sort-desc');
        st.page = 1;
        apply();
      });
    });

    // 讓頁面可以再加一層自己的條件（例如公告頁的「依備註篩選」按鈕）
    table._tbl = { st, apply };

    apply();
  },

  /** 頁面專用的額外篩選：fn(tr) 回傳 true 才顯示；傳 null 取消。 */
  rowFilter(table, fn) {
    if (!table) return;
    if (!table._tbl) {            // 資料太少沒掛工具列時，退回最單純的顯示/隱藏
      Array.from(table.tBodies[0] ? table.tBodies[0].rows : []).forEach(tr => {
        tr.style.display = (!fn || fn(tr)) ? '' : 'none';
      });
      return;
    }
    table._tbl.st.extra = fn || null;
    table._tbl.st.page = 1;
    table._tbl.apply();
  },

  enhanceAll(root) {
    (root || document).querySelectorAll('table.list').forEach(t => {
      try { Tbl.enhance(t); } catch (e) { /* 單一表格出錯不影響整頁 */ }
    });
  },

  // 頁面內容是各頁自己非同步塞進來的（有的還會二次載入），
  // 與其要求每一頁去呼叫，不如直接盯著 DOM：有新表格出現就掛上去。
  observe() {
    let pending;
    const run = () => {
      pending = null;
      Tbl.enhanceAll(document);
      // 順手把畫面上的 Discord ID 補上伺服器暱稱（表格、彈窗都吃得到）
      try { H.paintNicks(document); } catch (e) {}
    };
    new MutationObserver(() => { if (!pending) pending = setTimeout(run, 60); })
      .observe(document.body, { childList: true, subtree: true });
    run();
  }
};

document.addEventListener('DOMContentLoaded', () => Tbl.observe());
