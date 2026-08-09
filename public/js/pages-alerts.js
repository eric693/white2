// ===== 關鍵字通知與警告（規格 5.1～5.18）=====

// 多選清單（頻道 / 身分組 / 成員）。選項多時自動出現搜尋框，可即時過濾＋捲動。
function multiBox(name, items, selectedCsv, labelFn) {
  const sel = String(selectedCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) return `<div class="hint">（機器人尚未上線或無資料）</div>`;
  // 過濾器：輸入時隱藏不符的項目（只隱藏、不取消勾選，所以搜尋不影響已選）
  const filter = "var q=this.value.toLowerCase();this.nextElementSibling.querySelectorAll('label.switch').forEach(function(l){l.style.display=l.textContent.toLowerCase().indexOf(q)>-1?'':'none'})";
  const search = items.length > 8
    ? `<input type="text" placeholder="搜尋…（共 ${items.length} 項）" oninput="${filter}" style="width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px">`
    : '';
  return `<div>${search}<div data-multi="${name}" style="max-height:200px;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:2px">
    ${items.map(it => `<label class="switch"><input type="checkbox" value="${it.id}" ${sel.includes(it.id) ? 'checked' : ''}> ${UI.esc(labelFn(it))}</label>`).join('')}
  </div></div>`;
}
function multiVal(back, name) {
  const box = back.querySelector(`[data-multi="${name}"]`);
  if (!box) return '';
  return Array.from(box.querySelectorAll('input:checked')).map(i => i.value).join(',');
}

App.page('alerts', {
  title: '關鍵字通知與警告', sub: '命中關鍵字時通知管理員，並可自動給予警告', module: 'alerts',
  async render(el) {
    await H.loadMeta();
    const [rules, members] = await Promise.all([
      GET('/alert-rules'),
      GET('/discord/members').catch(() => [])
    ]);

    el.innerHTML = `
      <div class="toolbar"><button class="btn" id="add">＋ 新增通知規則</button>
        <div class="spacer"></div><button class="btn secondary" id="logs">觸發紀錄</button></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>規則 / 關鍵字</th><th>比對</th><th>通知對象</th><th>警告</th><th>冷卻</th><th>狀態</th><th></th></tr></thead>
        <tbody>${rules.length ? rules.map(r => `
          <tr><td class="wrap"><strong>${UI.esc(r.name || '（未命名）')}</strong><br>
              <span style="color:var(--muted)">${UI.esc(r.keyword.replace(/\n/g, '、'))}</span></td>
            <td>${H.matchLabel(r.match_type)}</td>
            <td class="wrap">${r.notify_channel ? H.chanName(r.notify_channel) : '—'}${r.notify_dm ? '<br><span class="tag">私訊</span>' : ''}</td>
            <td>${r.warn ? '<span class="tag danger">給警告</span>' : '<span class="tag">僅通知</span>'}</td>
            <td>${r.cooldown ? r.cooldown + ' 秒' : '—'}</td>
            <td>${H.enabledTag(r.enabled)}</td>
            <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')
          : '<tr><td colspan="7" class="empty">尚無規則</td></tr>'}
        </tbody></table></div>`;

    const form = (r = {}) => `
      <div class="field"><label>規則名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="例如：辱罵字詞"></div>
      <div class="field"><label>關鍵字（一行一個，或用逗號分隔；符合任一即觸發）</label>
        <textarea name="keyword" rows="3">${UI.esc(r.keyword || '')}</textarea></div>
      <div class="field"><label>比對方式</label>${H.matchSelect('match_type', r.match_type)}</div>
      <div class="field"><label>監控頻道（不勾＝全伺服器）</label>
        ${multiBox('channels', H.channels || [], r.channels, c => '# ' + c.name)}</div>
      <hr>
      <div class="field"><label>通知管理頻道</label>${H.chanSelect('notify_channel', r.notify_channel)}</div>
      <div class="field"><label>通知的管理員</label>
        ${multiBox('notify_user_ids', members, r.notify_user_ids, m => m.name)}</div>
      <div class="field"><label>通知的管理身分組</label>
        ${multiBox('notify_role_ids', H.roles || [], r.notify_role_ids, x => '@ ' + x.name)}</div>
      <div class="field">${H.toggle('notify_dm', r.notify_dm, '同時以私訊通知上列管理員')}</div>
      <hr>
      <div class="field">${H.toggle('warn', r.warn ?? 0, '觸發後自動給予玩家警告（不勾＝僅通知管理員）')}</div>
      <div class="field"><label>警告原因（顯示給玩家，留空用規則名稱）</label>
        <input name="warn_reason" value="${UI.esc(r.warn_reason || '')}"></div>
      <div class="field">${H.toggle('notify_member', r.notify_member ?? 1, '在頻道回覆通知玩家警告原因與累計次數')}</div>
      <div class="field"><label>冷卻秒數（同一玩家於冷卻內重複觸發不再通知/警告）</label>
        <input name="cooldown" type="number" value="${r.cooldown ?? 60}"></div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用此規則')}</div>`;

    const collect = (back) => {
      const b = H.collect(back);
      b.channels = multiVal(back, 'channels');
      b.notify_user_ids = multiVal(back, 'notify_user_ids');
      b.notify_role_ids = multiVal(back, 'notify_role_ids');
      return b;
    };

    el.querySelector('#add').onclick = () => UI.modal({
      title: '新增通知規則', bodyHTML: form(),
      onOk: async (back) => { await POST('/alert-rules', collect(back)); UI.ok('已新增'); App.go('alerts'); }
    });

    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const r = rules.find(x => x.id == b.dataset.edit);
      UI.modal({
        title: '編輯通知規則', bodyHTML: form(r),
        onOk: async (back) => { await PUT('/alert-rules/' + r.id, collect(back)); UI.ok('已儲存'); App.go('alerts'); }
      });
    });

    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除此規則？觸發紀錄會保留。')) return;
      await DEL('/alert-rules/' + b.dataset.del); UI.ok('已刪除'); App.go('alerts');
    });

    el.querySelector('#logs').onclick = async () => {
      const logs = await GET('/alert-logs');
      UI.modal({
        title: `觸發紀錄（最近 ${logs.length} 筆）`, okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>頻道</th><th>關鍵字</th><th>訊息</th><th>警告</th></tr></thead>
          <tbody>${logs.length ? logs.map(l => `
            <tr><td>${UI.esc(l.created_at)}</td>
              <td class="wrap">${UI.esc(l.username)}<br><code>${l.user_id}</code></td>
              <td>${H.chanName(l.channel_id)}</td><td>${UI.esc(l.matched)}</td>
              <td class="wrap">${UI.esc((l.message || '').slice(0, 60))}</td>
              <td>${l.warned ? '' : '—'}</td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">尚無紀錄</td></tr>'}
          </tbody></table></div>`
      });
    };
  }
});

