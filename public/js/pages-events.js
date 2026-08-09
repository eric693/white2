// ===== 生日驗證與慶生 =====
App.page('birthday', {
  title: '生日驗證與慶生', sub: '加入年齡驗證、生日名單與慶生設定', module: 'birthday',
  async render(el) {
    await H.loadMeta();
    const [vc, bc, list] = await Promise.all([GET('/verify-config'), GET('/birthday-config'), GET('/birthdays')]);
    el.innerHTML = `
      <div class="card" style="max-width:660px" id="vwrap">
        <h3>加入年齡驗證</h3>
        <div class="field">${H.toggle('enabled', vc.enabled, '啟用生日驗證（新成員須填生日）')}</div>
        <div class="form-row">
          <div class="field"><label>最低年齡</label><input name="min_age" type="number" value="${vc.min_age}"></div>
          <div class="field"><label>${H.toggle('kick_underage', vc.kick_underage, '未滿年齡自動踢除')}</label></div>
        </div>
        <div class="field"><label>新成員入群時怎麼提醒</label>
          <select name="join_prompt_mode">
            <option value="dm" ${(vc.join_prompt_mode||'dm')==='dm'?'selected':''}>私訊本人（推薦，頻道不會被洗版）</option>
            <option value="panel" ${vc.join_prompt_mode==='panel'?'selected':''}>不主動發，只放常駐面板讓人自己點</option>
            <option value="channel" ${vc.join_prompt_mode==='channel'?'selected':''}>在驗證頻道公開發並 @ 本人</option>
          </select>
          <div class="hint">Discord 無法在頻道發「只有某人看得到」的訊息，所以要私密就得用私訊。
            私訊被對方關閉時會自動退回頻道發送。</div></div>
        <div class="field"><label>退回頻道發送時，幾秒後自動刪除（0＝不刪）</label>
          <input name="prompt_delete_sec" type="number" min="0" value="${vc.prompt_delete_sec ?? 120}"></div>
        <div class="field"><label>驗證頻道（放按鈕面板的地方）</label>${H.chanSelect('verify_channel', vc.verify_channel)}</div>
        <div class="field"><label>通過後給予的身分組</label>${H.roleSelect('pass_role', vc.pass_role)}</div>
        <div class="field"><label>驗證提示文字</label><textarea name="prompt_text">${UI.esc(vc.prompt_text)}</textarea>
          ${H.emojiInsert('prompt_text')}</div>
        <button class="btn" id="vsave">儲存驗證設定</button>
        <button class="btn secondary" id="vpanel">在驗證頻道發布按鈕面板</button>
      </div>

      <div class="card" style="max-width:660px" id="bwrap">
        <h3>生日慶生</h3>
        <div class="field">${H.toggle('enabled', bc.enabled, '啟用每日生日祝福（每天 09:00 檢查）')}</div>
        <div class="field"><label>慶生頻道</label>${H.chanSelect('channel', bc.channel)}</div>
        <div class="field"><label>祝福訊息</label><textarea name="message">${UI.esc(bc.message)}</textarea>
          ${H.emojiInsert('message')}
          <div class="hint">可用 <code>{user}</code> 標記壽星、<code>{username}</code> 名稱</div></div>
        <div class="field"><label>當天暫時給的身分組（可空）</label>${H.roleSelect('birthday_role', bc.birthday_role)}</div>
        <div class="field"><label>附帶獎勵/優惠文字（可空）</label><input name="reward_text" value="${UI.esc(bc.reward_text)}"></div>
        <div class="form-row">
          <div class="field"><label>祝福發送時間</label><input name="send_time" type="time" value="${UI.esc(bc.send_time || '09:00')}"></div>
          <div class="field"><label>${H.toggle('mention_star', bc.mention_star ?? 1, '標記壽星')}</label></div>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>生日資料填寫提醒</h3>
        <div class="field">${H.toggle('remind_enabled', bc.remind_enabled, '持續提醒尚未填寫生日的成員（填完自動停止提醒）')}</div>
        <div class="form-row">
          <div class="field"><label>提醒方式</label>
            <select name="remind_mode">
              <option value="channel" ${bc.remind_mode === 'channel' ? 'selected' : ''}>頻道公告</option>
              <option value="dm" ${bc.remind_mode === 'dm' ? 'selected' : ''}>私人訊息</option>
              <option value="both" ${bc.remind_mode === 'both' ? 'selected' : ''}>兩者都要</option>
            </select></div>
          <div class="field"><label>每隔幾天提醒一次</label><input name="remind_days" type="number" min="1" value="${bc.remind_days || 3}"></div>
        </div>
        <div class="field"><label>提醒頻道</label>${H.chanSelect('remind_channel', bc.remind_channel)}</div>
        <div class="field"><label>只提醒此身分組（可空＝全部成員）</label>${H.roleSelect('remind_role', bc.remind_role)}</div>
        <div class="field"><label>提醒文字</label><textarea name="remind_text">${UI.esc(bc.remind_text || '')}</textarea>
          ${H.emojiInsert('remind_text')}</div>
        <button class="btn" id="bsave">儲存慶生設定</button>
        <button class="btn secondary" id="bpanel">在提醒頻道發布填寫面板</button>
        <button class="btn secondary" id="blogs">生日紀錄</button>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">生日名單（${list.length}）</h3><div class="spacer"></div>
          <button class="btn small" id="addb">＋ 手動新增</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>使用者</th><th>ID</th><th>生日</th><th>驗證時間</th><th></th></tr></thead>
          <tbody>${list.length ? list.map(b => `
            <tr><td>${UI.esc(b.username || '—')}</td><td><code>${b.user_id}</code></td>
              <td>${b.birth_y}/${String(b.birth_m).padStart(2, '0')}/${String(b.birth_d).padStart(2, '0')}</td>
              <td>${UI.esc(b.verified_at || '')}</td>
              <td><button class="btn tiny danger" data-del="${b.user_id}">刪除</button></td></tr>`).join('')
            : '<tr><td colspan="5" class="empty">尚無資料</td></tr>'}
          </tbody></table></div>
      </div>`;
    H.bindMentions(el);

    el.querySelector('#vsave').onclick = async (e) => { e.target.disabled = true;
      try { await PUT('/verify-config', H.collect(el.querySelector('#vwrap'))); UI.ok('已儲存'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; } };
    el.querySelector('#vpanel').onclick = async () => {
      try { await POST('/verify-panel', {}); UI.ok('已發布驗證面板'); } catch (e) { UI.err(e.message); } };
    el.querySelector('#bsave').onclick = async (e) => { e.target.disabled = true;
      try { await PUT('/birthday-config', H.collect(el.querySelector('#bwrap'))); UI.ok('已儲存'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; } };

    el.querySelector('#bpanel').onclick = async () => {
      const ch = el.querySelector('[name="remind_channel"]').value;
      if (!ch) return UI.err('請先選擇提醒頻道並儲存');
      try { await POST('/birthday-panel', { channel_id: ch }); UI.ok('已發布填寫面板'); } catch (e) { UI.err(e.message); }
    };

    el.querySelector('#blogs').onclick = async () => {
      const d = await GET('/birthday-logs');
      UI.modal({
        title: '生日紀錄', okText: '關閉', onOk: () => {},
        bodyHTML: `<h4>資料異動紀錄</h4><div class="table-wrap"><table class="list">
            <thead><tr><th>時間</th><th>玩家</th><th>動作</th><th>原值 → 新值</th><th>操作者</th></tr></thead>
            <tbody>${d.history.length ? d.history.map(h => `
              <tr><td>${UI.esc(h.created_at)}</td>
                <td class="wrap">${UI.esc(h.username || '—')}<br><code>${h.user_id}</code></td>
                <td>${({ set: '填寫', update: '修改', delete: '刪除' })[h.action] || h.action}</td>
                <td>${UI.esc(h.old_value || '—')} → ${UI.esc(h.new_value || '—')}</td>
                <td>${UI.esc(h.operator || '玩家自填')}</td></tr>`).join('')
              : '<tr><td colspan="5" class="empty">尚無紀錄</td></tr>'}
            </tbody></table></div>
          <h4 style="margin-top:14px">祝福發送紀錄</h4><div class="table-wrap"><table class="list">
            <thead><tr><th>年度</th><th>玩家</th><th>發送時間</th></tr></thead>
            <tbody>${d.sends.length ? d.sends.map(s => `
              <tr><td>${s.year}</td><td class="wrap">${UI.esc(s.username || '—')}<br><code>${s.user_id}</code></td>
                <td>${UI.esc(s.sent_at)}</td></tr>`).join('')
              : '<tr><td colspan="3" class="empty">尚無紀錄</td></tr>'}
            </tbody></table></div>`
      });
    };

    el.querySelector('#addb').onclick = () => UI.modal({
      title: '手動新增生日', bodyHTML: `
        <div class="field"><label>使用者 ID</label><input name="user_id"></div>
        <div class="field"><label>顯示名稱</label><input name="username"></div>
        <div class="form-row">
          <div class="field"><label>年</label><input name="birth_y" type="number" placeholder="2000"></div>
          <div class="field"><label>月</label><input name="birth_m" type="number"></div>
          <div class="field"><label>日</label><input name="birth_d" type="number"></div>
        </div>`,
      onOk: async (back) => { await POST('/birthdays', H.collect(back)); UI.ok('已新增'); App.go('birthday'); }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此生日資料？')) return;
      await DEL('/birthdays/' + b.dataset.del); UI.ok('已刪除'); App.go('birthday');
    });
  }
});

// 表情身分組編輯器（emoji + 身分組下拉，多列，附共用 emoji 快選）
function rrEditor(name, json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  const roleOpts = (sel) => (H.roles || []).map(r =>
    `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>@ ${UI.esc(r.name)}</option>`).join('');
  const row = (m = {}) => `
    <div class="rr-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <input data-rremoji placeholder="表情" value="${UI.esc(m.emoji || '')}" style="width:64px;text-align:center">
      <label class="btn tiny secondary" style="margin:0;padding:2px 6px" title="上傳圖片當表情">圖<input type="file" accept="image/*" style="display:none" data-rriconup></label>
      <select data-rrrole style="flex:1;min-width:130px"><option value="">— 選擇身分組 —</option>${roleOpts(m.role_id)}</select>
      <button type="button" class="btn tiny danger" data-rrrm>刪除</button>
    </div>`;
  return `<div data-rr="${name}">
    <div data-rrlist>${list.map(row).join('')}</div>
    <button type="button" class="btn small secondary" data-rradd>＋ 新增一組</button>
    <div class="hint">點「表情」欄位就會跳出表情選擇器（含伺服器自訂表情，可搜尋），選好再選要給的身分組。玩家按該表情就會自動獲得身分組。</div>
  </div>`;
}
function rrBind(root) {
  root.querySelectorAll('[data-rr]').forEach(box => {
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    const list = box.querySelector('[data-rrlist]');
    const roleOpts = (H.roles || []).map(r => `<option value="${r.id}">@ ${UI.esc(r.name)}</option>`).join('');
    H.initEmojiInputs();
    H.paintEmojiInputs(box);
    let lastEmojiInput = null;
    const addRow = () => {
      const d = document.createElement('div');
      d.innerHTML = `<div class="rr-row" style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
        <input data-rremoji placeholder="表情" style="width:64px;text-align:center">
        <label class="btn tiny secondary" style="margin:0;padding:2px 6px" title="上傳圖片當表情">圖<input type="file" accept="image/*" style="display:none" data-rriconup></label>
        <select data-rrrole style="flex:1;min-width:130px"><option value="">— 選擇身分組 —</option>${roleOpts}</select>
        <button type="button" class="btn tiny danger" data-rrrm>刪除</button></div>`;
      list.appendChild(d.firstElementChild);
      lastEmojiInput = list.lastElementChild.querySelector('[data-rremoji]');
    };
    box.querySelector('[data-rradd]').onclick = () => {
      if (list.children.length >= 20) return UI.err('最多 20 個');
      addRow();
    };
    box.addEventListener('change', async e => {
      if (!e.target.matches('[data-rriconup]')) return;
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 256 * 1024) { UI.err('圖示需小於 256KB'); e.target.value=''; return; }
      const inp = e.target.closest('.rr-row').querySelector('[data-rremoji]');
      inp.value = '上傳中…';
      try { const fd = new FormData(); fd.append('file', f);
        const r = await api('/emoji-upload', { method:'POST', body: fd });
        inp.value = r.markup; H.paintEmojiInput(inp); UI.ok('表情已上傳');
      } catch (err) { UI.err(err.message); inp.value=''; }
      e.target.value='';
    });
    box.addEventListener('click', e => {
      if (e.target.matches('[data-rrrm]')) { e.target.closest('.rr-row').remove(); return; }
      if (e.target.matches('[data-rremoji]')) { lastEmojiInput = e.target; return; }
    });
  });
}
function rrValue(root, name) {
  const box = root.querySelector(`[data-rr="${name}"]`);
  if (!box) return '[]';
  const out = [];
  box.querySelectorAll('.rr-row').forEach(r => {
    const emoji = r.querySelector('[data-rremoji]').value.trim();
    const role = r.querySelector('[data-rrrole]').value;
    if (emoji && role) out.push({ emoji, role_id: role });
  });
  return JSON.stringify(out);
}

// ===== 公告（7.1～7.12）=====
App.page('announcements', {
  title: '公告', sub: '多頻道 / 標記 / 排程 / 循環 / 模板 / 預覽', module: 'announcements',
  async render(el) {
    await H.loadMeta();
    const [rows, tpls] = await Promise.all([GET('/announcements'), GET('/announcement-templates')]);
    const statusTag = s => ({
      sent: '<span class="tag ok">已發送</span>', scheduled: '<span class="tag warn">已排程</span>',
      repeating: '<span class="tag primary">循環中</span>', stopped: '<span class="tag">已停止</span>',
      draft: '<span class="tag">草稿</span>'
    }[s] || s);
    const freqLabel = a => ({ daily: '每日', weekly: '每週', monthly: '每月', custom: `每 ${a.repeat_days} 天` }[a.repeat_freq] || '');
    const chanList = a => {
      const ids = (a.channels || a.channel_id || '').split(',').filter(Boolean);
      return ids.map(H.chanName).join('、') || '—';
    };

    const notes = [...new Set(rows.map(a => (a.note || '').trim()).filter(Boolean))];
    const chips = notes.length ? `<div class="toolbar" id="notefilter" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <span style="color:var(--muted);align-self:center">依備註篩選：</span>
        <button class="btn tiny" data-note="">全部</button>
        ${notes.map(n => `<button class="btn tiny secondary" data-note="${UI.esc(n)}">${UI.esc(n)}</button>`).join('')}
      </div>` : '';
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 建立公告</button>
        <div class="spacer"></div>
        <button class="btn secondary" id="tpls">模板（${tpls.length}）</button>
        <button class="btn secondary" id="logs">發送紀錄</button></div>
      ${chips}
      <div class="table-wrap"><table class="list">
        <thead><tr><th>標題/內容</th><th>頻道</th><th>標記</th><th>狀態</th><th>時間</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(a => `
          <tr data-note="${UI.esc((a.note || '').trim())}"><td class="wrap">${a.note ? `<span class="tag">${UI.esc(a.note)}</span><br>` : ''}<strong>${UI.esc(a.title || '（無標題）')}</strong><br>
              <span style="color:var(--muted)">${UI.esc((a.content || '').slice(0, 40))}</span></td>
            <td class="wrap">${UI.esc(chanList(a))}</td>
            <td>${a.mention_everyone ? '@everyone' : a.mention_here ? '@here' : (a.mention_role_ids ? '身分組' : '—')}</td>
            <td>${statusTag(a.status)}${a.repeat_freq !== 'none' ? `<br><span style="color:var(--muted)">${freqLabel(a)} ${UI.esc(a.repeat_time)}</span>` : ''}</td>
            <td>${UI.esc(a.sent_at || a.scheduled_at || '')}</td>
            <td><button class="btn tiny secondary" data-preview="${a.id}">預覽</button>
                <button class="btn tiny secondary" data-edit="${a.id}">編輯</button>
                <button class="btn tiny" data-send="${a.id}">立即發送</button>
                ${a.status === 'repeating' || a.status === 'scheduled' ? `<button class="btn tiny secondary" data-stop="${a.id}">停止</button>` : ''}
                ${a.status === 'stopped' ? `<button class="btn tiny secondary" data-resume="${a.id}">恢復</button>` : ''}
                <button class="btn tiny danger" data-del="${a.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">尚無公告</td></tr>'}
        </tbody></table></div>`;

    // ---- 表單 ----
    const form = (a = {}) => `
      <div class="field"><label>內部備註（只有後台看得到，玩家不會看到）</label>
        <input name="note" value="${UI.esc(a.note || '')}" placeholder="例如：七月活動第一波"></div>
      <div class="field"><label>標題</label><input name="title" value="${UI.esc(a.title || '')}">
        ${H.emojiInsert('title')}</div>
      <div class="field"><label>內容</label><textarea name="content" rows="4">${UI.esc(a.content || '')}</textarea>
        ${H.mentionPicker('content', { noUser: true })}</div>
      <div class="field"><label>圖片 / GIF（可多張）</label>${H.multiUploadField('images', a.images || (a.image_url ? JSON.stringify([a.image_url]) : '[]'))}</div>
      <div class="field"><label>影片</label>${H.uploadField('video_url', a.video_url, { accept: 'video/*', label: '影片' })}</div>
      <div class="field"><label>伺服器貼圖（最多 3 張，可不選）</label>${H.stickerField('stickers', a.stickers)}
        <div class="hint">貼圖不能和 Embed 放在同一則訊息，若下方開了「以 Embed 樣式發送」，貼圖會緊接著獨立發一則。</div></div>
      <div class="field"><label>連結按鈕（圖標＋文字，最多 25 個）</label>${H.buttonsEditor('buttons', a.buttons)}</div>
      <div class="field">${H.toggle('use_embed', a.use_embed ?? 1, '以 Embed 樣式發送')}</div>
      <div class="field"><label>頁尾文字（Embed 底部小字，可空）</label>
        <input name="footer" value="${UI.esc(a.footer || '')}" placeholder="例如：璃白Yu光 官方公告"></div>
      <div class="field"><label>縮圖（Embed 右上角小圖，可空）</label>${H.uploadField('thumb', a.thumb, { label: '縮圖' })}</div>
      <hr>
      <div class="field"><label>發送頻道（可多選）</label>
        ${multiBox('channels', H.channels || [], a.channels || a.channel_id, c => '# ' + c.name)}</div>
      <div class="field"><label>標記對象</label>
        ${H.toggle('mention_everyone', a.mention_everyone, '標記 @everyone')}
        ${H.toggle('mention_here', a.mention_here, '標記 @here')}</div>
      <div class="field"><label>標記身分組（可多選，套用到所有頻道）</label>
        ${multiBox('mention_role_ids', H.roles || [], a.mention_role_ids, r => '@ ' + r.name)}</div>
      <div class="field"><label>各頻道專屬標記（平台隔離用，可空）</label>
        <div id="cmwrap" data-cm='${UI.esc(a.channel_mentions || '{}')}'></div>
        <div class="hint">勾了多個發送頻道時，可以在這裡指定「某個頻道只 @ 某個身分組」。
          例如 bemi 頻道只 @BeMi、touchie 頻道只 @Touchie，一則公告就能發給三個平台而互不干擾。
          沒設定的頻道會沿用上面的共用標記。</div></div>
      <div class="field"><label>表情身分組（玩家按表情自動取得身分組，取消表情移除）</label>
        ${rrEditor('reaction_roles', a.reaction_roles)}</div>
      <hr>
      <div class="field"><label>發送方式</label>
        <select name="mode" id="mode">
          <option value="now">立即發送</option>
          <option value="schedule" ${a.scheduled_at ? 'selected' : ''}>排程發送</option>
          <option value="draft">先存草稿</option>
        </select></div>
      <div class="field" id="schfield" style="display:${a.scheduled_at ? 'block' : 'none'}">
        <label>排程時間</label><input name="scheduled_at" type="datetime-local" value="${UI.esc(a.scheduled_at || '')}"></div>
      <div class="field"><label>循環公告</label>
        <select name="repeat_freq" id="rfreq">
          <option value="none">不循環</option>
          <option value="daily" ${a.repeat_freq === 'daily' ? 'selected' : ''}>每日</option>
          <option value="weekly" ${a.repeat_freq === 'weekly' ? 'selected' : ''}>每週</option>
          <option value="monthly" ${a.repeat_freq === 'monthly' ? 'selected' : ''}>每月</option>
          <option value="custom" ${a.repeat_freq === 'custom' ? 'selected' : ''}>自訂天數</option>
        </select></div>
      <div id="rbox" style="display:${a.repeat_freq && a.repeat_freq !== 'none' ? 'block' : 'none'}">
        <div class="form-row">
          <div class="field"><label>發送時間</label><input name="repeat_time" type="time" value="${UI.esc(a.repeat_time || '09:00')}"></div>
          <div class="field"><label>每週星期（每週時）</label>
            <select name="repeat_dow">${['日', '一', '二', '三', '四', '五', '六'].map((d, i) =>
              `<option value="${i}" ${(a.repeat_dow ?? 1) === i ? 'selected' : ''}>星期${d}</option>`).join('')}</select></div>
          <div class="field"><label>每月幾號</label><input name="repeat_dom" type="number" min="1" max="31" value="${a.repeat_dom || 1}"></div>
          <div class="field"><label>每 N 天</label><input name="repeat_days" type="number" min="1" value="${a.repeat_days || 1}"></div>
        </div>
        <div class="field"><div class="hint">循環公告會持續發送，直到你按「停止」為止。</div></div>
      </div>`;

    const collect = (back) => {
      const b = H.collect(back);
      b.channels = multiVal(back, 'channels');
      b.mention_role_ids = multiVal(back, 'mention_role_ids');
      b.buttons = H.buttonsValue(back, 'buttons');
      b.reaction_roles = rrValue(back, 'reaction_roles');
      b.images = H.multiUploadValue(back, 'images');
      b.stickers = H.stickerValue(back, 'stickers');
      const cm = {};
      back.querySelectorAll('[data-cmrow]').forEach(row => {
        const rid = row.querySelector('select').value;
        if (rid) cm[row.dataset.cmrow] = rid;
      });
      b.channel_mentions = JSON.stringify(cm);
      return b;
    };
    const wireForm = (back) => {
      H.bindUploads(back);
      H.bindButtons(back);
      H.bindMultiUploads(back);
      H.bindEmojiPickers(back);
      H.bindMentions(back);
      H.bindStickerPickers(back);
      // 各頻道專屬標記：跟著「發送頻道」的勾選即時重畫，只列出真的會發送的頻道
      const cmwrap = back.querySelector('#cmwrap');
      if (cmwrap) {
        let saved = {}; try { saved = JSON.parse(cmwrap.dataset.cm || '{}'); } catch {}
        const drawCM = () => {
          // 先把畫面上已選的記下來，重畫後才不會被清掉
          back.querySelectorAll('[data-cmrow]').forEach(r => {
            const v = r.querySelector('select').value;
            if (v) saved[r.dataset.cmrow] = v; else delete saved[r.dataset.cmrow];
          });
          const ids = multiVal(back, 'channels').split(',').filter(Boolean);
          cmwrap.innerHTML = ids.length ? ids.map(id => `
            <div class="form-row" data-cmrow="${id}" style="align-items:flex-end">
              <div class="field"><label>${UI.esc(H.chanName(id))}</label>
                ${H.roleSelect('__cm_' + id, saved[id] || '', { emptyLabel: '— 用共用標記 —' })}</div>
            </div>`).join('') : '<div class="hint">先在上方勾選發送頻道</div>';
        };
        drawCM();
        const chanBox = back.querySelector('[data-multi="channels"]');
        if (chanBox) chanBox.addEventListener('change', drawCM);
      }
      rrBind(back);
      back.querySelector('#mode').addEventListener('change', e => {
        back.querySelector('#schfield').style.display = e.target.value === 'schedule' ? 'block' : 'none';
      });
      back.querySelector('#rfreq').addEventListener('change', e => {
        back.querySelector('#rbox').style.display = e.target.value === 'none' ? 'none' : 'block';
      });
    };

    // ---- 7.12 預覽 ----
    const previewHTML = (a) => {
      const mentions = [a.mention_everyone ? '@everyone' : '', a.mention_here ? '@here' : '',
        ...(a.mention_role_ids || '').split(',').filter(Boolean).map(H.roleName)].filter(Boolean).join(' ');
      const chans = (a.channels || a.channel_id || '').split(',').filter(Boolean).map(H.chanName).join('、');
      return `
        <div style="background:#313338;color:#dbdee1;padding:14px;border-radius:8px;font-size:14px">
          ${mentions ? `<div style="color:#c9cdfb;background:#3c4270;display:inline-block;padding:1px 4px;border-radius:3px;margin-bottom:8px">${UI.esc(mentions)}</div>` : ''}
          ${a.use_embed ? `
            <div style="border-left:4px solid #5865f2;background:#2b2d31;padding:10px 12px;border-radius:4px;max-width:440px">
              ${a.title ? `<div style="font-weight:700;margin-bottom:6px">${H.renderDiscordText(a.title)}</div>` : ''}
              ${a.content ? `<div style="white-space:pre-wrap">${H.renderDiscordText(a.content)}</div>` : ''}
              ${a.link_url ? `<div style="margin-top:8px"><b>連結</b><br><span style="color:#00a8fc">${UI.esc(a.link_url)}</span></div>` : ''}
              ${(() => { let im=[]; try{im=JSON.parse(a.images||'[]')}catch{} if(!im.length&&a.image_url)im=[a.image_url]; return im.length?`<div style="margin-top:8px;display:grid;grid-template-columns:repeat(2,1fr);gap:4px">${im.slice(0,4).map(u=>`<img src="${UI.esc(u)}" style="width:100%;border-radius:4px">`).join('')}</div>`:''; })()}
            </div>` : `
            <div style="white-space:pre-wrap">${UI.esc([a.title ? '**' + a.title + '**' : '', a.content, a.image_url, a.link_url, a.video_url].filter(Boolean).join('\n'))}</div>`}
          ${a.video_url ? `<div style="margin-top:6px;color:#00a8fc">${UI.esc(a.video_url)}</div>` : ''}
          ${(() => {
            let bs = []; try { bs = JSON.parse(a.buttons || '[]'); } catch {}
            if (!bs.length && a.btn_url) bs = [{ label: a.btn_label, url: a.btn_url }];
            return bs.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${bs.map(b =>
              `<span style="background:#4e5058;padding:6px 14px;border-radius:4px;display:inline-block">${UI.esc(b.emoji || '')} ${UI.esc(b.label || '前往')} ↗</span>`).join('')}</div>` : '';
          })()}
        </div>
        <div class="hint" style="margin-top:10px">將發送至：${UI.esc(chans || '（尚未選擇頻道）')}</div>`;
    };

    // 依內部備註篩選列表
    el.querySelectorAll('#notefilter [data-note]').forEach(b => b.onclick = () => {
      const want = b.dataset.note;
      el.querySelectorAll('#notefilter [data-note]').forEach(x => x.classList.toggle('secondary', x !== b));
      el.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = (!want || tr.dataset.note === want) ? '' : 'none'; });
    });
    el.querySelector('#add').onclick = () => {
      const m = UI.modal({
        title: '建立公告', okText: '送出',
        bodyHTML: form() + (tpls.length ? `<div class="field"><label>套用模板</label>
          <select id="usetpl"><option value="">— 不套用 —</option>
          ${tpls.map(t => `<option value="${t.id}">${UI.esc(t.name)}</option>`).join('')}</select></div>` : '')
          + `<div class="field"><button class="btn secondary small" id="pv" type="button">預覽</button>
             <button class="btn secondary small" id="savetpl" type="button">存成模板</button></div>`,
        onOk: async (back) => {
          const b = collect(back);
          await POST('/announcements', b);
          UI.ok(b.repeat_freq !== 'none' ? '已建立循環公告' : b.mode === 'schedule' ? '已排程' : b.mode === 'draft' ? '已存草稿' : '已發送');
          App.go('announcements');
        }
      });
      wireForm(m.back);
      m.back.querySelector('#pv').onclick = () =>
        UI.modal({ title: '公告預覽', okText: '關閉', onOk: () => {}, bodyHTML: previewHTML(collect(m.back)) });
      m.back.querySelector('#savetpl').onclick = async () => {
        const name = prompt('模板名稱？');
        if (!name) return;
        await POST('/announcement-templates', { name, payload: collect(m.back) });
        UI.ok('模板已儲存');
      };
      const sel = m.back.querySelector('#usetpl');
      if (sel) sel.onchange = (e) => {
        const t = tpls.find(x => x.id == e.target.value);
        if (!t) return;
        const p = JSON.parse(t.payload || '{}');
        Object.entries(p).forEach(([k, v]) => {
          const f = m.back.querySelector(`[name="${k}"]`);
          if (f) { if (f.type === 'checkbox') f.checked = !!v; else f.value = v; }
        });
        H.refreshEditors(m.back);   // 值是程式改的，編輯器要重畫才看得到
        UI.ok('已套用模板');
      };
    };

    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const a = rows.find(x => x.id == b.dataset.edit);
      let refs = []; try { refs = JSON.parse(a.sent_msgs || '[]'); } catch {}
      const canSync = refs.length > 0;
      // 已發送的公告：存檔後同步改掉 Discord 上那則訊息（不會再標記一次 @everyone）
      const syncField = a.status === 'sent' || a.status === 'repeating' ? `
        <hr>
        <div class="field">${H.toggle('sync', canSync ? 1 : 0, '同步修改已發送到 Discord 的那則訊息')}
          <div class="hint">${canSync
            ? `會直接改掉已發出的 ${refs.length} 則訊息內容，<b>不會再次標記 @everyone</b>，不用重發。`
            : '這則公告沒有訊息紀錄（舊版發送的），需要重新發送一次之後才能事後編輯。'}</div></div>` : '';
      const m = UI.modal({
        title: `編輯公告 #${a.id}`,
        bodyHTML: form(a) + syncField + `<div class="field"><button class="btn secondary small" id="pv" type="button">預覽</button></div>`,
        onOk: async (back) => {
          const body = collect(back);
          body.sync = (a.status === 'sent' || a.status === 'repeating') && canSync && !!body.sync;
          const r = await PUT('/announcements/' + a.id, body);
          UI.ok(body.sync ? `已儲存，並更新了 ${r.edited} 則已發送的訊息` : '已儲存');
          App.go('announcements');
        }
      });
      wireForm(m.back);
      m.back.querySelector('#pv').onclick = () =>
        UI.modal({ title: '公告預覽', okText: '關閉', onOk: () => {}, bodyHTML: previewHTML(collect(m.back)) });
    });

    el.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => {
      const a = rows.find(x => x.id == b.dataset.preview);
      UI.modal({ title: '公告預覽', okText: '關閉', onOk: () => {}, bodyHTML: previewHTML(a) });
    });

    el.querySelectorAll('[data-send]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('立即發送此公告？', '發送', 'btn')) return;
      try {
        const r = await POST('/announcements/' + b.dataset.send + '/send');
        UI.ok(`已發送至 ${r.sent} 個頻道` + (r.failed && r.failed.length ? `，${r.failed.length} 個失敗` : ''));
        App.go('announcements');
      } catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => {
      await PUT('/announcements/' + b.dataset.stop + '/stop'); UI.ok('已停止'); App.go('announcements'); });
    el.querySelectorAll('[data-resume]').forEach(b => b.onclick = async () => {
      await PUT('/announcements/' + b.dataset.resume + '/resume'); UI.ok('已恢復'); App.go('announcements'); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此公告？')) return;
      await DEL('/announcements/' + b.dataset.del); UI.ok('已刪除'); App.go('announcements'); });

    el.querySelector('#logs').onclick = async () => {
      const logs = await GET('/announcement-logs');
      UI.modal({
        title: `公告發送紀錄（${logs.length}）`, okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>標題</th><th>頻道</th><th>建立者</th><th>結果</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `
            <tr><td>${UI.esc(l.sent_at)}</td><td class="wrap">${UI.esc(l.title || '（無標題）')}</td>
              <td class="wrap">${UI.esc((l.channels || '').split(',').filter(Boolean).map(H.chanName).join('、') || '—')}</td>
              <td>${UI.esc(l.creator || '—')}</td>
              <td>${l.status === 'ok' ? '<span class="tag ok">成功</span>' : `<span class="tag danger">失敗</span><br><span style="color:var(--muted)">${UI.esc(l.error)}</span>`}</td></tr>`).join('')
            : '<tr><td colspan="5" class="empty">尚無紀錄</td></tr>'}
          </tbody></table></div>`
      });
    };

    el.querySelector('#tpls').onclick = () => UI.modal({
      title: '公告模板', okText: '關閉', onOk: () => {},
      bodyHTML: tpls.length ? `<div class="table-wrap"><table class="list">
        <thead><tr><th>名稱</th><th>建立時間</th><th></th></tr></thead>
        <tbody>${tpls.map(t => `<tr><td>${UI.esc(t.name)}</td><td>${UI.esc(t.created_at)}</td>
          <td><button class="btn tiny danger" data-delt="${t.id}">刪除</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">尚無模板。建立公告時可按「存成模板」。</div>'
    }).back.addEventListener('click', async (ev) => {
      const id = ev.target.dataset.delt;
      if (id) { await DEL('/announcement-templates/' + id); UI.ok('已刪除'); App.go('announcements'); }
    });
  }
});

// ===== 投票 =====
App.page('polls', {
  title: '投票', sub: '單選/複選、匿名/公開、限定身分組、可修改、結果隱藏、開始與截止', module: 'polls',
  async render(el) {
    await H.loadMeta();
    const rows = await GET('/polls');
    const statusTag = p => p.closed ? '<span class="tag">已結束</span>'
      : (!p.started ? '<span class="tag warn">尚未開始</span>' : '<span class="tag ok">進行中</span>');
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 建立投票</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>題目</th><th>類型</th><th>頻道</th><th>票數</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(p => `
          <tr><td class="wrap"><strong>${UI.esc(p.question)}</strong></td>
            <td>${p.multi ? '複選' : '單選'}·${p.anonymous ? '匿名' : '公開'}${p.allowed_roles ? '·限身分組' : ''}</td>
            <td>${H.chanName(p.channel_id)}</td><td>${p.total}</td>
            <td>${statusTag(p)}</td>
            <td><button class="btn tiny secondary" data-detail="${p.id}">結果</button>
                ${!p.closed ? `<button class="btn tiny secondary" data-close="${p.id}">提前結束</button>` : ''}
                <button class="btn tiny danger" data-del="${p.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">尚無投票</td></tr>'}
        </tbody></table></div>`;

    el.querySelector('#add').onclick = () => { const pm = UI.modal({
      title: '建立投票', okText: '發布', bodyHTML: `
        <div class="field"><label>投票標題</label><input name="question"></div>
        <div class="field"><label>投票說明（可空）</label><textarea name="description"></textarea>
          ${H.emojiInsert('description')}</div>
        <div class="field"><label>備註（可空，顯示在投票下方方便分辨）</label><input name="note"></div>
        <div class="field"><label>選項（每行一個，2~10 個）</label><textarea name="options_text" placeholder="選項一&#10;選項二"></textarea>
          ${H.emojiInsert('options_text')}</div>
        <div class="field"><label>發布頻道</label>${H.chanSelect('channel_id', '')}</div>
        <div class="field"><label>限定身分組才能投票（可空＝全體）</label>${H.roleSelect('allowed_roles', '', { emptyLabel: '— 全體成員 —' })}</div>
        <div class="form-row">
          <div class="field">${H.toggle('multi', 0, '複選')}</div>
          <div class="field">${H.toggle('anonymous', 0, '匿名（只顯示票數）')}</div>
        </div>
        <div class="form-row">
          <div class="field">${H.toggle('allow_change', 1, '允許截止前修改投票')}</div>
          <div class="field">${H.toggle('hide_results', 0, '結束後才公開結果')}</div>
        </div>
        <div class="form-row">
          <div class="field"><label>開始時間（可空＝立即）</label><input name="start_at" type="datetime-local"></div>
          <div class="field"><label>截止時間（可空）</label><input name="deadline" type="datetime-local"></div>
        </div>`,
      onOk: async (back) => {
        const b = H.collect(back);
        b.options = (back.querySelector('[name=options_text]').value || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!b.question) { UI.err('請填題目'); return false; }
        if (b.options.length < 2) { UI.err('至少要 2 個選項'); return false; }
        await POST('/polls', b); UI.ok('已發布'); App.go('polls');
      }
    }); H.bindMentions(pm.back); };
    el.querySelectorAll('[data-detail]').forEach(b => b.onclick = async () => {
      const d = await GET('/polls/' + b.dataset.detail + '/detail');
      UI.modal({ title: '投票結果：' + UI.esc(d.poll.question), okText: '關閉', onOk: () => {}, bodyHTML: `
        <p style="color:var(--muted)">共 ${d.total} 人投票${d.poll.anonymous ? '（匿名，不顯示投票者）' : ''}</p>
        ${d.result.map(r => `<div class="field"><strong>${UI.esc(r.option)}</strong> — ${r.count} 票
          ${r.voters.length ? `<div class="hint">${r.voters.map(v => `<@${v}>`).join(' ')}</div>` : ''}</div>`).join('')}` });
    });
    el.querySelectorAll('[data-close]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('提前結束並公布結果？')) return;
      await POST('/polls/' + b.dataset.close + '/close'); UI.ok('已結束'); App.go('polls'); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此投票？')) return;
      await DEL('/polls/' + b.dataset.del); UI.ok('已刪除'); App.go('polls'); });
  }
});

// ===== 抽獎 =====
App.page('giveaways', {
  title: '抽獎', sub: '獎品/名額/開始結束時間、保證中獎、補抽、12 小時中獎限制', module: 'giveaways',
  async render(el) {
    await H.loadMeta();
    const rows = await GET('/giveaways');
    const statusTag = g => g.cancelled ? '<span class="tag danger">已取消</span>'
      : g.ended ? '<span class="tag">已開獎</span>'
      : (!g.started ? '<span class="tag warn">尚未開始</span>' : '<span class="tag ok">進行中</span>');
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 建立抽獎</button>
        <div class="spacer"></div>
        <button class="btn secondary small" id="records">中獎紀錄</button>
        ${App.can('blacklist') ? '<a class="btn secondary small" href="#blacklist">管理黑名單</a>' : ''}</div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>活動</th><th>獎品</th><th>名額</th><th>頻道</th><th>參加</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(g => `
          <tr><td><strong>${UI.esc(g.title || '（未命名）')}</strong>${g.guaranteed_list.length ? ` <span class="tag primary">保證${g.guaranteed_list.length}</span>` : ''}${(g.win_lock_hours == null ? 12 : g.win_lock_hours) === 0 ? ' <span class="tag">不限重複</span>' : ` <span class="tag">${g.win_lock_hours == null ? 12 : g.win_lock_hours}H不重複</span>`}</td>
            <td>${UI.esc(g.prize)}</td><td>${g.winners}</td>
            <td>${H.chanName(g.channel_id)}</td><td>${g.entries}</td>
            <td>${statusTag(g)}</td>
            <td><button class="btn tiny secondary" data-detail="${g.id}">明細</button>
                ${!g.ended ? `<button class="btn tiny" data-draw="${g.id}">立即開獎</button>
                             <button class="btn tiny secondary" data-cancel="${g.id}">取消</button>`
                          : `<button class="btn tiny secondary" data-reroll="${g.id}">重抽</button>`}
                <button class="btn tiny danger" data-del="${g.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty">尚無抽獎</td></tr>'}
        </tbody></table></div>`;

    el.querySelector('#add').onclick = () => { const gm = UI.modal({
      title: '建立抽獎', okText: '發布', bodyHTML: `
        <div class="field"><label>活動名稱</label><input name="title" placeholder="例：週年慶抽獎"></div>
        <div class="field"><label>活動說明</label><textarea name="description"></textarea>
          ${H.emojiInsert('description')}</div>
        <div class="field"><label>獎品內容</label><input name="prize"></div>
        <div class="field"><label>得獎名額</label><input name="winners" type="number" value="1" min="1"></div>
        <div class="field"><label>縮圖（右上角小圖，可空＝預設禮物盒）</label>${H.uploadField('thumb', '', { label: '縮圖' })}</div>
        ${H.memberPicker('guaranteed_ids', '', { multi: true, label: '搜尋保證中獎玩家（暱稱或名稱）' })}
        <div class="field"><label>保證中獎者 ID（逗號分隔，可空）</label>
          <input name="guaranteed_ids" placeholder="用上方搜尋加入，或直接貼 ID">
          <div class="hint">指定玩家一定中獎，優先保留名額；人數不可超過得獎名額，且不可為黑名單玩家。</div></div>
        <div class="field"><label>發布頻道</label>${H.chanSelect('channel_id', '')}</div>
        <div class="form-row">
          <div class="field"><label>開始時間（可空＝立即）</label><input name="start_at" type="datetime-local"></div>
          <div class="field"><label>持續時間（例如 30s、5m、2h；填了就從發布起倒數，最低 1 秒、最高 24 小時）</label>
            <input name="duration" placeholder="30s"></div>
          <div class="field"><label>或指定結束時間（可空，到時自動開獎；持續時間優先）</label><input name="deadline" type="datetime-local"></div>
        </div>
        <div class="field">${H.toggle('void_if_insufficient', 0, '參加人數少於得獎名額時流標（不開出獎項）')}</div>
        <div class="field"><label>重複中獎限制</label>
          <select name="win_lock_hours">
            <option value="0">不限制（所有參加者都可能中獎）</option>
            <option value="1">1 小時內中過獎的人不再抽到</option>
            <option value="3">3 小時內中過獎的人不再抽到</option>
            <option value="6">6 小時內中過獎的人不再抽到</option>
            <option value="12" selected>12 小時內中過獎的人不再抽到（預設）</option>
            <option value="24">24 小時內中過獎的人不再抽到</option>
            <option value="72">72 小時內中過獎的人不再抽到</option>
            <option value="168">7 天內中過獎的人不再抽到</option>
          </select>
          <div class="hint">連續辦多場活動時，如果不希望有人被擋掉抽不出來，選「不限制」。</div></div>
        <div class="field"><label>發抽獎時 @ 通知身分組（可多選，可不選）</label>
          ${multiBox('mention_roles', H.roles || [], '', r => '@ ' + r.name)}</div>`,
      onOk: async (back) => {
        const b = H.collect(back);
        b.mention_roles = multiVal(back, 'mention_roles');
        if (!b.prize) { UI.err('請填獎品'); return false; }
        const gc = (b.guaranteed_ids || '').split(',').map(s => s.trim()).filter(Boolean).length;
        if (gc > (parseInt(b.winners) || 1)) { UI.err('保證中獎人數超過得獎名額'); return false; }
        await POST('/giveaways', b); UI.ok('已發布'); App.go('giveaways');
      }
    }); H.bindUploads(gm.back); H.bindMemberPickers(gm.back); H.bindMentions(gm.back); };

    el.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => App.giveawayDetail(b.dataset.detail));
    el.querySelectorAll('[data-draw]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('立即開獎？')) return;
      const r = await POST('/giveaways/' + b.dataset.draw + '/draw', {}); UI.ok(`已開獎（${r.winners.length} 位）`); App.go('giveaways'); });
    el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('取消這場抽獎？將不開獎、直接作廢。')) return;
      await POST('/giveaways/' + b.dataset.cancel + '/cancel', {}); UI.ok('已取消抽獎'); App.go('giveaways'); });
    el.querySelectorAll('[data-reroll]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('重新抽出全部得獎者？（原得獎紀錄會清除）')) return;
      const r = await POST('/giveaways/' + b.dataset.reroll + '/reroll', {}); UI.ok(`已重抽（${r.winners.length} 位）`); App.go('giveaways'); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此抽獎？')) return;
      await DEL('/giveaways/' + b.dataset.del); UI.ok('已刪除'); App.go('giveaways'); });

    el.querySelector('#records').onclick = async () => {
      const r = await GET('/win-records');
      UI.modal({ title: `中獎紀錄與鎖定名單（以 ${r.hours} 小時計）`, okText: '關閉', onOk: () => {}, bodyHTML: `
        <p><strong>目前 ${r.hours} 小時內中過獎的人（各場抽獎依自己的設定決定要不要擋）：</strong></p>
        <div style="margin-bottom:12px">${r.locked.length ? r.locked.map(u => `<span class="tag warn">${UI.esc(u.username || u.user_id)}</span>`).join(' ') : '<span style="color:var(--muted)">（無）</span>'}</div>
        <div class="table-wrap" style="max-height:340px;overflow:auto"><table class="list">
          <thead><tr><th>玩家</th><th>獎品</th><th>時間</th></tr></thead>
          <tbody>${r.recent.length ? r.recent.map(w => `<tr><td>${UI.esc(w.username || w.user_id)}</td><td>${UI.esc(w.prize)}</td>
            <td>${new Date(w.won_at * 1000).toLocaleString('zh-TW', { hour12: false })}</td></tr>`).join('')
            : '<tr><td colspan="3" class="empty">尚無紀錄</td></tr>'}</tbody></table></div>` });
    };
  }
});

// 抽獎明細彈窗（參加者、得獎者、補抽、取消得獎資格）
App.giveawayDetail = async function (id) {
  const d = await GET('/giveaways/' + id + '/detail');
  const winners = d.winner_list.map(uid => {
    const e = d.entries.find(x => x.user_id === uid);
    const isG = d.guaranteed_list.includes(uid);
    return `<tr><td>${UI.esc(e ? e.username : uid)} ${isG ? '<span class="tag primary">保證</span>' : ''}</td>
      <td><code>${uid}</code></td>
      <td><button class="btn tiny danger" data-revoke="${uid}">取消資格</button></td></tr>`;
  }).join('');
  const m = UI.modal({
    title: `抽獎明細：${UI.esc(d.ga.title || d.ga.prize)}`, okText: '關閉', onOk: () => {},
    bodyHTML: `
      <p><strong>獎品</strong>：${UI.esc(d.ga.prize)}　<strong>名額</strong>：${d.ga.winners}　<strong>參加</strong>：${d.entries.length} 人</p>
      <p><strong>建立者</strong>：${UI.esc(d.ga.creator || '—')}　<strong>狀態</strong>：${d.ga.ended ? '已開獎' : (d.ga.started ? '進行中' : '尚未開始')}</p>
      <div class="toolbar" style="margin:6px 0">
        <label style="margin-right:6px">重複中獎限制</label>
        <select id="lockSel">${[0, 1, 3, 6, 12, 24, 72, 168].map(h =>
          `<option value="${h}"${(d.ga.win_lock_hours == null ? 12 : d.ga.win_lock_hours) === h ? ' selected' : ''}>${h ? h + ' 小時內不重複' : '不限制'}</option>`).join('')}</select>
        <button class="btn small secondary" id="lockSave">儲存</button>
        <span class="hint">改完後按「重抽」才會用新設定重新抽出。</span>
      </div>
      <h3 style="margin:12px 0 6px">得獎者（${d.winner_list.length}）</h3>
      <div class="table-wrap"><table class="list"><tbody>${winners || '<tr><td class="empty">尚未開獎</td></tr>'}</tbody></table></div>
      ${d.ga.ended ? `<div class="toolbar" style="margin-top:10px">
        <input id="supN" type="number" value="1" min="1" style="width:70px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <button class="btn small" id="sup">補抽</button></div>` : ''}
      <h3 style="margin:14px 0 6px">參加名單（${d.entries.length}）</h3>
      <div class="table-wrap" style="max-height:220px;overflow:auto"><table class="list">
        <tbody>${d.entries.length ? d.entries.map(e => `<tr><td>${UI.esc(e.username || '')}</td><td><code>${e.user_id}</code></td></tr>`).join('')
          : '<tr><td class="empty">尚無參加者</td></tr>'}</tbody></table></div>`
  });
  m.back.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    if (!await UI.confirm('取消此玩家的得獎資格？')) return;
    await POST('/giveaways/' + id + '/revoke', { user_id: b.dataset.revoke });
    UI.ok('已取消'); m.close(); App.giveawayDetail(id);
  });
  m.back.querySelector('#lockSave').onclick = async () => {
    const hours = m.back.querySelector('#lockSel').value;
    await POST('/giveaways/' + id + '/win-lock', { hours });
    UI.ok('已更新重複中獎限制');
  };
  const sup = m.back.querySelector('#sup');
  if (sup) sup.onclick = async () => {
    const n = parseInt(m.back.querySelector('#supN').value) || 1;
    const r = await POST('/giveaways/' + id + '/supplement', { count: n });
    UI.ok(`已補抽 ${r.winners.length} 位`); m.close(); App.giveawayDetail(id);
  };
};

// ===== 黑名單 =====
// 封鎖範圍：和後端 perm.js 的 FEATURES 一致。'all' 是全部功能都擋。
const BL_FEATURES = [
  ['giveaways', '抽獎'], ['wheels', '角色轉盤'], ['music', '音樂'], ['polls', '投票'],
  ['birthday', '生日慶生'], ['reminders', '提醒'], ['announcements', '公告'],
  ['keywords', '關鍵字自動回覆'], ['all', '⚠️ 全部功能']
];
const BL_LABEL = (f) => (BL_FEATURES.find(x => x[0] === f) || [f, f])[1];

App.page('blacklist', {
  title: '功能黑名單', sub: '可以指定只擋某一項功能，不必整個封掉', module: 'blacklist',
  async render(el) {
    const rows = await GET('/blacklist');
    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 加入黑名單</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>名稱</th><th>使用者 ID</th><th>封鎖範圍</th><th>原因</th><th>加入時間</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(b => `
          <tr><td>${UI.esc(b.username || '—')}</td><td><code>${b.user_id}</code></td>
            <td>${b.feature === 'all'
              ? '<span class="tag danger">全部功能</span>'
              : `<span class="tag">${UI.esc(BL_LABEL(b.feature))}</span>`}</td>
            <td class="wrap">${UI.esc(b.reason || '')}</td><td>${UI.esc(b.created_at)}</td>
            <td><button class="btn tiny secondary" data-edit="${b.user_id}">編輯</button>
              <button class="btn tiny danger" data-del="${b.user_id}">移除</button></td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">名單是空的</td></tr>'}
        </tbody></table></div>`;

    // 新增與編輯共用同一張表單（後端是 upsert，同一個人再送一次就是更新）
    const openForm = (row) => {
      const cur = row || {};
      const m = UI.modal({
        title: row ? `編輯：${cur.username || cur.user_id}` : '加入黑名單',
        bodyHTML: `
          ${row ? '' : H.memberPicker('user_id', 'username')}
          <div class="field"><label>使用者 ID</label><input name="user_id" value="${UI.esc(cur.user_id || '')}" ${row ? 'readonly' : ''}></div>
          <div class="field"><label>名稱（備註）</label><input name="username" value="${UI.esc(cur.username || '')}"></div>
          <div class="field"><label>封鎖範圍</label>
            <select name="feature">${BL_FEATURES.map(([v, t]) =>
              `<option value="${v}"${(cur.feature || 'giveaways') === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
            <div class="hint">只想擋抽獎就選「抽獎」。選「全部功能」的話，這個人連角色轉盤、音樂、生日都不能用。</div></div>
          <div class="field"><label>原因</label><input name="reason" value="${UI.esc(cur.reason || '')}"></div>`,
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.user_id) { UI.err('請搜尋選擇玩家，或填入使用者 ID'); return false; }
          await POST('/blacklist', b);
          UI.ok(row ? '已更新' : '已加入');
          App.go('blacklist');
        }
      });
      if (!row) H.bindMemberPickers(m.back);
    };

    el.querySelector('#add').onclick = () => openForm(null);
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
      openForm(rows.find(r => String(r.user_id) === b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('從黑名單移除？')) return;
      await DEL('/blacklist/' + b.dataset.del); UI.ok('已移除'); App.go('blacklist'); });
  }
});
