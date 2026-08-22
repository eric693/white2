// ===== 角色推薦轉盤（8.1～8.16）=====
App.page('wheels', {
  title: '角色轉盤', sub: '轉盤 / 角色 / 標籤 / 權重 / 活動限定 / 統計', module: 'wheels',
  async render(el) {
    await H.loadMeta();
    const [wheels, tags] = await Promise.all([GET('/wheels'), GET('/wheel-tags')]);
    const tagNames = tags.map(t => t.name);

    const roleStatus = (r) => {
      if (!r.enabled) return '<span class="tag">停用</span>';
      // start_at/end_at 存的是台北牆上時間，這裡也要用台北時間比，不能用 UTC 的 toISOString
      const n = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(' ', 'T');
      if (r.start_at && r.start_at > n) return '<span class="tag warn">未開始</span>';
      if (r.end_at && r.end_at < n) return '<span class="tag">已結束</span>';
      return '<span class="tag ok">上架中</span>';
    };

    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增轉盤</button>
        <div class="spacer"></div>
        <button class="btn secondary" id="tagmgr">標籤管理（${tags.length}）</button>
        <button class="btn secondary" id="filterpanel">發布標籤篩選面板</button>
        <button class="btn secondary" id="stats">熱門統計</button>
        <button class="btn secondary" id="draws">抽取紀錄</button></div>
      ${wheels.map(w => `
        <div class="card">
          <div class="toolbar"><h3 style="margin:0">${UI.esc(w.name)}</h3>
            ${w.listed ? '<span class="tag ok">上架</span>' : '<span class="tag">下架</span>'}
            ${H.enabledTag(w.enabled)}
            ${w.daily_limit ? `<span class="tag warn">每日 ${w.daily_limit} 抽</span>` : ''}
            ${w.no_repeat ? '<span class="tag">不重複</span>' : ''}
            ${w.exclude_chatted ? '<span class="tag">排除已聊過</span>' : ''}
            ${w.start_at || w.end_at ? '<span class="tag primary">限定期間</span>' : ''}
            <div class="spacer"></div>
            <button class="btn small" data-post="${w.id}">發布面板</button>
            <button class="btn small secondary" data-listed="${w.id}" data-val="${w.listed ? 0 : 1}">${w.listed ? '下架' : '上架'}</button>
            <button class="btn small secondary" data-ewheel="${w.id}">設定</button>
            <button class="btn small danger" data-dwheel="${w.id}">刪除</button></div>
          <div style="color:var(--muted);margin-bottom:8px">${UI.esc(w.description || '')}
            ${w.tags ? '　' + UI.esc(w.tags.split(',').join('、')) : ''}</div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>角色</th><th>作者</th><th>連結</th><th>標籤</th><th>權重</th><th>抽/收/點</th><th>狀態</th><th></th></tr></thead>
            <tbody>${w.roles.length ? w.roles.map(r => `
              <tr><td class="wrap"><strong>${UI.esc(r.name)}</strong><br>
                  <span style="color:var(--muted)">${UI.esc((r.intro || '').slice(0, 28))}</span></td>
                <td class="wrap">${UI.esc(r.author || '—')}</td>
                <td>${(() => { try { return (JSON.parse(r.links || '[]') || []).length; } catch { return 0; } })()} 個</td>
                <td class="wrap">${UI.esc((r.tags || '').split(',').filter(Boolean).join('、') || '—')}</td>
                <td>${r.weight}</td>
                <td>${r.draw_count} / ${r.fav_count} / ${r.click_count}</td>
                <td>${roleStatus(r)}</td>
                <td><button class="btn tiny secondary" data-erole="${r.id}" data-wheel="${w.id}">編輯</button>
                    <button class="btn tiny secondary" data-mrole="${r.id}">移動</button>
                    <button class="btn tiny danger" data-drole="${r.id}">刪除</button></td></tr>`).join('')
              : '<tr><td colspan="8" class="empty">尚無角色</td></tr>'}
            </tbody></table></div>
          <div class="toolbar" style="margin-top:8px"><button class="btn small" data-arole="${w.id}">＋ 新增角色</button></div>
        </div>`).join('') || '<div class="card empty">尚無轉盤，點左上角新增。</div>'}`;

    // ---- 表單 ----
    const tagPicker = (name, selected) => `
      <div data-tagpick="${name}">
        <div data-tagbox style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;max-height:130px;overflow:auto">
          ${tagNames.map(t => `<label class="switch"><input type="checkbox" value="${UI.esc(t)}" ${(selected || '').split(',').includes(t) ? 'checked' : ''}> ${UI.esc(t)}</label>`).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <input data-newtag placeholder="輸入新標籤，直接建立並勾選" style="flex:1">
          <button type="button" class="btn small secondary" data-addtag>＋ 新增標籤</button>
        </div>
      </div>`;
    // 綁定「即時新增標籤」：建立標籤 → 加到 tagNames → 立即出現並勾選
    const bindTagPickers = (root) => {
      root.querySelectorAll('[data-tagpick]').forEach(box => {
        if (box.dataset.bound) return; box.dataset.bound = '1';
        const tagbox = box.querySelector('[data-tagbox]');
        const input = box.querySelector('[data-newtag]');
        const add = async () => {
          const name = input.value.trim();
          if (!name) return;
          if (!tagNames.includes(name)) {
            try { await POST('/wheel-tags', { name }); tagNames.push(name); } catch (e) { return UI.err(e.message); }
          }
          // 若此 picker 尚未有這個標籤才加入並勾選
          if (![...tagbox.querySelectorAll('input')].some(i => i.value === name)) {
            const l = document.createElement('label'); l.className = 'switch';
            l.innerHTML = `<input type="checkbox" value="${UI.esc(name)}" checked> ${UI.esc(name)}`;
            tagbox.appendChild(l);
          } else {
            [...tagbox.querySelectorAll('input')].find(i => i.value === name).checked = true;
          }
          input.value = ''; UI.ok('已新增標籤：' + name);
        };
        box.querySelector('[data-addtag]').onclick = add;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      });
    };
    // multiVal 讀 tags：改讀 data-tagbox 內勾選的
    const tagsValue = (root, name) => {
      const box = root.querySelector(`[data-tagpick="${name}"] [data-tagbox]`);
      if (!box) return '';
      return [...box.querySelectorAll('input:checked')].map(i => i.value).join(',');
    };

    const wheelForm = (w = {}) => `
      <div class="field"><label>轉盤名稱</label><input name="name" value="${UI.esc(w.name || '')}"></div>
      <div class="field"><label>轉盤介紹</label><textarea name="description">${UI.esc(w.description || '')}</textarea>
        ${H.emojiInsert('description')}</div>
      <div class="field"><label>轉盤封面圖</label>${H.uploadField('image_url', w.image_url || '', { label: '封面' })}</div>
      <div class="field"><label>轉盤標籤（供玩家篩選）</label>${tagPicker('tags', w.tags)}</div>
      <hr>
      <div class="form-row">
        <div class="field"><label>每人每日抽取次數（0＝不限）</label><input name="daily_limit" type="number" value="${w.daily_limit || 0}"></div>
      </div>
      <div class="field">${H.toggle('no_repeat', w.no_repeat ?? 1, '同一玩家不重複抽到相同角色（抽完自動重置新一輪）')}</div>
      <div class="field">${H.toggle('exclude_chatted', w.exclude_chatted ?? 0, '已點過聊天室的角色不再推薦（體驗完自動重置）')}</div>
      <hr>
      <div class="field">${H.toggle('card_enabled', w.card_enabled ?? 0, '抽到角色時做成圖片小卡（角色沒放圖片就不會有圓框）')}</div>
      <div class="field"><label>小卡背景圖（可空＝用角色圖當背景，都沒有就用漸層）</label>
        ${H.uploadField('card_bg', w.card_bg || '', { label: '背景' })}
        ${H.cropButton('card_bg', 1000 / 420, '裁切背景範圍（選要露出哪一塊）')}</div>
      <div class="field">${H.toggle('card_sign', w.card_sign ?? 0, '小卡左下角顯示抽卡人的 Discord 名字')}
        <div class="hint">開啟等於公開「誰抽到誰」，怕玩家介意就先別開。</div></div>
      <div class="field">${H.toggle('card_date', w.card_date ?? 0, '小卡左下角顯示抽卡日期')}
        <div class="hint">兩個都關＝左下角完全不出現任何字。</div></div>
      <div class="field"><button class="btn secondary small" id="cardpv" type="button">預覽小卡</button>
        <div id="cardbox" style="margin-top:8px"></div></div>
      <hr>
      <div class="form-row">
        <div class="field"><label>活動開始（可空）</label><input name="start_at" type="datetime-local" value="${UI.esc(w.start_at || '')}"></div>
        <div class="field"><label>活動結束（可空）</label><input name="end_at" type="datetime-local" value="${UI.esc(w.end_at || '')}"></div>
      </div>
      <div class="field">${H.toggle('listed', w.listed ?? 1, '上架（下架後玩家看不到，但資料完整保留）')}</div>
      <div class="field">${H.toggle('enabled', w.enabled ?? 1, '啟用')}</div>`;

    const roleForm = (r = {}) => `
      <div class="field"><label>角色名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
      <div class="field"><label>廣告台詞</label><textarea name="intro">${UI.esc(r.intro || '')}</textarea>
        ${H.emojiInsert('intro')}</div>
      <div class="field"><label>作者</label><input name="author" value="${UI.esc(r.author || '')}" placeholder="角色作者名稱"></div>
      <div class="field"><label>角色標籤</label>${tagPicker('tags', r.tags)}</div>
      <div class="field"><label>角色圖片</label>${H.uploadField('image_url', r.image_url || '', { label: '角色圖' })}</div>
      <div class="field"><label>角色連結（圖標＋文字，可多個）</label>${H.buttonsEditor('links', r.links)}
        <div class="hint">例如聊天室、平台頁面、作者專頁。玩家抽到角色後會看到對應按鈕。</div></div>
      <div class="form-row">
        <div class="field"><label>推薦權重（越大越常出現）</label><input name="weight" type="number" min="1" value="${r.weight || 1}"></div>
        <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort || 0}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>限定開始（可空）</label><input name="start_at" type="datetime-local" value="${UI.esc(r.start_at || '')}"></div>
        <div class="field"><label>限定結束（可空）</label><input name="end_at" type="datetime-local" value="${UI.esc(r.end_at || '')}"></div>
      </div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用此角色')}</div>`;

    const collect = (back) => {
      const b = H.collect(back);
      b.tags = tagsValue(back, 'tags');
      b.links = H.buttonsValue(back, 'links');
      return b;
    };

    const openForm = (opts) => {
      const m = UI.modal(opts);
      H.bindUploads(m.back);
      H.bindCropButtons(m.back);
      H.bindButtons(m.back);
      H.bindMentions(m.back);
      bindTagPickers(m.back);
      const pv = m.back.querySelector('#cardpv');
      if (pv) pv.onclick = () => {
        const g = (n) => { const el = m.back.querySelector(`[name="${n}"]`); return el ? encodeURIComponent(el.value) : ''; };
        // 名字／日期各自照開關決定要不要畫，讓預覽和實際發出來的卡一致
        const on = (n) => { const el = m.back.querySelector(`[name="${n}"]`); return !!(el && el.checked); };
        const sign = (on('card_sign') ? `&by=${encodeURIComponent('抽卡人名字')}` : '')
          + (on('card_date') ? '&d=1' : '');
        m.back.querySelector('#cardbox').innerHTML =
          `<img src="/api/rolecard-preview?bg=${g('card_bg')}&name=${encodeURIComponent('範例角色')}&author=${encodeURIComponent('作者')}&tags=${encodeURIComponent('標籤')}&intro=${encodeURIComponent('這是廣告台詞的樣子')}${sign}&_=${Date.now()}"
            style="max-width:100%;border-radius:8px;border:1px solid var(--border)">`;
      };
      return m;
    };
    el.querySelector('#add').onclick = () => openForm({ title: '新增轉盤', bodyHTML: wheelForm(),
      onOk: async (back) => { await POST('/wheels', collect(back)); UI.ok('已新增'); App.go('wheels'); } });

    el.querySelectorAll('[data-ewheel]').forEach(b => b.onclick = () => {
      const w = wheels.find(x => x.id == b.dataset.ewheel);
      openForm({ title: '轉盤設定', bodyHTML: wheelForm(w),
        onOk: async (back) => { await PUT('/wheels/' + w.id, collect(back)); UI.ok('已儲存'); App.go('wheels'); } });
    });
    el.querySelectorAll('[data-listed]').forEach(b => b.onclick = async () => {
      await PUT('/wheels/' + b.dataset.listed + '/listed', { listed: +b.dataset.val });
      UI.ok(+b.dataset.val ? '已上架' : '已下架'); App.go('wheels'); });
    el.querySelectorAll('[data-dwheel]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除整個轉盤及其角色、抽取紀錄？')) return;
      await DEL('/wheels/' + b.dataset.dwheel); UI.ok('已刪除'); App.go('wheels'); });

    el.querySelectorAll('[data-arole]').forEach(b => b.onclick = () => openForm({ title: '新增角色', bodyHTML: roleForm(),
      onOk: async (back) => { await POST('/wheels/' + b.dataset.arole + '/roles', collect(back)); UI.ok('已新增'); App.go('wheels'); } }));
    el.querySelectorAll('[data-erole]').forEach(b => b.onclick = () => {
      const w = wheels.find(x => x.id == b.dataset.wheel); const r = w.roles.find(x => x.id == b.dataset.erole);
      openForm({ title: '編輯角色', bodyHTML: roleForm(r),
        onOk: async (back) => { await PUT('/wheel-roles/' + r.id, collect(back)); UI.ok('已儲存'); App.go('wheels'); } });
    });
    el.querySelectorAll('[data-mrole]').forEach(b => b.onclick = () => UI.modal({
      title: '移動角色到其他轉盤', okText: '移動',
      bodyHTML: `<div class="field"><label>目標轉盤</label><select name="wheel_id">
        ${wheels.map(w => `<option value="${w.id}">${UI.esc(w.name)}</option>`).join('')}</select></div>`,
      onOk: async (back) => { await PUT('/wheel-roles/' + b.dataset.mrole + '/move', H.collect(back)); UI.ok('已移動'); App.go('wheels'); }
    }));
    el.querySelectorAll('[data-drole]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此角色？')) return;
      await DEL('/wheel-roles/' + b.dataset.drole); UI.ok('已刪除'); App.go('wheels'); });

    el.querySelectorAll('[data-post]').forEach(b => b.onclick = () => UI.modal({
      title: '發布轉盤面板', okText: '發布',
      bodyHTML: `<div class="field"><label>選擇頻道</label>${H.chanSelect('channel_id', '')}</div>`,
      onOk: async (back) => {
        const b2 = H.collect(back); if (!b2.channel_id) { UI.err('請選頻道'); return false; }
        await POST('/wheels/' + b.dataset.post + '/post', b2); UI.ok('已發布'); }
    }));

    el.querySelector('#filterpanel').onclick = () => UI.modal({
      title: '發布標籤篩選面板', okText: '發布',
      bodyHTML: `<div class="field"><label>選擇頻道</label>${H.chanSelect('channel_id', '')}</div>
        <div class="field"><div class="hint">玩家可在此面板用標籤篩選出想玩的轉盤。</div></div>`,
      onOk: async (back) => {
        const b2 = H.collect(back); if (!b2.channel_id) { UI.err('請選頻道'); return false; }
        await POST('/wheels/filter-panel', b2); UI.ok('已發布'); }
    });

    // ---- 8.3 標籤管理 ----
    el.querySelector('#tagmgr').onclick = () => {
      const m = UI.modal({
        title: '角色分類標籤', okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="field"><label>新增標籤</label>
            <div style="display:flex;gap:6px"><input id="newtag" placeholder="例如：病嬌"><button class="btn small" id="addtag">新增</button></div></div>
          <div class="field"><label>現有標籤（可改名／刪除）</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${tags.map(t => `<div style="display:flex;gap:6px;align-items:center">
                <input data-tagedit="${t.id}" value="${UI.esc(t.name)}" style="flex:1">
                <button type="button" class="btn small secondary" data-savetag="${t.id}">改名</button>
                <button type="button" class="btn small secondary" data-deltag="${t.id}">刪除</button>
              </div>`).join('') || '<span class="hint">尚無標籤</span>'}
            </div></div>`
      });
      m.back.querySelector('#addtag').onclick = async () => {
        const name = m.back.querySelector('#newtag').value.trim();
        if (!name) return;
        try { await POST('/wheel-tags', { name }); UI.ok('已新增'); App.go('wheels'); } catch (e) { UI.err(e.message); }
      };
      m.back.addEventListener('click', async (ev) => {
        const save = ev.target.dataset.savetag;
        const del = ev.target.dataset.deltag;
        if (save) {
          ev.preventDefault();
          const name = (m.back.querySelector(`[data-tagedit="${save}"]`).value || '').trim();
          if (!name) return UI.err('請輸入標籤名稱');
          try { await PUT('/wheel-tags/' + save, { name }); UI.ok('已更新'); App.go('wheels'); } catch (e) { UI.err(e.message); }
        } else if (del) {
          ev.preventDefault();
          if (!await UI.confirm('刪除此標籤？')) return;
          await DEL('/wheel-tags/' + del); UI.ok('已刪除'); App.go('wheels');
        }
      });
    };

    // ---- 8.13 熱門統計 ----
    el.querySelector('#stats').onclick = async () => {
      const s = await GET('/wheel-stats');
      UI.modal({
        title: '熱門角色統計', okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="stat-grid" style="margin-bottom:12px">
            <div class="stat"><div class="num">${s.totals.draws}</div><div class="label">總抽取次數</div></div>
            <div class="stat"><div class="num">${s.totals.favs}</div><div class="label">總收藏數</div></div>
            <div class="stat"><div class="num">${s.totals.chats}</div><div class="label">聊天室點擊</div></div>
            <div class="stat"><div class="num">${s.totals.users}</div><div class="label">參與玩家</div></div>
          </div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>#</th><th>角色</th><th>轉盤</th><th>抽取</th><th>收藏</th><th>點擊</th></tr></thead>
            <tbody>${s.roles.length ? s.roles.map((r, n) => `
              <tr><td>${n + 1}</td><td>${UI.esc(r.name)}</td><td>${UI.esc(r.wheel_name)}</td>
                <td>${r.draw_count}</td><td>${r.fav_count}</td><td>${r.click_count}</td></tr>`).join('')
              : '<tr><td colspan="6" class="empty">尚無資料</td></tr>'}
            </tbody></table></div>`
      });
    };

    // ---- 8.8 抽取紀錄 ----
    el.querySelector('#draws').onclick = async () => {
      const rows = await GET('/wheel-draws');
      UI.modal({
        title: `抽取紀錄（最近 ${rows.length} 筆）`, okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>轉盤</th><th>抽到角色</th><th>輪次</th></tr></thead>
          <tbody>${rows.length ? rows.map(r => `
            <tr><td>${UI.esc(r.created_at)}</td>
              <td class="wrap">${UI.esc(r.username || '—')}<br><code>${r.user_id}</code></td>
              <td>${UI.esc(r.wheel_name || '—')}</td><td>${UI.esc(r.role_name || '（已刪除）')}</td>
              <td>第 ${r.round} 輪</td></tr>`).join('')
            : '<tr><td colspan="5" class="empty">尚無紀錄</td></tr>'}
          </tbody></table></div>`
      });
    };
  }
});

// ===== 提醒 =====
App.page('reminders', {
  title: '提醒', sub: '單次 / 每日 / 每週 / 每月 定時提醒', module: 'reminders',
  async render(el) {
    await H.loadMeta();
    const rows = await GET('/reminders');
    const freqLabel = r => ({ once: '單次 ' + (r.run_at || '').replace('T', ' '), daily: '每日 ' + r.at_time,
      weekly: '每週' + ['日','一','二','三','四','五','六'][r.at_dow] + ' ' + r.at_time,
      monthly: `每月 ${r.at_dom} 日 ` + r.at_time }[r.freq] || r.freq);
    const notes = [...new Set(rows.map(r => (r.note || '').trim()).filter(Boolean))];
    const chips = notes.length ? `<div class="toolbar" id="notefilter" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <span style="color:var(--muted);align-self:center">依備註篩選：</span>
        <button class="btn tiny" data-note="">全部</button>
        ${notes.map(n => `<button class="btn tiny secondary" data-note="${UI.esc(n)}">${UI.esc(n)}</button>`).join('')}
      </div>` : '';
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增提醒</button></div>
      ${chips}
      <div class="table-wrap"><table class="list">
        <thead><tr><th>標題</th><th>頻率</th><th>頻道</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr data-note="${UI.esc((r.note || '').trim())}"><td class="wrap">${r.note ? `<span class="tag">${UI.esc(r.note)}</span><br>` : ''}<strong>${UI.esc(r.title || '（無標題）')}</strong><br><span style="color:var(--muted)">${UI.esc((r.message || '').slice(0, 30))}</span></td>
            <td>${UI.esc(freqLabel(r))}</td><td>${H.chanName(r.channel_id)}</td><td>${H.enabledTag(r.enabled)}</td>
            <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                <button class="btn tiny secondary" data-toggle="${r.id}">${r.enabled ? '暫停' : '啟用'}</button>
                <button class="btn tiny secondary" data-logs="${r.id}">紀錄</button>
                <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="5" class="empty">尚無提醒</td></tr>'}
        </tbody></table></div>`;

    const form = (r = {}) => `
      <div class="field"><label>內部備註（只有後台看得到，玩家不會看到）</label>
        <input name="note" value="${UI.esc(r.note || '')}" placeholder="例如：每週活動提醒　會顯示成列表上的標籤，方便整理"></div>
      <div class="field"><label>標題</label><input name="title" value="${UI.esc(r.title || '')}"></div>
      <div class="field"><label>提醒內容</label><textarea name="message">${UI.esc(r.message || '')}</textarea>
        ${H.mentionPicker('message')}</div>
      <div class="field"><label>發送頻道</label>${H.chanSelect('channel_id', r.channel_id)}</div>
      <div class="field"><label>圖片</label>${H.uploadField('image_url', r.image_url || '', { label: '圖片' })}</div>
      <div class="field"><label>連結按鈕（圖標＋文字，可多個）</label>${H.buttonsEditor('buttons', r.buttons)}</div>
      ${H.memberPicker('mention_ids', '', { multi: true, label: '搜尋要標記的玩家（暱稱或名稱）' })}
      <div class="field"><label>標記使用者 ID（逗號分隔，可空）</label><input name="mention_ids" value="${UI.esc(r.mention_ids || '')}"></div>
      <div class="field"><label>標記身分組</label>${H.roleSelect('mention_role_ids', (r.mention_role_ids || '').split(',')[0] || '')}</div>
      <div class="form-row">
        <div class="field">${H.toggle('mention_everyone', r.mention_everyone, '標記 @everyone')}</div>
        <div class="field">${H.toggle('do_mention', r.do_mention ?? 1, '實際發出標記(ping)')}</div>
      </div>
      <div class="field"><label>頻率</label>
        <select name="freq" id="freq">
          ${['once','daily','weekly','monthly'].map(f => `<option value="${f}" ${r.freq === f ? 'selected' : ''}>${{once:'單次',daily:'每日',weekly:'每週',monthly:'每月'}[f]}</option>`).join('')}
        </select></div>
      <div class="field freq-once" ${r.freq && r.freq !== 'once' ? 'style=display:none' : ''}><label>指定時間</label><input name="run_at" type="datetime-local" value="${UI.esc(r.run_at || '')}"></div>
      <div class="field freq-time" ${!r.freq || r.freq === 'once' ? 'style=display:none' : ''}><label>時間（HH:MM）</label><input name="at_time" value="${UI.esc(r.at_time || '09:00')}"></div>
      <div class="field freq-week" ${r.freq !== 'weekly' ? 'style=display:none' : ''}><label>星期</label>
        <select name="at_dow">${['日','一','二','三','四','五','六'].map((d,idx) => `<option value="${idx}" ${r.at_dow === idx ? 'selected' : ''}>星期${d}</option>`).join('')}</select></div>
      <div class="field freq-month" ${r.freq !== 'monthly' ? 'style=display:none' : ''}><label>每月幾號</label><input name="at_dom" type="number" value="${r.at_dom || 1}"></div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用')}</div>
      <div class="field"><button class="btn secondary small" type="button" data-pv>預覽</button>
        <div data-pvbox style="margin-top:8px"></div></div>`;

    const wire = (back) => {
      // 預覽（模擬 Discord Embed）
      const pv = back.querySelector('[data-pv]');
      if (pv) pv.onclick = () => {
        const g = (n) => { const el = back.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
        let btns = []; try { btns = JSON.parse(H.buttonsValue(back, 'buttons')); } catch {}
        const img = g('image_url');
        back.querySelector('[data-pvbox]').innerHTML = `
          <div style="background:#313338;color:#dbdee1;padding:12px;border-radius:8px">
            <div style="border-left:4px solid #5865f2;background:#2b2d31;padding:10px 12px;border-radius:4px;max-width:440px">
              ${g('title') ? `<div style="font-weight:700;margin-bottom:6px">${UI.esc(g('title'))}</div>` : ''}
              <div style="white-space:pre-wrap">${UI.esc(g('message'))}</div>
              ${img ? `<div style="margin-top:8px"><img src="${UI.esc(img)}" style="max-width:100%;border-radius:4px"></div>` : ''}
            </div>
            ${btns.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${btns.map(b=>`<span style="background:#4e5058;padding:6px 14px;border-radius:4px">${UI.esc(b.emoji||'')} ${UI.esc(b.label||'前往')} ↗</span>`).join('')}</div>` : ''}
          </div>`;
      };
      const fr = back.querySelector('#freq');
      const upd = () => {
        const v = fr.value;
        back.querySelector('.freq-once').style.display = v === 'once' ? 'block' : 'none';
        back.querySelector('.freq-time').style.display = v !== 'once' ? 'block' : 'none';
        back.querySelector('.freq-week').style.display = v === 'weekly' ? 'block' : 'none';
        back.querySelector('.freq-month').style.display = v === 'monthly' ? 'block' : 'none';
      };
      fr.addEventListener('change', upd);
    };
    const openModal = (r) => { const m = UI.modal({ title: r ? '編輯提醒' : '新增提醒', bodyHTML: form(r || {}),
      onOk: async (back) => { const b = H.collect(back);
        b.buttons = H.buttonsValue(back, 'buttons');
        if (r) await PUT('/reminders/' + r.id, b); else await POST('/reminders', b); UI.ok('已儲存'); App.go('reminders'); } });
      wire(m.back); H.bindUploads(m.back); H.bindButtons(m.back); H.bindMentions(m.back); H.bindMemberPickers(m.back); };

    el.querySelector('#add').onclick = () => openModal(null);
    // 依內部備註篩選列表（點「全部」看全部）
    el.querySelectorAll('#notefilter [data-note]').forEach(b => b.onclick = () => {
      const want = b.dataset.note;
      el.querySelectorAll('#notefilter [data-note]').forEach(x => x.classList.toggle('secondary', x !== b));
      el.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = (!want || tr.dataset.note === want) ? '' : 'none'; });
    });
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openModal(rows.find(r => r.id == b.dataset.edit)));
    el.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      await POST('/reminders/' + b.dataset.toggle + '/toggle'); UI.ok('已更新'); App.go('reminders'); });
    el.querySelectorAll('[data-logs]').forEach(b => b.onclick = async () => {
      const logs = await GET('/reminders/' + b.dataset.logs + '/logs');
      UI.modal({ title: '發送紀錄', okText: '關閉', onOk: () => {}, bodyHTML: `
        <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="list">
          <thead><tr><th>時間</th><th>狀態</th><th>錯誤</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `<tr><td>${UI.esc(l.sent_at)}</td>
            <td>${l.status === 'ok' ? '<span class="tag ok">成功</span>' : '<span class="tag danger">失敗</span>'}</td>
            <td class="wrap">${UI.esc(l.error || '')}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">尚無紀錄</td></tr>'}
        </tbody></table></div>` });
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此提醒？')) return;
      await DEL('/reminders/' + b.dataset.del); UI.ok('已刪除'); App.go('reminders'); });
  }
});

