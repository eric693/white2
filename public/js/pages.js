// ===== 總覽 =====
App.page('dashboard', {
  title: '總覽', sub: '機器人狀態與快速入口', module: 'dashboard',
  async render(el) {
    const st = await GET('/discord/status').catch(() => ({ online: false }));
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="num">${st.online ? '線上' : '離線'}</div><div class="label">機器人狀態</div></div>
        <div class="stat"><div class="num">${UI.esc(st.guild || '—')}</div><div class="label">服務伺服器</div></div>
        <div class="stat"><div class="num">${st.members || 0}</div><div class="label">成員數</div></div>
      </div>
      <div class="card">
        <h3>快速入口</h3>
        <div class="toolbar">
          ${['keywords', 'welcome', 'birthday', 'announcements', 'polls', 'giveaways', 'wheels', 'reminders']
            .filter(k => App.can(k)).map(k => `<a class="btn secondary" href="#${k}">${UI.esc(App.pages[k].title)}</a>`).join('')}
        </div>
      </div>
      ${st.online ? '' : '<div class="card"><span class="tag danger">機器人離線</span> 請確認 .env 的 DISCORD_TOKEN 已填寫並重啟服務。</div>'}`;
  }
});

// ===== 關鍵字自動回覆 =====
App.page('keywords', {
  title: '關鍵字自動回覆', sub: '一組可綁多關鍵字，限定頻道、冷卻、Embed/按鈕、觸發紀錄', module: 'keywords',
  async render(el) {
    await H.loadMeta();
    const rows = await GET('/keywords');
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增關鍵字</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>關鍵字</th><th>比對</th><th>回覆內容</th><th>限定頻道</th><th>冷卻</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td class="wrap"><strong>${UI.esc(r.keyword.replace(/\n/g, '、'))}</strong></td>
            <td>${H.matchLabel(r.match_type)}</td>
            <td class="wrap">${UI.esc((r.reply_text || '').slice(0, 30))}${r.image_url ? ' <span class="tag">圖</span>' : ''}${(r.buttons && r.buttons !== '[]') ? ' <span class="tag">按鈕</span>' : ''}</td>
            <td>${r.channels ? r.channels.split(',').length + ' 個' : '全部'}</td>
            <td>${r.cooldown ? r.cooldown + '秒' : '—'}</td>
            <td>${H.enabledTag(r.enabled)}</td>
            <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                <button class="btn tiny secondary" data-logs="${r.id}">紀錄</button>
                <button class="btn tiny danger" data-del="${r.id}">刪除</button></td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty">尚無關鍵字</td></tr>'}
        </tbody></table></div>`;

    const form = (r = {}) => `
      <div class="field"><label>關鍵字（多個請換行或逗號分隔，符合任一即觸發）</label>
        <textarea name="keyword" placeholder="你好&#10;哈囉&#10;hi">${UI.esc(r.keyword || '')}</textarea></div>
      <div class="field"><label>比對方式</label>${H.matchSelect('match_type', r.match_type || 'contains')}</div>
      <div class="field"><label>回覆文字</label><textarea name="reply_text">${UI.esc(r.reply_text || '')}</textarea>
        ${H.emojiInsert('reply_text')}</div>
      <div class="field"><label>圖片</label>${H.uploadField('image_url', r.image_url || '', { label: '圖片' })}</div>
      <div class="field"><label>連結按鈕（圖標＋文字，可多個）</label>${H.buttonsEditor('buttons', r.buttons)}</div>
      <div class="field"><label>限定觸發頻道（可空＝全伺服器）</label>${H.chanSelect('channels', (r.channels || '').split(',')[0] || '', { allowEmpty: true })}</div>
      <div class="field"><label>指定回覆到頻道（可空＝回原頻道）</label>${H.chanSelect('reply_channel', r.reply_channel || '')}</div>
      <div class="form-row">
        <div class="field"><label>冷卻秒數（0＝不限）</label><input name="cooldown" type="number" value="${r.cooldown || 0}"></div>
        <div class="field">${H.toggle('use_embed', r.use_embed ?? 1, '以 Embed 樣式回覆')}</div>
      </div>
      <div class="field"><label>命中後自動給發言者身分組（可多選，不選＝不給）</label>
        ${multiBox('give_roles', H.roles || [], r.give_roles, x => '@ ' + x.name)}
        <div class="hint">機器人需有「管理身分組」權限，且位階要高於這些身分組。已經有該身分組的人不會重複給。</div></div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用此關鍵字')}</div>`;

    const openModal = (r) => {
      const m = UI.modal({
        title: r ? '編輯關鍵字' : '新增關鍵字', bodyHTML: form(r || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.keyword) { UI.err('請填寫關鍵字'); return false; }
          b.buttons = H.buttonsValue(back, 'buttons');
          b.give_roles = multiVal(back, 'give_roles');
          if (r) await PUT('/keywords/' + r.id, b); else await POST('/keywords', b);
          UI.ok('已儲存'); App.go('keywords');
        }
      });
      H.bindUploads(m.back);
      H.bindButtons(m.back);
      H.bindMentions(m.back);
    };

    el.querySelector('#add').onclick = () => openModal(null);
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openModal(rows.find(r => r.id == b.dataset.edit)));
    el.querySelectorAll('[data-logs]').forEach(b => b.onclick = async () => {
      const logs = await GET('/keywords/' + b.dataset.logs + '/logs');
      UI.modal({ title: '觸發紀錄', okText: '關閉', onOk: () => {}, bodyHTML: `
        <div class="table-wrap" style="max-height:360px;overflow:auto"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>命中</th><th>訊息</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `<tr><td>${UI.esc(l.created_at)}</td><td>${UI.esc(l.username)}</td>
            <td>${UI.esc(l.matched)}</td><td class="wrap">${UI.esc(l.message)}</td></tr>`).join('')
            : '<tr><td colspan="4" class="empty">尚無紀錄</td></tr>'}</tbody></table></div>` });
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('確定刪除此關鍵字？')) return;
      await DEL('/keywords/' + b.dataset.del); UI.ok('已刪除'); App.go('keywords');
    });
  }
});

