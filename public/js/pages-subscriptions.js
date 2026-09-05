// ===== 訂閱管理（秘書／管家各自一份）=====
// 兩隻機器人在同一台伺服器上是獨立訂閱：可以只訂秘書、只訂管家，或兩隻都訂。
// 到期不會刪任何資料，只是判定上退回免費版；續費後原樣恢復。
App.page('subscriptions', {
  help: {
    "intro": "管理每台伺服器對「璃白Yu光秘書」與「璃白Yu光管家」的訂閱方案與到期日。",
    "steps": [
      "「方案」設每個方案的月費／年費，以及包含哪些功能（勾選功能鍵）。",
      "「各伺服器訂閱」為單一伺服器續訂、升降級，或直接指定到期日（永久開通填 0）。"
    ],
    "notes": [
      "到期後只是判定上退回免費版，資料與遊戲進度都保留，續費後原樣恢復。",
      "方案沒包含的功能，指令會直接不註冊到那台伺服器（玩家看不到也點不到），冒險面板上的按鈕也會被攔下並提示續費。",
      "關鍵字回覆、歡迎訊息、生日祝賀、表情身分組、排程公告、排程提醒、聊天等級這類「不是用指令觸發」的功能，沒訂閱時會安靜停止動作（不會在頻道喊續費），設定與已累積的資料都保留。",
      "新成員的自動給予身分組、入群／離群紀錄不受訂閱限制 —— 擋掉會讓新成員直接進不了頻道。",
      "免費版是到期後的退場方案，不能刪除。"
    ],
    "terms": [
      ["功能鍵", "付費牆的最小顆粒，對應一個功能模組（例如 music、stock）。方案填 * 代表全部開放。"]
    ]
  },
  title: '訂閱管理', sub: '秘書／管家的方案與各伺服器訂閱狀態', module: 'system',

  async render(el) {
    const ROLE_LABEL = { secretary: '📝 璃白Yu光秘書', butler: '🎮 璃白Yu光管家' };
    const [feats, plans, subs] = await Promise.all([
      GET('/subscriptions/features'), GET('/subscriptions/plans'), GET('/subscriptions')
    ]);
    const coin = (n) => Number(n || 0).toLocaleString('en-US');
    const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '永久');

    // ---- 方案卡片 ----
    const planCard = (role) => {
      const list = plans.filter(p => p.role === role);
      const keys = feats[role] || {};
      return `
        <div class="card">
          <h3>${ROLE_LABEL[role]}｜方案</h3>
          <div class="hint" style="margin-bottom:10px">功能列填 <code>*</code> ＝ 全部開放。免費版是到期後的退場方案，不能刪也不能停售。<br>
            取消「販售中」＝ 不再開放指定給新的伺服器；已經在用這個方案的伺服器不受影響，到期前照常使用。</div>
          ${list.map(p => `
            <div class="card" style="margin:0 0 10px;background:var(--bg2)" data-plan="${role}:${p.code}">
              <div class="form-row">
                <div class="field" style="max-width:120px"><label>代號</label>
                  <input name="code" value="${UI.esc(p.code)}" ${p.code === 'free' ? 'readonly' : ''}></div>
                <div class="field" style="max-width:160px"><label>名稱</label><input name="name" value="${UI.esc(p.name)}"></div>
                <div class="field" style="max-width:110px"><label>月費</label><input name="price_month" type="number" min="0" value="${p.price_month}"></div>
                <div class="field" style="max-width:110px"><label>年費</label><input name="price_year" type="number" min="0" value="${p.price_year}"></div>
                <div class="field" style="max-width:90px"><label>排序</label><input name="sort" type="number" value="${p.sort}"></div>
                <div class="field" style="max-width:130px"><label>販售狀態</label>
                  <label class="switch" style="font-size:13px"><input type="checkbox" name="active"
                    ${p.active === 0 ? '' : 'checked'} ${p.code === 'free' ? 'disabled' : ''}> 販售中</label></div>
              </div>
              <div class="field"><label>包含的功能</label>
                <label class="switch" style="margin-bottom:6px"><input type="checkbox" name="all" ${String(p.features).trim() === '*' ? 'checked' : ''}> 全部開放（*）</label>
                <div class="featgrid" style="display:flex;flex-wrap:wrap;gap:6px 14px">
                  ${Object.entries(keys).map(([k, label]) => `
                    <label class="switch" style="font-size:13px"><input type="checkbox" name="feat" value="${k}"
                      ${String(p.features).split(',').map(x => x.trim()).includes(k) ? 'checked' : ''}> ${UI.esc(label)}</label>`).join('')}
                </div></div>
              <div style="display:flex;gap:8px">
                <button class="btn small" data-saveplan="${role}:${p.code}">儲存</button>
                ${p.code === 'free' ? '' : `<button class="btn small danger" data-delplan="${role}:${p.code}">刪除</button>`}
              </div>
            </div>`).join('')}
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div class="field" style="margin:0;max-width:130px"><label>新方案代號</label><input id="np_${role}" placeholder="pro"></div>
            <div class="field" style="margin:0;max-width:160px"><label>名稱</label><input id="nn_${role}" placeholder="專業版"></div>
            <button class="btn" data-addplan="${role}">新增方案</button>
          </div>
        </div>`;
    };

    // ---- 各伺服器訂閱 ----
    const subRow = (g, role) => {
      const s = g[role];
      // 停售的方案不列進來（後端也會擋），但如果這台伺服器現在正在用，還是要顯示得出來
      const opts = plans.filter(p => p.role === role && (p.active !== 0 || p.code === s.plan_code))
        .map(p => `<option value="${p.code}" ${p.code === s.plan_code ? 'selected' : ''}>${UI.esc(p.name)}${p.active === 0 ? '（已停售）' : ''}</option>`).join('');
      const state = s.expired
        ? '<span class="tag danger">已到期</span>'
        : (s.expires_at ? '<span class="tag ok">訂閱中</span>' : '<span class="tag ok">永久</span>');
      return `<tr data-sub="${g.guild_id}:${role}">
        <td>${UI.esc(ROLE_LABEL[role])}</td>
        <td><select name="plan_code">${opts}</select></td>
        <td>${state}<div class="hint" style="font-size:12px">${when(s.expires_at)}</div></td>
        <td style="white-space:nowrap">
          <select name="cycle" style="width:80px"><option value="month">月</option><option value="year">年</option></select>
          <input name="units" type="number" min="1" value="1" style="width:60px">
          <button class="btn tiny" data-extend="${g.guild_id}:${role}">續訂</button>
        </td>
        <td><button class="btn tiny secondary" data-forever="${g.guild_id}:${role}">永久開通</button>
            <button class="btn tiny danger" data-expire="${g.guild_id}:${role}">立即到期</button></td>
      </tr>`;
    };

    el.innerHTML = `
      <div class="card">
        <h3>各伺服器訂閱狀態</h3>
        <div class="hint" style="margin-bottom:10px">
          兩隻機器人各自獨立訂閱，可以只訂其中一隻。<b>到期不會刪任何資料</b>，只是判定上退回免費版，續費後原樣恢復。<br>
          方案沒包含的功能，指令會直接不註冊到那台伺服器（玩家看不到也點不到）；頻道裡的舊面板按鈕則會被攔下並提示續費。
        </div>
        ${subs.map(g => `
          <div class="card" style="margin:0 0 12px;background:var(--bg2)">
            <div class="toolbar"><h4 style="margin:0">${UI.esc(g.name || g.guild_id)}</h4>
              <div class="spacer"></div>
              <span class="hint">${UI.esc(g.guild_id)}${g.active ? '' : '　<span class="tag">機器人已離開</span>'}</span></div>
            <div class="table-wrap"><table class="list">
              <thead><tr><th>機器人</th><th>方案</th><th>狀態／到期</th><th>續訂</th><th></th></tr></thead>
              <tbody>${subRow(g, 'secretary')}${subRow(g, 'butler')}</tbody>
            </table></div>
          </div>`).join('') || '<div class="hint">還沒有任何伺服器。</div>'}
      </div>

      ${planCard('secretary')}
      ${planCard('butler')}`;

    // ---- 方案存檔 ----
    const readPlan = (box) => {
      const all = box.querySelector('[name=all]').checked;
      const feats2 = [...box.querySelectorAll('[name=feat]:checked')].map(x => x.value);
      return {
        code: box.querySelector('[name=code]').value.trim(),
        // 停售的方案不會影響已經在用的伺服器，只是不能再指定給新的伺服器
        active: box.querySelector('[name=active]').checked,
        name: box.querySelector('[name=name]').value.trim(),
        price_month: Number(box.querySelector('[name=price_month]').value) || 0,
        price_year: Number(box.querySelector('[name=price_year]').value) || 0,
        sort: Number(box.querySelector('[name=sort]').value) || 0,
        features: all ? '*' : feats2.join(',')
      };
    };
    el.querySelectorAll('[data-saveplan]').forEach(b => b.onclick = async () => {
      const [role] = b.dataset.saveplan.split(':');
      const box = b.closest('[data-plan]');
      try { await POST('/subscriptions/plans', { role, ...readPlan(box) }); UI.ok('已儲存'); App.go('subscriptions'); }
      catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-delplan]').forEach(b => b.onclick = async () => {
      const [role, code] = b.dataset.delplan.split(':');
      if (!await UI.confirm(`刪除方案「${code}」？正在用這個方案的伺服器會退回免費版。`)) return;
      try { await DEL(`/subscriptions/plans/${role}/${code}`); UI.ok('已刪除'); App.go('subscriptions'); }
      catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-addplan]').forEach(b => b.onclick = async () => {
      const role = b.dataset.addplan;
      const code = el.querySelector(`#np_${role}`).value.trim();
      const name = el.querySelector(`#nn_${role}`).value.trim();
      if (!code || !name) return UI.err('請填代號與名稱');
      try { await POST('/subscriptions/plans', { role, code, name, features: '' }); UI.ok('已新增'); App.go('subscriptions'); }
      catch (e) { UI.err(e.message); }
    });

    // ---- 訂閱操作 ----
    el.querySelectorAll('[data-extend]').forEach(b => b.onclick = async () => {
      const [gid, role] = b.dataset.extend.split(':');
      const tr = b.closest('tr');
      try {
        await POST(`/subscriptions/${gid}/${role}/extend`, {
          plan_code: tr.querySelector('[name=plan_code]').value,
          cycle: tr.querySelector('[name=cycle]').value,
          units: Number(tr.querySelector('[name=units]').value) || 1
        });
        UI.ok('已續訂'); App.go('subscriptions');
      } catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-forever]').forEach(b => b.onclick = async () => {
      const [gid, role] = b.dataset.forever.split(':');
      const tr = b.closest('tr');
      if (!await UI.confirm('把這隻機器人設為「永久開通」（沒有到期日）？')) return;
      try {
        await POST(`/subscriptions/${gid}/${role}`, {
          plan_code: tr.querySelector('[name=plan_code]').value, expires_at: 0, note: '後台永久開通'
        });
        UI.ok('已永久開通'); App.go('subscriptions');
      } catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-expire]').forEach(b => b.onclick = async () => {
      const [gid, role] = b.dataset.expire.split(':');
      if (!await UI.confirm('立即讓這份訂閱到期？付費功能會被鎖住，但資料與進度都會保留，續費後恢復。')) return;
      try {
        await POST(`/subscriptions/${gid}/${role}`, {
          plan_code: 'free', expires_at: Math.floor(Date.now() / 1000) - 1, note: '後台手動到期'
        });
        UI.ok('已設為到期'); App.go('subscriptions');
      } catch (e) { UI.err(e.message); }
    });
  }
});