// ===== 帳號權限 =====
App.page('users', {
  title: '帳號權限', sub: '管理後台帳號與可用功能', module: 'users',
  async render(el) {
    const [users, me] = [await GET('/users'), App.me];
    const mods = me.all_modules;
    const guilds = ((await GET('/guilds')).guilds) || [];
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增帳號</button>
        <div class="spacer"></div><button class="btn secondary" id="pw">修改我的密碼</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>帳號</th><th>名稱</th><th>角色</th><th>權限</th><th>狀態</th><th></th></tr></thead>
        <tbody>${users.map(u => `
          <tr><td><code>${UI.esc(u.username)}</code></td><td>${UI.esc(u.name)}</td>
            <td>${u.role === 'admin' ? '<span class="tag primary">總管理員</span>' : '管理員'}</td>
            <td class="wrap">${u.role === 'admin' ? '全部功能' : UI.esc(u.permissions || '（無）')}</td>
            <td>${H.enabledTag(u.active)}</td>
            <td><button class="btn tiny secondary" data-edit="${u.id}">編輯</button>
                ${u.id !== me.id ? `<button class="btn tiny danger" data-del="${u.id}">刪除</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>`;

    // 權限依分區列出（總覽／互動／活動／遊戲區／設定），每區有「全選」——
    // 要把整個遊戲區交給某個人，勾一次就好；只想給他新聞，也只勾那一個。
    const permBox = (sel = []) => {
      const order = ['', '互動', '活動', '遊戲區', '設定'];
      const groups = order
        .map(g => ({ name: g, items: mods.filter(m => (m.group || '') === g) }))
        .filter(g => g.items.length);
      // 舊版的模組沒有 group 欄位，別讓它們消失
      const known = new Set(groups.flatMap(g => g.items.map(m => m.key)));
      const rest = mods.filter(m => !known.has(m.key));
      if (rest.length) groups.push({ name: '其他', items: rest });
      return `<div class="field"><label>可用功能（總管理員角色會全開）</label>
        ${groups.map(g => `
          <div style="margin:10px 0 4px;display:flex;align-items:center;gap:8px">
            <b style="font-size:13px;color:var(--muted)">${UI.esc(g.name || '總覽')}</b>
            <button type="button" class="btn tiny secondary" data-permall="${UI.esc(g.name)}">全選／全不選</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px" data-permgroup="${UI.esc(g.name)}">
            ${g.items.map(m => `<label class="switch"><input type="checkbox" data-perm value="${m.key}" ${sel.includes(m.key) ? 'checked' : ''}> ${UI.esc(m.label)}</label>`).join('')}
          </div>`).join('')}
      </div>`;
    };
    // modal 內的「全選」要在開啟後才綁得到，統一用事件委派；只綁一次，不然重進頁面會疊上去
    if (!window.__permAllBound) {
      window.__permAllBound = true;
      document.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-permall]');
      if (!btn) return;
      const wrap = btn.closest('.modal-back') || document;
      const box = wrap.querySelector(`[data-permgroup="${btn.dataset.permall}"]`);
      if (!box) return;
      const boxes = box.querySelectorAll('[data-perm]');
      const allOn = Array.from(boxes).every(x => x.checked);
      boxes.forEach(x => { x.checked = !allOn; });
      });
    }
    const collectPerms = back => Array.from(back.querySelectorAll('[data-perm]:checked')).map(x => x.value);
    const guildBox = (sel = []) => `<div class="field"><label>可管理的伺服器（此帳號只看得到勾選的伺服器；不勾＝僅主伺服器。總管理員不受此限制）</label>
      <div style="display:grid;gap:4px">
        ${guilds.map(g => `<label class="switch"><input type="checkbox" data-guild value="${g.id}" ${sel.includes(g.id) ? 'checked' : ''}> ${UI.esc(g.name)}</label>`).join('') || '<span class="hint">目前沒有可綁定的伺服器</span>'}
      </div></div>`;
    const collectGuilds = back => Array.from(back.querySelectorAll('[data-guild]:checked')).map(x => x.value);

    const form = (u = {}) => `
      <div class="field"><label>帳號</label><input name="username" value="${UI.esc(u.username || '')}" ${u.id ? 'disabled' : ''}></div>
      <div class="field"><label>名稱</label><input name="name" value="${UI.esc(u.name || '')}"></div>
      <div class="field"><label>密碼${u.id ? '（留空不變）' : ''}</label><input name="password" type="password"></div>
      <div class="field"><label>角色</label><select name="role" id="role">
        <option value="staff" ${u.role !== 'admin' ? 'selected' : ''}>管理員（限定功能與伺服器）</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>總管理員（全部功能、全部伺服器）</option></select></div>
      ${permBox((u.permissions || '').split(',').filter(Boolean))}
      ${guildBox((u.guild_ids || '').split(',').filter(Boolean))}
      <div class="field">${H.toggle('active', u.active ?? 1, '啟用帳號')}</div>`;

    el.querySelector('#add').onclick = () => UI.modal({ title: '新增帳號', bodyHTML: form(),
      onOk: async (back) => { const b = H.collect(back); b.permissions = collectPerms(back); b.guild_ids = collectGuilds(back);
        await POST('/users', b); UI.ok('已新增'); App.go('users'); } });
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const u = users.find(x => x.id == b.dataset.edit);
      UI.modal({ title: '編輯帳號', bodyHTML: form(u),
        onOk: async (back) => { const body = H.collect(back); body.permissions = collectPerms(back); body.guild_ids = collectGuilds(back);
          await PUT('/users/' + u.id, body); UI.ok('已儲存'); App.go('users'); } });
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此帳號？')) return;
      await DEL('/users/' + b.dataset.del); UI.ok('已刪除'); App.go('users'); });

    el.querySelector('#pw').onclick = () => UI.modal({ title: '修改我的密碼', bodyHTML: `
      <div class="field"><label>原密碼</label><input name="old_password" type="password"></div>
      <div class="field"><label>新密碼（至少 6 碼）</label><input name="new_password" type="password"></div>`,
      onOk: async (back) => { await PUT('/me/password', H.collect(back)); UI.ok('密碼已更新'); } });
  }
});
