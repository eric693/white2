// ===== 音樂系統（9.15～9.21）=====
App.page('music', {
  title: '音樂系統', sub: '控制面板 / 常駐頻道 / 音量 / 權限 / 使用紀錄', module: 'music',
  async render(el) {
    await H.loadMeta();
    const [c, voices] = await Promise.all([
      GET('/music-config'),
      GET('/discord/voice-channels').catch(() => [])
    ]);

    const voiceSelect = (name, sel) => `<select name="${name}">
      <option value="">— 不指定 —</option>
      ${voices.map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${UI.esc(v.name)}</option>`).join('')}
    </select>`;

    el.innerHTML = `
      <div class="card" style="max-width:700px" id="wrap">
        <h3>播放設定</h3>
        <div class="form-row">
          <div class="field"><label>預設音量（%）</label><input name="default_volume" type="number" min="0" max="200" value="${c.default_volume}"></div>
          <div class="field"><label>最高音量上限（%）</label><input name="max_volume" type="number" min="1" max="200" value="${c.max_volume}"></div>
        </div>
        <div class="field">${H.toggle('allow_duplicate', c.allow_duplicate, '允許播放清單中出現重複歌曲（取消後重複點歌會被拒絕）')}</div>
        <div class="field">${H.toggle('vote_skip', c.vote_skip, '開放一般玩家投票跳過歌曲（過半同意即跳過）')}</div>
        <div class="field"><label>播放失敗訊息頻道（空＝發在點歌的頻道）</label>${H.chanSelect('log_channel', c.log_channel)}</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>常駐語音頻道</h3>
        <div class="field"><label>指定語音頻道</label>${voiceSelect('voice_channel', c.voice_channel)}</div>
        <div class="field">${H.toggle('stay_24_7', c.stay_24_7, '常駐此頻道（播完、清單空、沒人也不離開；斷線自動重連）')}</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>權限設定</h3>
        <div class="field"><label>可讓機器人加入／退出語音的身分組（管理員永遠可用）</label>
          ${multiBox('admin_role_ids', H.roles || [], c.admin_role_ids, r => '@ ' + r.name)}</div>
        <div class="field"><label>可控制播放的身分組（跳過／停止／音量／排序，不勾＝全體）</label>
          ${multiBox('dj_role_ids', H.roles || [], c.dj_role_ids, r => '@ ' + r.name)}</div>
        <div class="field"><label>可點歌的身分組（不勾＝全體）</label>
          ${multiBox('request_role_ids', H.roles || [], c.request_role_ids, r => '@ ' + r.name)}</div>
        <button class="btn" id="save">儲存設定</button>
      </div>

      <div class="card" style="max-width:700px">
        <h3>固定音樂控制面板</h3>
        <div class="field"><div class="hint">全伺服器只會保留一則面板，重新發布會自動刪除舊的那則。面板會即時同步歌曲、進度、音量與循環狀態。</div></div>
        <div class="field"><label>面板所在文字頻道</label>${H.chanSelect('panel_channel', c.panel_channel)}</div>
        <button class="btn" id="panel">發布 / 重新發布控制面板</button>
        ${c.panel_message ? `<div class="hint">目前面板：${H.chanName(c.panel_channel)}（訊息 ID ${c.panel_message}）</div>` : ''}
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">音樂使用紀錄</h3><div class="spacer"></div>
          <input id="q" placeholder="搜尋點歌者或歌名" style="max-width:200px"></div>
        <div id="logbox"></div>
      </div>`;

    el.querySelector('#save').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const wrap = el.querySelector('#wrap');
        const b = H.collect(wrap);
        b.admin_role_ids = multiVal(wrap, 'admin_role_ids');
        b.dj_role_ids = multiVal(wrap, 'dj_role_ids');
        b.request_role_ids = multiVal(wrap, 'request_role_ids');
        await PUT('/music-config', b);
        UI.ok('已儲存');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    el.querySelector('#panel').onclick = async (e) => {
      const ch = el.querySelector('[name="panel_channel"]').value;
      if (!ch) return UI.err('請先選擇面板頻道');
      e.target.disabled = true;
      try { await POST('/music-panel', { channel_id: ch }); UI.ok('控制面板已發布'); App.go('music'); }
      catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    const loadLogs = async (q = '') => {
      const rows = await GET('/music-logs' + (q ? '?q=' + encodeURIComponent(q) : ''));
      el.querySelector('#logbox').innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>時間</th><th>玩家</th><th>動作</th><th>歌曲</th><th>頻道</th><th>結果</th></tr></thead>
        <tbody>${rows.length ? rows.map(l => `
          <tr><td>${UI.esc(l.created_at)}</td><td>${UI.esc(l.username || '—')}</td>
            <td>${UI.esc({ play: '點歌', skip: '跳過', stop: '停止', fail: '播放失敗' }[l.action] || l.action)}</td>
            <td class="wrap">${l.url ? `<a href="${UI.esc(l.url)}" target="_blank">${UI.esc(l.title || l.url)}</a>` : UI.esc(l.title || '—')}</td>
            <td>${l.channel_id ? H.chanName(l.channel_id) : '—'}</td>
            <td>${l.status === 'ok' ? '<span class="tag ok">成功</span>'
              : `<span class="tag danger">失敗</span><br><span style="color:var(--muted)">${UI.esc(l.error)}</span>`}</td></tr>`).join('')
          : '<tr><td colspan="6" class="empty">尚無紀錄</td></tr>'}
        </tbody></table></div>`;
    };
    await loadLogs();
    let timer; el.querySelector('#q').oninput = (e) => {
      clearTimeout(timer); timer = setTimeout(() => loadLogs(e.target.value.trim()), 300);
    };
  }
});
