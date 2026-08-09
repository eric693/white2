// ===== 論壇整理 =====
App.page('forum', {
  title: '論壇整理', sub: '同步論壇貼文、發布自動更新目錄、後台查詢', module: 'forum',
  async render(el) {
    await H.loadMeta();
    const [c, forums] = await Promise.all([GET('/forum-config'), GET('/forum-channels').catch(() => [])]);

    el.innerHTML = `
      <div class="card" style="max-width:700px" id="wrap">
        <h3>整理設定</h3>
        ${forums.length ? '' : '<div class="field"><div class="hint">這個伺服器目前沒有論壇頻道。建立論壇頻道後回來重新整理即可。</div></div>'}
        <div class="field"><label>要整理的論壇（不勾＝全部論壇）</label>
          ${multiBox('forum_ids', forums, c.forum_ids, f => '' + f.name)}</div>
        <div class="field"><label>目錄標題</label><input name="title" value="${UI.esc(c.title)}"></div>
        <div class="form-row">
          <div class="field"><label>呈現方式</label>
            <select name="group_by">
              <option value="author" ${c.group_by === 'author' ? 'selected' : ''}>依玩家彙總（玩家名稱＋留言數）</option>
              <option value="tag" ${c.group_by === 'tag' ? 'selected' : ''}>依標籤分區</option>
              <option value="none" ${c.group_by === 'none' ? 'selected' : ''}>全部貼文列表</option>
            </select></div>
          <div class="field"><label>排序</label>
            <select name="sort_by">
              <option value="messages" ${c.sort_by === 'messages' ? 'selected' : ''}>留言數多的在前</option>
              <option value="recent" ${c.sort_by === 'recent' ? 'selected' : ''}>最近活動</option>
              <option value="created" ${c.sort_by === 'created' ? 'selected' : ''}>最新發文</option>
            </select></div>
          <div class="field"><label>每頁筆數</label><input name="per_page" type="number" min="5" max="30" value="${c.per_page}"></div>
        </div>
        <div class="field">${H.toggle('show_archived', c.show_archived, '包含已封存的貼文')}</div>
        <div class="field">${H.toggle('auto_update', c.auto_update, '有新貼文或新留言時自動更新目錄（每 2 分鐘檢查）')}</div>
        <button class="btn" id="save">儲存設定</button>
        <button class="btn secondary" id="sync">立即同步貼文</button>
        <div class="hint">上次同步：${UI.esc(c.synced_at || '尚未同步')}</div>
      </div>

      <div class="card" style="max-width:700px">
        <h3>目錄訊息</h3>
        <div class="field"><div class="hint">全伺服器只保留一則目錄，重新發布會自動刪除舊的。玩家可用按鈕翻頁或手動重新整理。</div></div>
        <div class="field"><label>目錄發布頻道</label>${H.chanSelect('index_channel', c.index_channel)}</div>
        <button class="btn" id="post">發布 / 重新發布目錄</button>
        ${c.index_message ? `<div class="hint">目前目錄：${H.chanName(c.index_channel)}</div>` : ''}
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">依玩家彙總</h3><div class="spacer"></div>
          <button class="btn small secondary" id="exportA">匯出 CSV</button></div>
        <div id="authors"></div>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">全部貼文</h3><div class="spacer"></div>
          <input id="q" placeholder="搜尋標題／玩家／標籤" style="max-width:220px">
          <select id="sort" style="max-width:150px">
            <option value="messages">留言數</option><option value="recent">最近活動</option>
            <option value="created">發文時間</option><option value="title">標題</option>
          </select>
          <button class="btn small secondary" id="exportP">匯出 CSV</button></div>
        <div id="posts"></div>
      </div>`;

    const wrap = el.querySelector('#wrap');

    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const b = H.collect(wrap);
        b.forum_ids = multiVal(wrap, 'forum_ids');
        await PUT('/forum-config', b); UI.ok('已儲存'); App.go('forum');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    el.querySelector('#sync').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = '同步中…';
      try {
        const r = await POST('/forum-sync');
        UI.ok(r.forums ? `已同步 ${r.forums} 個論壇、${r.posts} 篇貼文` : '沒有找到論壇頻道');
        App.go('forum');
      } catch (err) { UI.err(err.message); }
      finally { e.target.disabled = false; e.target.textContent = '立即同步貼文'; }
    };

    el.querySelector('#post').onclick = async (e) => {
      const ch = el.querySelector('[name="index_channel"]').value;
      if (!ch) return UI.err('請選擇目錄頻道');
      e.target.disabled = true;
      try { await POST('/forum-index', { channel_id: ch }); UI.ok('目錄已發布'); App.go('forum'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    // 依玩家彙總
    let authorRows = [];
    const loadAuthors = async () => {
      authorRows = await GET('/forum-authors');
      el.querySelector('#authors').innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>#</th><th>玩家名稱</th><th>Discord ID</th><th>留言數</th><th>發文篇數</th><th>最後活動</th></tr></thead>
        <tbody>${authorRows.length ? authorRows.map((a, n) => `
          <tr><td>${n + 1}</td><td><strong>${UI.esc(a.author_name || '未知玩家')}</strong></td>
            <td><code>${a.author_id}</code></td><td>${a.messages}</td><td>${a.posts}</td>
            <td>${UI.esc(a.last_active || '—')}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">尚無資料，請先按「立即同步貼文」</td></tr>'}
        </tbody></table></div>`;
    };

    // 貼文列表
    let postRows = [];
    const loadPosts = async () => {
      const q = el.querySelector('#q').value.trim();
      const sort = el.querySelector('#sort').value;
      postRows = await GET(`/forum-posts?sort=${sort}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      el.querySelector('#posts').innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>標題</th><th>玩家</th><th>論壇</th><th>標籤</th><th>留言數</th><th>最後活動</th><th></th></tr></thead>
        <tbody>${postRows.length ? postRows.map(p => `
          <tr><td class="wrap"><strong>${UI.esc(p.title)}</strong>${p.archived ? ' <span class="tag">已封存</span>' : ''}${p.pinned ? ' ' : ''}</td>
            <td class="wrap">${UI.esc(p.author_name || '—')}</td>
            <td>${UI.esc(p.forum_name)}</td>
            <td class="wrap">${UI.esc((p.tags || '').split(',').filter(Boolean).join('、') || '—')}</td>
            <td>${p.message_count}</td><td>${UI.esc(p.last_active || '—')}</td>
            <td><a class="btn tiny secondary" href="${UI.esc(p.url)}" target="_blank">開啟</a></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty">尚無資料</td></tr>'}
        </tbody></table></div>`;
    };

    const csvDownload = (name, header, rows) => {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const body = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
      const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      URL.revokeObjectURL(a.href);
    };

    el.querySelector('#exportA').onclick = () => csvDownload('論壇玩家彙總.csv',
      ['玩家名稱', 'Discord ID', '留言數', '發文篇數', '最後活動'],
      authorRows.map(a => [a.author_name, a.author_id, a.messages, a.posts, a.last_active]));
    el.querySelector('#exportP').onclick = () => csvDownload('論壇貼文.csv',
      ['標題', '玩家', '論壇', '標籤', '留言數', '發文時間', '最後活動', '連結'],
      postRows.map(p => [p.title, p.author_name, p.forum_name, p.tags, p.message_count, p.created_at, p.last_active, p.url]));

    let timer;
    el.querySelector('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(loadPosts, 300); };
    el.querySelector('#sort').onchange = loadPosts;
    await loadAuthors();
    await loadPosts();
  }
});