// ===== 關鍵字標記管理員 =====
App.page('mentions', {
  title: '關鍵字標記管理員', sub: '偵測帳務、退款、合作、會員等關鍵字自動標記對應人員', module: 'mentions',
  async render(el) {
    await H.loadMeta();
    const rows = await GET('/mentions');
    const nameOf = r => String(r.mention_ids || '').split(',').filter(Boolean)
      .map(id => r.mention_type === 'role' ? H.roleName(id) : `<@${id}>`).join('、');
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增標記規則</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>關鍵字</th><th>比對</th><th>標記對象</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr><td><strong>${UI.esc(r.keyword)}</strong></td><td>${H.matchLabel(r.match_type)}</td>
            <td class="wrap">${r.mention_type === 'role' ? nameOf(r) : UI.esc(r.mention_ids)}</td>
            <td>${H.enabledTag(r.enabled)}</td>
            <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="5" class="empty">尚無規則</td></tr>'}
        </tbody></table></div>`;

    const form = (r = {}) => `
      <div class="field"><label>關鍵字</label><input name="keyword" value="${UI.esc(r.keyword || '')}" placeholder="例：退款"></div>
      <div class="field"><label>比對方式</label>${H.matchSelect('match_type', r.match_type)}</div>
      <div class="field"><label>標記類型</label>
        <select name="mention_type" id="mtype">
          <option value="user" ${r.mention_type !== 'role' ? 'selected' : ''}>標記使用者</option>
          <option value="role" ${r.mention_type === 'role' ? 'selected' : ''}>標記身分組</option>
        </select></div>
      <div class="field"><label>對象 ID（多個以逗號分隔）</label>
        <input name="mention_ids" value="${UI.esc(r.mention_ids || '')}" placeholder="使用者ID 或 身分組ID">
        <div class="hint">身分組可從下方參考清單複製 ID。使用者請開開發者模式右鍵複製 ID。</div>
        <div class="hint">身分組：${(H.roles || []).slice(0, 20).map(x => `${UI.esc(x.name)}=<code>${x.id}</code>`).join('　')}</div></div>
      <div class="field"><label>附帶說明文字</label><input name="note" value="${UI.esc(r.note || '')}" placeholder="例：有退款問題，請協助處理"></div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用')}</div>`;

    const openModal = (r) => UI.modal({
      title: r ? '編輯標記規則' : '新增標記規則', bodyHTML: form(r || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.keyword) { UI.err('請填寫關鍵字'); return false; }
        if (r) await PUT('/mentions/' + r.id, b); else await POST('/mentions', b);
        UI.ok('已儲存'); App.go('mentions');
      }
    });
    el.querySelector('#add').onclick = () => openModal(null);
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openModal(rows.find(r => r.id == b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('確定刪除？')) return;
      await DEL('/mentions/' + b.dataset.del); UI.ok('已刪除'); App.go('mentions');
    });
  }
});

