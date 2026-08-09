// ===== 系統狀態與紀錄（11.4～11.5）=====
App.page('system', {
  title: '系統狀態', sub: '機器人運行狀況、操作紀錄與錯誤紀錄', module: 'system',
  async render(el) {
    await H.loadMeta();
    const s = await GET('/system/status');
    const uptime = (sec) => {
      const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
      return `${d ? d + ' 天 ' : ''}${h} 小時 ${m} 分`;
    };
    const box = (title, obj, labels) => `
      <div class="card"><h3>${title}</h3><div class="stat-grid">
        ${Object.entries(obj).map(([k, v]) =>
          `<div class="stat"><div class="num">${v}</div><div class="label">${labels[k] || k}</div></div>`).join('')}
      </div></div>`;

    el.innerHTML = `
      <div class="card">
        <h3>機器人狀態</h3>
        <div class="stat-grid">
          <div class="stat"><div class="num">${s.bot.online ? '上線' : '離線'}</div><div class="label">連線狀態</div></div>
          <div class="stat"><div class="num">${UI.esc(s.bot.guild || '—')}</div><div class="label">服務中的伺服器</div></div>
          <div class="stat"><div class="num">${s.bot.members}</div><div class="label">伺服器成員數</div></div>
          <div class="stat"><div class="num">${uptime(s.bot.uptime_seconds)}</div><div class="label">已運行</div></div>
          <div class="stat"><div class="num">${s.errors_24h}</div><div class="label">24 小時內錯誤</div></div>
        </div>
        ${!s.bot.guild_id || s.bot.guild_id.startsWith('你的') ? '<div class="hint">尚未設定 GUILD_ID，部分功能（禁言、生日身分組、成員清單）無法運作。</div>' : ''}
      </div>
      ${box('功能設定數量', s.features, {
        keywords: '關鍵字回覆', alert_rules: '通知警告規則', announcements: '公告', polls: '投票',
        giveaways: '抽獎', wheels: '角色轉盤', wheel_roles: '轉盤角色', reminders: '提醒', birthdays: '生日資料'
      })}
      ${box('累計活動量', s.activity, {
        keyword_logs: '關鍵字觸發', alert_logs: '通知觸發', warnings: '警告', mutes: '禁言',
        wheel_draws: '轉盤抽取', music_logs: '音樂使用', member_events: '加入/離開'
      })}
      <div class="card">
        <div class="toolbar"><h3 style="margin:0">管理操作紀錄</h3><div class="spacer"></div>
          <input id="q" placeholder="搜尋操作者或動作" style="max-width:200px">
          <button class="btn small secondary" id="errs">錯誤紀錄</button></div>
        <div id="auditbox"></div>
      </div>`;

    const loadAudit = async (q = '') => {
      const rows = await GET('/system/audit' + (q ? '?q=' + encodeURIComponent(q) : ''));
      el.querySelector('#auditbox').innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>時間</th><th>操作者</th><th>功能</th><th>動作</th><th>異動內容</th></tr></thead>
        <tbody>${rows.length ? rows.map(a => `
          <tr><td>${UI.esc(a.created_at)}</td><td>${UI.esc(a.actor || '—')}</td>
            <td>${UI.esc(a.module || '—')}</td><td class="wrap">${UI.esc(a.action)}</td>
            <td class="wrap">${UI.esc((a.detail || '').slice(0, 80) || '—')}</td></tr>`).join('')
          : '<tr><td colspan="5" class="empty">尚無紀錄</td></tr>'}
        </tbody></table></div>`;
    };
    await loadAudit();
    let timer; el.querySelector('#q').oninput = (e) => {
      clearTimeout(timer); timer = setTimeout(() => loadAudit(e.target.value.trim()), 300);
    };

    el.querySelector('#errs').onclick = async () => {
      const rows = await GET('/system/errors');
      UI.modal({
        title: `系統錯誤紀錄（${rows.length}）`, okText: '關閉', onOk: () => {},
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>錯誤內容</th></tr></thead>
          <tbody>${rows.length ? rows.map(r => `
            <tr><td style="white-space:nowrap">${UI.esc(r.created_at)}</td>
              <td class="wrap"><code>${UI.esc(r.message)}</code></td></tr>`).join('')
            : '<tr><td colspan="2" class="empty">沒有錯誤，一切正常 </td></tr>'}
          </tbody></table></div>`
      });
    };
  }
});

// ===== 功能權限設定（12.1～12.5）=====
App.page('perms', {
  title: '功能權限', sub: '依身分組、頻道限制各功能的使用權限', module: 'perms',
  async render(el) {
    await H.loadMeta();
    const [perms, members] = await Promise.all([
      GET('/perms'), GET('/discord/members').catch(() => [])
    ]);

    el.innerHTML = `
      <div class="card"><div class="hint">
        身分組不勾＝全體可用；頻道不勾＝不限頻道。例外名單中的人不受任何限制（黑名單除外）。
      </div></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>功能</th><th>可使用身分組</th><th>限定頻道</th><th>例外名單</th><th>狀態</th><th></th></tr></thead>
        <tbody>${perms.map(p => `
          <tr><td><strong>${UI.esc(p.label)}</strong></td>
            <td class="wrap">${p.role_ids ? UI.esc(p.role_ids.split(',').map(H.roleName).join('、')) : '全體'}</td>
            <td class="wrap">${p.channel_ids ? UI.esc(p.channel_ids.split(',').map(H.chanName).join('、')) : '不限'}</td>
            <td class="wrap">${(p.except_user_ids || p.except_role_ids)
              ? UI.esc([...p.except_role_ids.split(',').filter(Boolean).map(H.roleName),
                        ...p.except_user_ids.split(',').filter(Boolean)].join('、')) : '—'}</td>
            <td>${p.enabled ? '<span class="tag ok">啟用</span>' : '<span class="tag danger">已停用</span>'}</td>
            <td><button class="btn tiny secondary" data-edit="${p.feature}">設定</button></td></tr>`).join('')}
        </tbody></table></div>`;

    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
      const p = perms.find(x => x.feature === b.dataset.edit);
      UI.modal({
        title: `${p.label} — 權限設定`,
        bodyHTML: `
          <div class="field">${H.toggle('enabled', p.enabled, '啟用此功能（取消＝全伺服器停用）')}</div>
          <div class="field"><label>可使用的身分組（不勾＝全體）</label>
            ${multiBox('role_ids', H.roles || [], p.role_ids, r => '@ ' + r.name)}</div>
          <div class="field"><label>僅限這些頻道使用（不勾＝不限）</label>
            ${multiBox('channel_ids', H.channels || [], p.channel_ids, c => '# ' + c.name)}</div>
          <hr>
          <div class="field"><label>例外身分組（不受上述限制）</label>
            ${multiBox('except_role_ids', H.roles || [], p.except_role_ids, r => '@ ' + r.name)}</div>
          <div class="field"><label>例外使用者</label>
            ${multiBox('except_user_ids', members, p.except_user_ids, m => m.name)}</div>`,
        onOk: async (back) => {
          const b2 = H.collect(back);
          b2.role_ids = multiVal(back, 'role_ids');
          b2.channel_ids = multiVal(back, 'channel_ids');
          b2.except_role_ids = multiVal(back, 'except_role_ids');
          b2.except_user_ids = multiVal(back, 'except_user_ids');
          await PUT('/perms/' + p.feature, b2);
          UI.ok('已儲存'); App.go('perms');
        }
      });
    });
  }
});
