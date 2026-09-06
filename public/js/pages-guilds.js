// ===== 伺服器管理（白名單：只給朋友使用）=====
App.page('guilds', {
  help: {
    "intro": "控管哪些 Discord 伺服器可以使用這隻機器人（邀請制）。",
    "steps": [
      "朋友把伺服器邀請連結給你，貼進「用邀請連結授權」就能預先核准。",
      "已加入的伺服器可以在清單直接核准或撤銷。",
      "最上面那排數字就是「有多少人邀請過」：待核准＝邀過但還沒開通的。",
      "訪客從功能介紹頁送出的開通申請，會出現在「線上申請」那張表。"
    ],
    "notes": [
      "未核准的伺服器加進去也不能用，會顯示聯繫訊息。",
      "撤銷授權不會刪除該伺服器的資料，重新核准後資料還在。"
    ]
  },
  title: '伺服器管理', sub: '控管哪些伺服器可以邀請這隻機器人', module: 'guilds',
  async render(el) {
    const d = await GET('/guild-admin');
    const apps = await GET('/applications').catch(() => []);

    const st = d.stats || {};
    const ROLE_NAME = { secretary: '秘書', butler: '管家' };
    const PLAN_NAME = { trial: '試用版（14 天）', standard: '標準版', pro: '專業版' };
    const roleTags = (v) => (v || '').split(',').filter(Boolean)
      .map(r => `<span class="tag">${ROLE_NAME[r] || r}</span>`).join(' ') || '—';

    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="num">${st.total || 0}</div><div class="label">邀請過的伺服器</div></div>
        <div class="stat"><div class="num">${st.approved || 0}</div><div class="label">已開通</div></div>
        <div class="stat"><div class="num">${st.pending || 0}</div><div class="label">待核准</div></div>
        <div class="stat"><div class="num">${st.online || 0}</div><div class="label">機器人在線</div></div>
        <div class="stat"><div class="num">${st.invites || 0}</div><div class="label">累計邀請次數</div></div>
        <div class="stat"><div class="num">${st.this_month || 0}</div><div class="label">本月有邀請</div></div>
      </div>

      <div class="card" style="max-width:760px">
        <h3>邀請控管</h3>
        <div class="field">
          <label class="switch"><input type="checkbox" id="openmode" ${d.open_mode ? 'checked' : ''}>
            開放模式（任何人都能把機器人加進自己的伺服器）</label>
          <div class="hint">${d.open_mode
            ? '目前是開放模式，任何拿到邀請連結的人都能使用。'
            : '目前是限制模式：陌生伺服器邀請後機器人會自動退出，並通知你的管理頻道，核准後才能用。'}</div>
        </div>
        <div class="field"><label>邀請連結（給朋友）</label>
          <input value="${UI.esc(d.invite)}" readonly onclick="this.select()">
          <div class="hint">朋友邀請後，若還沒核准，機器人會先自動退出並通知你。你在下面核准後請他重新邀請一次即可。</div></div>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">線上申請（${apps.filter(a => a.status === 'pending').length} 筆待處理）</h3>
          <div class="spacer"></div>
          <span class="hint">來自功能介紹頁的「線上申請開通」表單</span></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>伺服器</th><th>要哪隻</th><th>方案</th><th>聯絡方式</th><th>備註</th><th>狀態</th><th></th></tr></thead>
          <tbody>${apps.length ? apps.map(a => `
            <tr><td class="wrap">${UI.esc(a.created_at || '')}</td>
              <td class="wrap"><strong>${UI.esc(a.guild_name || '（未填）')}</strong>
                ${a.guild_id ? `<br><code>${UI.esc(a.guild_id)}</code>` : ''}
                ${a.invite ? `<br><span class="hint">${UI.esc(a.invite)}</span>` : ''}</td>
              <td>${roleTags(a.bots)}</td>
              <td>${UI.esc(PLAN_NAME[a.plan] || a.plan || '—')}</td>
              <td class="wrap">${UI.esc(a.contact || '—')}</td>
              <td class="wrap">${UI.esc(a.note || '—')}</td>
              <td>${a.status === 'pending' ? '<span class="tag danger">待處理</span>'
                   : a.status === 'approved' ? '<span class="tag ok">已核准</span>' : '<span class="tag">已婉拒</span>'}</td>
              <td>${a.status === 'pending'
                ? `<button class="btn tiny" data-app-ok="${a.id}">核准</button>
                   <button class="btn tiny secondary" data-app-no="${a.id}">婉拒</button>` : ''}
                <button class="btn tiny danger" data-app-del="${a.id}">刪除</button></td></tr>`).join('')
            : '<tr><td colspan="8" class="empty">目前沒有申請</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <div class="toolbar"><h3 style="margin:0">伺服器清單（${d.guilds.length}）</h3>
          <div class="spacer"></div>
          <button class="btn small" id="preapprove">＋ 預先授權伺服器 ID</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>伺服器</th><th>ID</th><th>狀態</th><th>邀過哪隻</th><th>邀請次數</th><th>最後邀請</th><th>成員</th><th>備註</th><th></th></tr></thead>
          <tbody>${d.guilds.length ? d.guilds.map(g => `
            <tr><td class="wrap"><strong>${UI.esc(g.name || '（未知）')}</strong></td>
              <td><code>${g.guild_id}</code></td>
              <td>${g.approved
                ? (g.online ? '<span class="tag ok">已授權·使用中</span>' : '<span class="tag primary">已授權·未加入</span>')
                : '<span class="tag danger">待核准</span>'}</td>
              <td>${roleTags(g.invited_roles)}</td>
              <td>${g.invite_count || 0}</td>
              <td class="wrap">${UI.esc(g.last_invite_at || g.joined_at || '—')}</td>
              <td>${g.members || '—'}</td>
              <td class="wrap">${UI.esc(g.note || '—')}</td>
              <td>${g.approved
                ? `<button class="btn tiny secondary" data-revoke="${g.guild_id}">撤銷授權</button>`
                : `<button class="btn tiny" data-approve="${g.guild_id}" data-name="${UI.esc(g.name || '')}">核准</button>`}
                ${g.approved ? `<button class="btn tiny danger" data-reset="${g.guild_id}" data-name="${UI.esc(g.name || '')}">重置資料</button>` : ''}
                ${g.online ? `<button class="btn tiny danger" data-leave="${g.guild_id}">讓機器人離開</button>` : ''}</td></tr>`).join('')
            : '<tr><td colspan="9" class="empty">尚無紀錄</td></tr>'}
          </tbody></table></div>
      </div>`;

    el.querySelector('#openmode').onchange = async (e) => {
      try { await PUT('/guild-open-mode', { open: e.target.checked ? 1 : 0 }); UI.ok('已更新'); App.go('guilds'); }
      catch (err) { UI.err(err.message); }
    };

    el.querySelector('#preapprove').onclick = () => UI.modal({
      title: '預先授權伺服器', okText: '核准',
      bodyHTML: `<div class="field"><label>伺服器邀請連結 ⭐推薦</label>
          <input name="invite" placeholder="貼上 discord.gg/xxxx（請朋友從他的伺服器產生邀請連結，私訊給你）">
          <div class="hint">最簡單：叫朋友對他的伺服器 → 邀請 → 複製連結，私訊給你，貼進來就好，不用找 ID。</div></div>
        <div class="field"><label>或：伺服器 ID</label><input name="gid" placeholder="找不到就用上面的邀請連結"></div>
        <div class="field"><label>備註（例如朋友名字）</label><input name="note"></div>
        <div class="field"><div class="hint">先核准，朋友就能直接邀請成功、不會被退出。</div></div>`,
      onOk: async (back) => {
        const b = H.collect(back);
        try {
          if (b.invite && b.invite.trim()) {
            const r = await POST('/guild-admin-by-invite', { invite: b.invite.trim(), note: b.note });
            UI.ok(`已核准：${r.name || r.guild_id}`);
          } else if (b.gid && b.gid.trim()) {
            await PUT('/guild-admin/' + b.gid.trim(), { approved: 1, note: b.note });
            UI.ok('已核准');
          } else { UI.err('請貼邀請連結，或填伺服器 ID'); return false; }
          App.go('guilds');
        } catch (err) { UI.err(err.message); return false; }
      }
    });

    el.querySelectorAll('[data-app-ok]').forEach(b => b.onclick = async () => {
      await PUT('/applications/' + b.dataset.appOk, { status: 'approved' });
      UI.ok('已核准，記得通知對方重新邀請機器人'); App.go('guilds');
    });
    el.querySelectorAll('[data-app-no]').forEach(b => b.onclick = async () => {
      await PUT('/applications/' + b.dataset.appNo, { status: 'rejected' });
      UI.ok('已婉拒'); App.go('guilds');
    });
    el.querySelectorAll('[data-app-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這筆申請紀錄？')) return;
      await DEL('/applications/' + b.dataset.appDel);
      UI.ok('已刪除'); App.go('guilds');
    });

    el.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
      await PUT('/guild-admin/' + b.dataset.approve, { approved: 1, name: b.dataset.name });
      UI.ok('已核准，請對方重新邀請機器人'); App.go('guilds');
    });
    el.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('撤銷此伺服器的授權？（不會馬上踢出機器人）')) return;
      await PUT('/guild-admin/' + b.dataset.revoke, { approved: 0 });
      UI.ok('已撤銷'); App.go('guilds');
    });
    el.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
      const nm = b.dataset.name || '這個伺服器';
      if (!await UI.confirm(`確定要重置「${nm}」嗎？\n\n⚠️ 會清空這台的「所有」資料：公告、抽獎、投票、關鍵字、警告、身分組轉盤、生日、提醒、客服單、等級經驗值…全部回到全新狀態，且無法復原！\n\n其他伺服器不受影響。`)) return;
      if (!await UI.confirm(`最後確認：真的要把「${nm}」清空回全新嗎？`)) return;
      const r = await POST('/guild-admin/' + b.dataset.reset + '/reset', {});
      UI.ok(`已重置，清除 ${r.cleared} 筆資料`); App.go('guilds');
    });
    el.querySelectorAll('[data-leave]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('讓機器人離開這個伺服器？資料會保留。')) return;
      await DEL('/guild-admin/' + b.dataset.leave);
      UI.ok('機器人已離開'); App.go('guilds');
    });
  }
});
