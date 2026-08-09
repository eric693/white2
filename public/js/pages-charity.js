// ===== 慈善基金會：捐款抵稅、餘額公開、自動撥進普發池 =====
App.page('charity', {
  title: '基金會', sub: '玩家 /捐款 進公開帳戶，可折抵稅額，餘額自動變成普發救濟金', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const c = await GET('/charity');
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;

    el.innerHTML = `
      <div class="card" style="max-width:820px">
        <h3>帳目</h3>
        <div class="form-row">
          <div class="field"><label>目前餘額</label><div style="font-size:22px;font-weight:700">${coin(c.pool)}</div></div>
          <div class="field"><label>累計募得</label><div style="font-size:22px">${coin(c.total_in)}</div></div>
          <div class="field"><label>已撥出當救濟金</label><div style="font-size:22px">${coin(c.total_out)}</div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="max-width:220px"><label>手動增減餘額（可填負數）</label><input id="delta" type="number" placeholder="例如 50000"></div>
          <button class="btn small secondary" id="adjust">套用</button>
        </div>
        <div class="hint">活動加碼或修正誤差用。正數＝注資（也會算進累計募得），負數＝抽走。</div>
      </div>

      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用慈善基金會（關閉＝玩家不能捐款）')}</div>
        <div class="form-row">
          <div class="field"><label>基金會名稱</label><input name="name" value="${UI.esc(c.name || '慈善基金會')}"></div>
          <div class="field"><label>單筆最低捐款</label><input name="min_donate" type="number" min="0" value="${c.min_donate ?? 1000}"></div>
        </div>
        <div class="field"><label>捐款公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">每有人捐款就公布「誰捐了多少、基金會剩多少」，帳目公開才有捐款動機。</div></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🧾 捐款抵稅</h3>
        <div class="form-row">
          <div class="field"><label>折抵比例 %</label><input name="deduct_pct" type="number" min="0" max="100" step="0.5" value="${c.deduct_pct ?? 10}">
            <div class="hint">10％＝捐 100,000 折抵 10,000 稅金。折抵只算<b>上次結算之後</b>的捐款，結算後重新起算。</div></div>
          <div class="field"><label>每人每期折抵上限（0＝不限）</label><input name="deduct_max" type="number" min="0" value="${c.deduct_max ?? 0}"></div>
          <div class="field"><label>最多能抵掉稅金的 %</label><input name="deduct_max_pct" type="number" min="0" max="100" value="${c.deduct_max_pct ?? 100}">
            <div class="hint">100＝可以完全免稅；設 50＝最多只能少繳一半。</div></div>
        </div>
        <div class="field">${H.toggle('to_relief', c.to_relief, '基金會餘額自動當普發（救濟金）財源')}
          <div class="hint">開啟＝結算時普發不夠的部分從基金會撥出，捐款直接變成別人的救濟金（在稅金頁設定普發條件）。</div></div>
        <div style="margin-top:16px"><button class="btn" id="savecfg">儲存設定</button></div>
      </div>

      <div class="card">
        <h3>捐款榜（歷史累計）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>累計捐款</th><th>筆數</th></tr></thead>
          <tbody>${(c.top || []).length ? c.top.map((t, i) => `<tr>
            <td>${i + 1}. ${UI.esc(t.username || t.user_id)}</td><td>${coin(t.amount)}</td><td>${t.times}</td></tr>`).join('')
        : '<tr><td colspan="3" class="hint">還沒有人捐款。</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>最近捐款</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>金額</th><th>當時可折抵</th></tr></thead>
          <tbody>${(c.recent || []).length ? c.recent.map(r => `<tr>
            <td>${UI.esc(r.created_at)}</td><td>${UI.esc(r.username || r.user_id)}</td><td>${coin(r.amount)}</td><td>${coin(r.credit)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="hint">還沒有捐款紀錄。</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>撥款紀錄（給普發）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>期間</th><th>撥出金額</th><th>受益人數</th><th>時間</th></tr></thead>
          <tbody>${(c.payouts || []).length ? c.payouts.map(p => `<tr>
            <td>${UI.esc(p.period)}</td><td>${coin(p.amount)}</td><td>${p.people}</td><td>${UI.esc(p.created_at)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="hint">還沒有撥款。</td></tr>'}</tbody>
        </table></div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/charity', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('charity');
    };
    el.querySelector('#adjust').onclick = async () => {
      const delta = +el.querySelector('#delta').value || 0;
      if (!delta) return UI.err('請填要增減的金額');
      if (!await UI.confirm(`確定要把基金會餘額 ${delta > 0 ? '增加' : '減少'} ${Math.abs(delta).toLocaleString('en-US')}？`)) return;
      await POST('/charity-adjust', { delta });
      UI.ok('已調整'); App.go('charity');
    };
  }
});