// ===== 加入 / 退出通知 =====
App.page('welcome', {
  title: '加入/退出通知', sub: '新成員歡迎訊息與離開通知', module: 'welcome',
  async render(el) {
    await H.loadMeta();
    const c = await GET('/welcome');
    el.innerHTML = `
      <div class="card" style="max-width:640px" id="wrap">
        <h3>加入通知</h3>
        <div class="field">${H.toggle('join_enabled', c.join_enabled, '啟用加入歡迎訊息')}</div>
        <div class="field"><label>發送頻道</label>${H.chanSelect('join_channel', c.join_channel)}</div>
        <div class="field"><label>歡迎訊息</label><textarea name="join_message" rows="6">${UI.esc(c.join_message)}</textarea>
          ${H.mentionPicker('join_message')}
          <div class="hint">可用變數：<code>{user}</code> 標記本人、<code>{name}</code> <b>暱稱（帳號名）</b>、<code>{nickname}</code> 伺服器暱稱、<code>{username}</code> 帳號名、<code>{id}</code> 使用者 ID、<code>{server}</code> 伺服器名、<code>{count}</code> 成員數。。
            用上方下拉可插入頻道連結與身分組標記。</div></div>
        <div class="field"><label>標題（可空）</label><input name="join_title" value="${UI.esc(c.join_title || '')}">
          ${H.emojiInsert('join_title')}</div>
        <div class="field"><label>橫幅／大圖</label>${H.uploadField('join_image', c.join_image, { label: '圖片' })}</div>
        <div class="field"><label>縮圖（留空則不顯示）</label>${H.uploadField('join_thumb', c.join_thumb || '', { label: '縮圖' })}</div>
        <div class="field"><label>連結按鈕（圖標＋文字，可多個）</label>${H.buttonsEditor('join_buttons', c.join_buttons)}</div>
        <div class="field"><label>伺服器貼圖（最多 3 張，可不選）</label>${H.stickerField('join_stickers', c.join_stickers)}</div>
        <div class="field">${H.toggle('join_use_embed', c.join_use_embed ?? 1, '以 Embed 樣式發送（取消則發純文字，左邊那條顏色框會消失）')}</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>入群自動給身分組</h3>
        <div class="field"><label>新成員一進來就自動獲得（可多選，不選＝不給）</label>
          ${multiBox('join_roles', H.roles || [], c.join_roles, r => '@ ' + r.name)}
          <div class="hint">機器人需要有「管理身分組」權限，而且機器人自己的身分組要排在這些身分組<b>上面</b>，否則 Discord 會擋下來。
            給失敗時會記在系統錯誤紀錄裡。</div></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>歡迎卡圖</h3>
        <div class="field">${H.toggle('card_enabled', c.card_enabled, '產生歡迎卡圖（背景圖＋玩家頭像＋文字，隨歡迎訊息一起發送）')}</div>
        <div class="field"><label>卡圖背景（建議 1000×400，留空用漸層底）</label>${H.uploadField('card_bg', c.card_bg || '', { label: '背景圖' })}
          ${H.cropButton('card_bg', 2.5, '裁切背景範圍（選要露出哪一塊）')}</div>
        <div class="field"><label>卡圖主標題</label><input name="card_title" value="${UI.esc(c.card_title || '')}">
          <div class="hint">可用 <code>{name}</code>（暱稱＋帳號名，最好認）、<code>{nickname}</code>、<code>{username}</code>、<code>{id}</code>、<code>{server}</code>、<code>{count}</code></div></div>
        <div class="field"><label>卡圖副標題</label><input name="card_sub" value="${UI.esc(c.card_sub || '')}">
          <div class="hint"><code>{count}</code> 會帶入目前成員數，做成「Member #338」的效果</div></div>
        <div class="field"><label>背景暗化程度（0～0.9，讓文字看得清楚）</label>
          <input name="card_overlay" type="number" step="0.05" min="0" max="0.9" value="${c.card_overlay || '0.35'}"></div>
        <button class="btn secondary" id="cardpv" type="button">預覽卡圖</button>
        <div id="cardbox" style="margin-top:10px"></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>離開通知</h3>
        <div class="field">${H.toggle('leave_enabled', c.leave_enabled, '啟用離開通知')}</div>
        <div class="field"><label>通知頻道</label>${H.chanSelect('leave_channel', c.leave_channel)}</div>
        <div class="field"><label>離開訊息</label><textarea name="leave_message">${UI.esc(c.leave_message)}</textarea>
          ${H.mentionPicker('leave_message')}
          <div class="hint">可用 <code>{name}</code>（暱稱＋帳號名，最好認）、<code>{nickname}</code>、<code>{username}</code>、<code>{id}</code>、<code>{count}</code>（目前成員數）；用上方下拉可插入頻道連結與身分組標記。</div></div>
        <div class="field"><label>伺服器貼圖（最多 3 張，可不選）</label>${H.stickerField('leave_stickers', c.leave_stickers)}</div>
        <div class="field">${H.toggle('leave_use_embed', c.leave_use_embed ?? 1, '以 Embed 樣式發送（取消則發純文字，左邊那條顏色框會消失）')}</div>
        <div class="field">${H.toggle('leave_card_enabled', c.leave_card_enabled, '產生離群卡圖（背景＋玩家頭像＋文字）')}</div>
        <div class="field"><label>離群卡圖背景（留空用漸層底）</label>${H.uploadField('leave_card_bg', c.leave_card_bg || '', { label: '背景圖' })}
          ${H.cropButton('leave_card_bg', 2.5, '裁切背景範圍（選要露出哪一塊）')}</div>
        <div class="form-row">
          <div class="field"><label>卡圖主標題</label><input name="leave_card_title" value="${UI.esc(c.leave_card_title || '')}"></div>
          <div class="field"><label>卡圖副標題</label><input name="leave_card_sub" value="${UI.esc(c.leave_card_sub || '')}"></div>
        </div>
        <button class="btn secondary" id="leavecardpv" type="button">預覽離群卡圖</button>
        <div id="leavecardbox" style="margin-top:10px"></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>管理員通知</h3>
        <div class="field"><label>管理頻道（入群/離群明細通知）</label>${H.chanSelect('admin_channel', c.admin_channel)}</div>
        <div class="field">${H.toggle('admin_join', c.admin_join, '有人加入時通知管理員（含 ID、加入時間、帳號建立日、加入次數）')}</div>
        <div class="field">${H.toggle('admin_leave', c.admin_leave, '有人離開時通知管理員（含停留天數、離開前身分組）')}</div>
        <button class="btn" id="save">儲存</button>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">加入 / 離開紀錄</h3><div class="spacer"></div>
          <input id="q" placeholder="搜尋名稱或 ID" style="max-width:200px"></div>
        <div id="evbox"></div>
      </div>`;

    const loadEvents = async (q = '') => {
      const rows = await GET('/member-events' + (q ? '?q=' + encodeURIComponent(q) : ''));
      el.querySelector('#evbox').innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>時間</th><th>玩家</th><th>事件</th><th>停留</th><th>次數</th><th>離開前身分組</th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr><td>${UI.esc(r.created_at)}</td>
            <td class="wrap">${UI.esc(r.username || '—')}<br><code>${r.user_id}</code></td>
            <td>${r.event === 'join' ? '<span class="tag ok">加入</span>' : '<span class="tag">離開</span>'}</td>
            <td>${r.event === 'leave' ? r.stay_days + ' 天' : '—'}</td>
            <td>${r.join_count > 1 ? `第 ${r.join_count} 次` : '第 1 次'}</td>
            <td class="wrap">${UI.esc(r.roles || '—')}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">尚無紀錄</td></tr>'}
        </tbody></table></div>`;
    };
    await loadEvents();
    let timer; el.querySelector('#q').oninput = (e) => {
      clearTimeout(timer); timer = setTimeout(() => loadEvents(e.target.value.trim()), 300);
    };
    const wrap = el.querySelector('#wrap');
    H.bindUploads(wrap);
    H.bindButtons(wrap);
    H.bindMentions(wrap);
    H.bindCropButtons(wrap);
    H.bindStickerPickers(wrap);

    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const b = H.collect(wrap);
        b.join_buttons = H.buttonsValue(wrap, 'join_buttons');
        b.join_roles = multiVal(wrap, 'join_roles');
        b.join_stickers = H.stickerValue(wrap, 'join_stickers');
        b.leave_stickers = H.stickerValue(wrap, 'leave_stickers');
        await PUT('/welcome', b);
        UI.ok('已儲存');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    // 卡圖預覽（用目前表單上的設定，不必先儲存）
    const g = (n) => encodeURIComponent(wrap.querySelector(`[name="${n}"]`).value);
    el.querySelector('#cardpv').onclick = () => {
      const url = `/api/welcome-card-preview?bg=${g('card_bg')}&title=${g('card_title')}`
        + `&sub=${g('card_sub')}&overlay=${g('card_overlay')}&_=${Date.now()}`;
      el.querySelector('#cardbox').innerHTML =
        `<img src="${url}" style="max-width:100%;border-radius:8px;border:1px solid var(--border)">`;
    };
    el.querySelector('#leavecardpv').onclick = () => {
      const url = `/api/welcome-card-preview?bg=${g('leave_card_bg')}&title=${g('leave_card_title')}`
        + `&sub=${g('leave_card_sub')}&overlay=${g('card_overlay')}&_=${Date.now()}`;
      el.querySelector('#leavecardbox').innerHTML =
        `<img src="${url}" style="max-width:100%;border-radius:8px;border:1px solid var(--border)">`;
    };
  }
});

// ===== 外觀自訂 =====
App.page('appearance', {
  title: '外觀自訂', sub: '機器人名稱、頭像、後台品牌與管理員通知頻道', module: 'appearance',
  async render(el) {
    await H.loadMeta();
    const [a, s] = [await GET('/appearance'), await GET('/settings')];
    el.innerHTML = `
      <div class="card" style="max-width:560px" id="wrap">
        <div class="field"><label>機器人顯示名稱</label><input name="bot_name" value="${UI.esc(a.bot_name)}">
          <div class="hint">Discord 限制每小時最多變更 2 次。</div></div>
        <div class="field"><label>機器人頭像</label>${H.uploadField('bot_avatar', a.bot_avatar, { label: '頭像' })}
          ${H.cropButton('bot_avatar', 1, '裁切頭像（選要露出的方形範圍）')}</div>
        <div class="form-row">
          <div class="field"><label>上線狀態</label>
            <select name="bot_status">
              ${[['online', '線上'], ['idle', '閒置'], ['dnd', '請勿打擾'], ['invisible', '隱形']].map(([v, t]) =>
                `<option value="${v}" ${(a.bot_status || 'online') === v ? 'selected' : ''}>${t}</option>`).join('')}
            </select></div>
          <div class="field"><label>活動類型</label>
            <select name="bot_activity_type">
              ${[['Playing', '正在玩'], ['Listening', '正在聽'], ['Watching', '正在看'], ['Competing', '正在參加']].map(([v, t]) =>
                `<option value="${v}" ${(a.bot_activity_type || 'Playing') === v ? 'selected' : ''}>${t}</option>`).join('')}
            </select></div>
        </div>
        <div class="field"><label>活動狀態文字</label><input name="bot_activity_text" value="${UI.esc(a.bot_activity_text || '')}" placeholder="例如：陪你聊天中">
          <div class="hint">會顯示成「正在玩 陪你聊天中」。留空則不顯示活動。</div></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>Embed 樣式</h3>
        <div class="field"><label>主題顏色（Hex）</label><input name="embed_color" value="${UI.esc(a.embed_color || '')}" placeholder="5865f2">
          <div class="hint">套用到公告、關鍵字回覆、音樂面板等所有 Embed。留空用預設藍紫色。</div></div>
        <div class="field"><label>Embed 頁尾文字</label><input name="embed_footer" value="${UI.esc(a.embed_footer || '')}"></div>
        <div class="field"><label>Embed 預設縮圖</label>${H.uploadField('embed_thumb', a.embed_thumb || '', { label: '縮圖' })}</div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <div class="field"><label>邀請制：未開通伺服器的聯繫訊息</label>
          <textarea name="invite_contact" rows="3" placeholder="本機器人採邀請制，需先由作者開通後才能使用。請聯繫作者：Discord @你的帳號">${UI.esc(a.invite_contact || '')}</textarea>
          <div class="hint">有人把機器人邀到未開通的伺服器時，機器人會在對方伺服器留下這則訊息再自動離開。留空用預設文字。</div></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <div class="field"><label>後台品牌標題</label><input name="brand_title" value="${UI.esc(a.brand_title)}" placeholder="White2 後台"></div>
        <div class="field"><label>後台品牌副標</label><input name="brand_sub" value="${UI.esc(a.brand_sub)}" placeholder="Discord 機器人管理"></div>
        <button class="btn" id="save">儲存外觀</button>
      </div>
      <div class="card" style="max-width:560px" id="gwrap">
        <h3>管理員通知頻道</h3>
        <div class="field"><label>提醒失敗、警告、入群/離群等通知都會發到這裡</label>${H.chanSelect('admin_channel', s.admin_channel)}</div>
        <button class="btn" id="gsave">儲存</button>
      </div>`;
    H.bindUploads(el);
    H.bindCropButtons(el);
    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try { await PUT('/appearance', H.collect(el.querySelector('#wrap'))); UI.ok('已儲存，重新整理後生效'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };
    el.querySelector('#gsave').onclick = async (e) => {
      e.target.disabled = true;
      try { await PUT('/settings', H.collect(el.querySelector('#gwrap'))); UI.ok('已儲存'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };
  }
});
