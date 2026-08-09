// ===== 客服單 =====
App.page('tickets', {
  title: '客服單', sub: '可建立多組面板，玩家點按鈕開啟專屬客服頻道', module: 'tickets',
  async render(el) {
    await H.loadMeta();
    const [c, panels, list, cats] = await Promise.all([
      GET('/ticket-config'), GET('/ticket-panels'), GET('/tickets'), GET('/discord/categories').catch(() => [])
    ]);
    const catSelect = (name, sel) => `<select name="${name}">
      <option value="">— 用全域預設分類 —</option>
      ${cats.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${UI.esc(x.name)}</option>`).join('')}
    </select>`;

    el.innerHTML = `
      <div class="card" style="max-width:700px" id="wrap">
        <h3>全域設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用客服單功能')}</div>
        <div class="field"><label>預設分類（面板沒指定時用這個）</label>${catSelect('category_id', c.category_id)}</div>
        <div class="field"><label>預設客服身分組</label>
          ${multiBox('support_role_ids', H.roles || [], c.support_role_ids, r => '@ ' + r.name)}</div>
        <div class="field"><label>關單紀錄頻道</label>${H.chanSelect('log_channel', c.log_channel)}</div>
        <div class="field"><label>每人同時最多開幾張單</label><input name="max_open" type="number" min="1" value="${c.max_open}"></div>
        <button class="btn" id="save">儲存全域設定</button>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">客服面板（${panels.length}）</h3><div class="spacer"></div>
          <button class="btn" id="addp">＋ 新增面板</button></div>
        <div class="hint" style="margin-bottom:10px">每組面板可獨立設定標題、說明、圖片、超連結、專屬客服身分組與分類。也可用 <code>/客服面板</code> 發布第一個面板。</div>
        ${panels.length ? panels.map(p => `
          <div class="card" style="box-shadow:none;border:1px solid var(--border)">
            <div class="toolbar"><strong>${UI.esc(p.name)}</strong> ${p.enabled ? '<span class="tag ok">啟用</span>' : '<span class="tag">停用</span>'}
              ${p.note ? `<span class="tag">${UI.esc(p.note)}</span>` : ''}
              <span style="color:var(--muted)">${UI.esc(p.title)}</span><div class="spacer"></div>
              <button class="btn small secondary" data-pv="${p.id}">預覽</button>
              <button class="btn small" data-post="${p.id}">發布</button>
              <button class="btn small secondary" data-edit="${p.id}">編輯</button>
              <button class="btn small danger" data-delp="${p.id}">刪除</button></div>
          </div>`).join('') : '<div class="empty">尚無面板，點右上角新增。</div>'}
      </div>

      <div class="card">
        <h3>客服單紀錄（${list.length}）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>#</th><th>面板</th><th>開單者</th><th>主旨</th><th>狀態</th><th>開單時間</th><th>關閉者</th></tr></thead>
          <tbody>${list.length ? list.map(t => `
            <tr><td>${t.id}</td><td>${UI.esc(t.panel_name || '—')}</td>
              <td class="wrap">${UI.esc(t.username)}<br><code>${t.user_id}</code></td>
              <td class="wrap">${UI.esc(t.subject || '—')}</td>
              <td>${t.status === 'open' ? '<span class="tag ok">處理中</span>' : '<span class="tag">已關閉</span>'}</td>
              <td>${UI.esc(t.opened_at)}</td><td>${UI.esc(t.closed_by || '—')}</td></tr>`).join('')
            : '<tr><td colspan="7" class="empty">尚無客服單</td></tr>'}
          </tbody></table></div>
      </div>`;

    const wrap = el.querySelector('#wrap');
    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const b = H.collect(wrap);
        b.support_role_ids = multiVal(wrap, 'support_role_ids');
        // 全域設定沿用舊欄位名，補上面板不需要的欄位避免清空
        b.panel_title = c.panel_title; b.panel_text = c.panel_text;
        b.button_label = c.button_label; b.welcome_text = c.welcome_text;
        await PUT('/ticket-config', b); UI.ok('已儲存');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    // ---- 面板表單 ----
    const panelForm = (p = {}) => `
      <div class="field"><label>面板名稱（後台辨識用）</label><input name="name" value="${UI.esc(p.name || '')}" placeholder="例如：一般諮詢"></div>
      <div class="field"><label>內部備註（只有後台看得到）</label>
        <input name="note" value="${UI.esc(p.note || '')}" placeholder="方便整理用"></div>
      <div class="form-row">
        <div class="field"><label>按鈕圖標</label><input name="button_emoji" data-bemoji value="${UI.esc(p.button_emoji || '')}" style="width:70px;text-align:center"></div>
        <div class="field"><label>按鈕文字</label><input name="button_label" value="${UI.esc(p.button_label || '開啟客服單')}"></div>
      </div>
      <div class="field"><label>面板標題</label><input name="title" value="${UI.esc(p.title || '客服中心')}"></div>
      <div class="field"><label>面板說明</label><textarea name="description">${UI.esc(p.description || '')}</textarea>
        ${H.emojiInsert('description')}</div>
      <div class="field"><label>面板圖片（可空，多張會排成圖庫）</label>
        ${H.multiUploadField('images', p.images || (p.image_url ? JSON.stringify([p.image_url]) : '[]'))}</div>
      <div class="field"><label>超連結按鈕（例如 FAQ、社群規範，可多個）</label>${H.buttonsEditor('links', p.links)}</div>
      <hr>
      <h4>開單後的畫面</h4>
      <div class="field"><label>開單後歡迎訊息（可用 {user}）</label><textarea name="welcome_text">${UI.esc(p.welcome_text || '你好 {user}！請直接在這裡描述你的問題，客服人員會盡快回覆。')}</textarea>
        ${H.mentionPicker('welcome_text')}</div>
      <div class="field"><label>開單訊息圖片（可空，多張會排成圖庫）</label>
        ${H.multiUploadField('open_images', p.open_images || (p.open_image ? JSON.stringify([p.open_image]) : '[]'))}
        <div class="hint">玩家開單後，在客服單頻道看到的第一則訊息。放「請準備哪些資料」的範例圖最有用。</div></div>
      <div class="field"><label>開單訊息的超連結按鈕（可多個）</label>${H.buttonsEditor('open_links', p.open_links)}</div>
      <div class="field"><label>此面板專屬分類（可空＝用全域預設）</label>${catSelect('category_id', p.category_id)}</div>
      <div class="field"><label>此面板專屬客服身分組（可空＝用全域預設）</label>
        ${multiBox('support_role_ids', H.roles || [], p.support_role_ids, r => '@ ' + r.name)}</div>
      <div class="field">${H.toggle('enabled', p.enabled ?? 1, '啟用此面板')}</div>
      <div class="field"><button class="btn secondary small" id="pv" type="button">預覽目前設定</button></div>`;

    const collect = (back) => {
      const b = H.collect(back);
      b.links = H.buttonsValue(back, 'links');
      b.open_links = H.buttonsValue(back, 'open_links');
      b.support_role_ids = multiVal(back, 'support_role_ids');
      b.images = H.multiUploadValue(back, 'images');
      b.open_images = H.multiUploadValue(back, 'open_images');
      return b;
    };
    const openForm = (opts) => {
      const m = UI.modal(opts);
      H.bindUploads(m.back); H.bindButtons(m.back); H.bindMentions(m.back);
      H.bindMultiUploads(m.back);
      // 已存的自訂表情要畫成圖，不然欄位裡只會看到一長串 <:name:id> 代碼
      H.paintEmojiInputs(m.back);
      // 表單內的預覽：讀「目前畫面上的值」，所以改一改就能立刻看效果，不用先存檔
      const pv = m.back.querySelector('#pv');
      if (pv) pv.onclick = () => UI.modal({
        title: '面板預覽', okText: '關閉', onOk: () => {}, bodyHTML: previewHTML(collect(m.back))
      });
      return m;
    };

    el.querySelector('#addp').onclick = () => openForm({
      title: '新增客服面板', bodyHTML: panelForm(),
      onOk: async (back) => { const b = collect(back); if (!b.name) { UI.err('請填面板名稱'); return false; }
        await POST('/ticket-panels', b); UI.ok('已新增'); App.go('tickets'); }
    });
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const p = panels.find(x => x.id == b.dataset.edit);
      openForm({ title: '編輯客服面板', bodyHTML: panelForm(p),
        onOk: async (back) => { await PUT('/ticket-panels/' + p.id, collect(back)); UI.ok('已儲存'); App.go('tickets'); } });
    });
    el.querySelectorAll('[data-delp]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此面板？已開的客服單不受影響。')) return;
      await DEL('/ticket-panels/' + b.dataset.delp); UI.ok('已刪除'); App.go('tickets'); });

    el.querySelectorAll('[data-post]').forEach(b => b.onclick = () => UI.modal({
      title: '發布面板到頻道', okText: '發布',
      bodyHTML: `<div class="field"><label>選擇頻道</label>${H.chanSelect('channel_id', '')}
          <div class="hint">面板會以機器人的身分，發送一則帶按鈕的訊息到你選的這個頻道。</div></div>`,
      onOk: async (back) => { const ch = H.collect(back).channel_id; if (!ch) { UI.err('請選頻道'); return false; }
        await POST('/ticket-panel', { channel_id: ch, panel_id: +b.dataset.post });
        // 只說「已發布」會讓人找不到面板跑去哪，把頻道名一起講出來
        UI.ok('已發布到 ' + H.chanName(ch)); }
    }));

    // 面板預覽（模擬 Discord 版面）。標題/說明/圖標都走 renderDiscordText，
    // 否則自訂表情會顯示成 <:name:id> 原始碼，跟實際發出去的樣子對不起來。
    const previewHTML = (p) => {
      let links = []; try { links = JSON.parse(p.links || '[]'); } catch {}
      const dc = (v) => H.renderDiscordText(v || '');
      return `
        <div style="background:#313338;color:#dbdee1;padding:14px;border-radius:8px">
          <div style="border-left:4px solid #5865f2;background:#2b2d31;padding:10px 12px;border-radius:4px;max-width:440px">
            <div style="font-weight:700;margin-bottom:6px">${dc(p.title)}</div>
            <div style="white-space:pre-wrap">${dc(p.description)}</div>
            ${(() => {
              let im = []; try { im = JSON.parse(p.images || '[]'); } catch {}
              if (!im.length && p.image_url) im = [p.image_url];
              if (!im.length) return '';
              return `<div style="margin-top:8px;display:grid;grid-template-columns:repeat(${im.length > 1 ? 2 : 1},1fr);gap:4px">`
                + im.map(u => `<img src="${UI.esc(u)}" style="width:100%;border-radius:4px">`).join('') + '</div>';
            })()}
          </div>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
            <span style="background:#5865f2;color:#fff;padding:6px 14px;border-radius:4px">${dc(p.button_emoji)} ${UI.esc(p.button_label || '開啟客服單')}</span>
            ${links.map(l => `<span style="background:#4e5058;padding:6px 14px;border-radius:4px">${dc(l.emoji)} ${UI.esc(l.label || '前往')} ↗</span>`).join('')}
          </div>
        </div>`;
    };

    el.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => {
      const p = panels.find(x => x.id == b.dataset.pv);
      UI.modal({ title: '面板預覽', okText: '關閉', onOk: () => {}, bodyHTML: previewHTML(p) });
    });
  }
});

// ===== 經驗值等級 =====
App.page('levels', {
  title: '經驗值等級', sub: '聊天得經驗值，升級自動換身分組', module: 'levels',
  async render(el) {
    await H.loadMeta();
    const [d, board] = await Promise.all([GET('/xp-config'), GET('/xp-leaderboard')]);
    const c = d.config;

    el.innerHTML = `
      <div class="card" style="max-width:700px" id="wrap">
        <h3>經驗值設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用聊天經驗值')}</div>
        <div class="form-row">
          <div class="field"><label>每次獲得 XP（最少）</label><input name="min_xp" type="number" min="1" value="${c.min_xp}"></div>
          <div class="field"><label>每次獲得 XP（最多）</label><input name="max_xp" type="number" min="1" value="${c.max_xp}"></div>
          <div class="field"><label>冷卻秒數（防洗版）</label><input name="cooldown" type="number" min="0" value="${c.cooldown}"></div>
        </div>
        <div class="field"><label>不計算經驗值的頻道</label>
          ${multiBox('ignore_channels', H.channels || [], c.ignore_channels, x => '# ' + x.name)}</div>
        <div class="field"><label>升級公告頻道（空＝在玩家發言的頻道）</label>${H.chanSelect('levelup_channel', c.levelup_channel)}</div>
        <div class="field"><label>升級訊息（{user} {username} {level}）</label>
          <input name="levelup_message" value="${UI.esc(c.levelup_message)}">
          ${H.emojiInsert('levelup_message')}</div>
        <div class="field">${H.toggle('remove_prev', c.remove_prev, '升到更高等級時移除較低的等級身分組')}</div>
        <div class="field"><label>等級卡背景圖（/等級 卡片背景，可空＝預設深色）</label>${H.uploadField('card_bg', c.card_bg, { label: '背景圖' })}
          ${H.cropButton('card_bg', 900 / 260, '裁切背景範圍（選要露出哪一塊）')}</div>
        <button class="btn" id="save">儲存設定</button>
      </div>

      <div class="card" style="max-width:700px">
        <div class="toolbar"><h3 style="margin:0">等級身分組</h3><div class="spacer"></div>
          <button class="btn small" id="addlr">＋ 新增</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>達到等級</th><th>獲得身分組</th><th></th></tr></thead>
          <tbody>${d.level_roles.length ? d.level_roles.map(r => `
            <tr><td>等級 ${r.level}</td><td>${H.roleName(r.role_id)}</td>
              <td><button class="btn tiny danger" data-del="${r.level}">刪除</button></td></tr>`).join('')
            : '<tr><td colspan="3" class="empty">尚未設定，玩家升級只會收到升級訊息</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>排行榜（前 ${board.length}）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>#</th><th>玩家</th><th>等級</th><th>XP</th><th>發言數</th><th></th></tr></thead>
          <tbody>${board.length ? board.map((r, n) => `
            <tr><td>${n + 1}</td><td class="wrap">${UI.esc(r.username || '—')}<br><code>${r.user_id}</code></td>
              <td>${r.level}</td><td>${r.xp}</td><td>${r.msg_count}</td>
              <td><button class="btn tiny secondary" data-adj="${r.user_id}" data-xp="${r.xp}">調整</button>
                  <button class="btn tiny danger" data-reset="${r.user_id}">重置</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">還沒有人獲得經驗值</td></tr>'}
          </tbody></table></div>
      </div>`;

    const wrap = el.querySelector('#wrap');
    H.bindUploads(wrap);
    H.bindCropButtons(wrap);
    H.bindMentions(wrap);
    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const b = H.collect(wrap);
        b.ignore_channels = multiVal(wrap, 'ignore_channels');
        await PUT('/xp-config', b); UI.ok('已儲存');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    el.querySelector('#addlr').onclick = () => UI.modal({
      title: '新增等級身分組', bodyHTML: `
        <div class="field"><label>達到等級</label><input name="level" type="number" min="1" value="5"></div>
        <div class="field"><label>獲得身分組</label>${H.roleSelect('role_id', '')}</div>`,
      onOk: async (back) => { await POST('/level-roles', H.collect(back)); UI.ok('已新增'); App.go('levels'); }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      await DEL('/level-roles/' + b.dataset.del); UI.ok('已刪除'); App.go('levels'); });
    el.querySelectorAll('[data-adj]').forEach(b => b.onclick = () => UI.modal({
      title: '調整經驗值', bodyHTML: `<div class="field"><label>新的 XP 總值</label>
        <input name="xp" type="number" min="0" value="${b.dataset.xp}"></div>`,
      onOk: async (back) => { await PUT('/xp/' + b.dataset.adj, H.collect(back)); UI.ok('已調整'); App.go('levels'); }
    }));
    el.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('重置此玩家的經驗值？')) return;
      await DEL('/xp/' + b.dataset.reset); UI.ok('已重置'); App.go('levels'); });
  }
});