// ===== 警告與禁言紀錄（5.10～5.14）=====
App.page('warnings', {
  title: '警告與禁言', sub: '警告累計、自動禁言門檻與處分紀錄', module: 'warnings',
  async render(el) {
    await H.loadMeta();
    const [cfg, users, mutes] = await Promise.all([
      GET('/warn-config'), GET('/warnings'), GET('/mutes')
    ]);

    el.innerHTML = `
      <div class="card" style="max-width:660px" id="cfgwrap">
        <h3>分級處分設定</h3>
        <div class="field">${H.toggle('escalate', cfg.escalate ?? 1, '啟用分級處分（第 1、2 次禁言，第 3 次踢除/重禁言）')}</div>
        <div class="form-row">
          <div class="field"><label>第 1 次警告：禁言分鐘（0＝只警告不禁言）</label>
            <input name="punish1_minutes" type="number" min="0" value="${cfg.punish1_minutes ?? 10}"></div>
          <div class="field"><label>第 2 次警告：禁言分鐘</label>
            <input name="punish2_minutes" type="number" min="0" value="${cfg.punish2_minutes ?? 60}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>第 3 次（含以上）處分</label>
            <select name="punish3_action">
              <option value="kick" ${cfg.punish3_action === 'kick' ? 'selected' : ''}>踢出伺服器</option>
              <option value="mute" ${cfg.punish3_action === 'mute' ? 'selected' : ''}>禁言</option>
              <option value="none" ${cfg.punish3_action === 'none' ? 'selected' : ''}>僅通知管理員</option>
            </select></div>
          <div class="field"><label>第 3 次禁言分鐘（選禁言時）</label>
            <input name="punish3_minutes" type="number" min="1" value="${cfg.punish3_minutes ?? 1440}"></div>
        </div>
        <div class="field"><div class="hint">警告次數每日 00:00 自動歸零；禁言上限 40320 分鐘（28 天，Discord 限制）。
          關閉分級處分時改用舊制：當日累計 ${cfg.threshold} 次禁言 ${cfg.mute_minutes} 分鐘。<br>
          也可在 Discord 直接用 <code>/警告 新增</code>、<code>/警告 查詢</code>、<code>/警告 清除</code>、<code>/解除禁言</code> 指令操作。</div></div>
        <div class="field"><label>禁言通知的管理頻道</label>${H.chanSelect('notify_channel', cfg.notify_channel)}</div>
        <div class="field">${H.toggle('dm_member', cfg.dm_member, '同時私訊通知被禁言的玩家')}</div>
        <button class="btn" id="csave">儲存設定</button>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">玩家警告累計</h3><div class="spacer"></div>
          <button class="btn small" id="addw">＋ 手動警告</button>
          <button class="btn small secondary" id="addm">手動禁言</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>Discord ID</th><th>當日</th><th>歷史累計</th><th>最近一次</th><th></th></tr></thead>
          <tbody>${users.length ? users.map(u => `
            <tr><td>${UI.esc(u.username || '—')}</td><td><code>${u.user_id}</code></td>
              <td>${u.today >= cfg.threshold ? `<span class="tag danger">${u.today}</span>` : u.today}</td>
              <td>${u.total}</td><td>${UI.esc(u.last_at || '')}</td>
              <td><button class="btn tiny secondary" data-detail="${u.user_id}">明細</button>
                  <button class="btn tiny danger" data-clear="${u.user_id}">歸零</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">尚無警告紀錄</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>禁言紀錄</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>原因</th><th>時長</th><th>開始</th><th>預計解除</th><th>狀態</th><th></th></tr></thead>
          <tbody>${mutes.length ? mutes.map(m => `
            <tr><td class="wrap">${UI.esc(m.username || '—')}<br><code>${m.user_id}</code></td>
              <td class="wrap">${UI.esc(m.reason)}</td><td>${m.minutes} 分</td>
              <td>${UI.esc(m.start_at)}</td><td>${UI.esc(m.end_at)}</td>
              <td>${m.active ? '<span class="tag danger">禁言中</span>'
                    : `<span class="tag">已解除</span>${m.released_by ? '<br><span style="color:var(--muted)">' + UI.esc(m.released_by) + '</span>' : ''}`}</td>
              <td>${m.active ? `<button class="btn tiny" data-release="${m.id}">提前解除</button>` : ''}</td></tr>`).join('')
            : '<tr><td colspan="7" class="empty">尚無禁言紀錄</td></tr>'}
          </tbody></table></div>
      </div>`;

    el.querySelector('#csave').onclick = async (e) => {
      e.target.disabled = true;
      try { await PUT('/warn-config', H.collect(el.querySelector('#cfgwrap'))); UI.ok('已儲存'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    el.querySelector('#addw').onclick = () => UI.modal({
      title: '手動新增警告', bodyHTML: `
        <div class="field"><label>Discord ID</label><input name="user_id"></div>
        <div class="field"><label>顯示名稱（可空）</label><input name="username"></div>
        <div class="field"><label>警告原因</label><input name="reason"></div>`,
      onOk: async (back) => { await POST('/warnings', H.collect(back)); UI.ok('已新增'); App.go('warnings'); }
    });

    el.querySelector('#addm').onclick = () => UI.modal({
      title: '手動禁言', bodyHTML: `
        <div class="field"><label>Discord ID</label><input name="user_id"></div>
        <div class="field"><label>禁言時間（分鐘）</label><input name="minutes" type="number" value="60"></div>
        <div class="field"><label>原因</label><input name="reason" value="管理員手動禁言"></div>`,
      onOk: async (back) => { await POST('/mutes', H.collect(back)); UI.ok('已禁言'); App.go('warnings'); }
    });

    el.querySelectorAll('[data-release]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('提前解除此玩家的禁言？', '解除', 'btn')) return;
      try { await PUT('/mutes/' + b.dataset.release + '/release'); UI.ok('已解除'); App.go('warnings'); }
      catch (e) { UI.err(e.message); }
    });

    el.querySelectorAll('[data-clear]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('將此玩家的警告次數歸零？（紀錄仍會保留）')) return;
      await PUT('/warnings/user/' + b.dataset.clear + '/clear'); UI.ok('已歸零'); App.go('warnings');
    });

    el.querySelectorAll('[data-detail]').forEach(b => b.onclick = async () => {
      const uid = b.dataset.detail;
      const d = await GET('/warnings/' + uid);
      UI.modal({
        title: `警告明細：${uid}`, okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>原因</th><th>來源</th><th>觸發內容</th><th>狀態</th><th></th></tr></thead>
          <tbody>${d.warnings.length ? d.warnings.map(w => `
            <tr><td>${UI.esc(w.created_at)}</td><td class="wrap">${UI.esc(w.reason)}</td>
              <td>${w.source === 'manual' ? '手動' + (w.operator ? '·' + UI.esc(w.operator) : '') : '自動'}</td>
              <td class="wrap">${UI.esc((w.content || '').slice(0, 50)) || '—'}</td>
              <td>${w.active ? '<span class="tag danger">計入</span>' : '<span class="tag">已撤銷</span>'}</td>
              <td>${w.active ? `<button class="btn tiny secondary" data-revoke="${w.id}">撤銷</button>` : ''}
                  <button class="btn tiny danger" data-delw="${w.id}">刪除</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">無警告紀錄</td></tr>'}
          </tbody></table></div>`
      }).back.addEventListener('click', async (ev) => {
        const rev = ev.target.dataset.revoke, del = ev.target.dataset.delw;
        if (rev) { await PUT('/warnings/' + rev + '/revoke'); UI.ok('已撤銷'); App.go('warnings'); }
        if (del) { await DEL('/warnings/' + del); UI.ok('已刪除'); App.go('warnings'); }
      });
    });
  }
});
