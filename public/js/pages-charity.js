// ===== 慈善基金會：捐款抵稅、餘額公開、自動撥進普發池 =====
App.page('charity', {
  title: '基金會', sub: '玩家 /捐款 進公開帳戶，可折抵稅額，餘額自動變成普發救濟金', module: 'charity',

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

      <div class="card" id="reliefwrap">
        <h3>💸 手動普發（活動用）</h3>
        <div class="hint" style="margin-bottom:10px">
          跟稅金頁的自動普發不同：那個綁在結算流程、只發給餘額低於門檻的人。
          這裡是活動用的一鍵普發（例如「全服普發一萬」），可以先<strong>試算</strong>再執行。
        </div>
        <div class="form-row">
          <div class="field"><label>每人發多少</label><input name="amount" type="number" min="1" value="10000"></div>
          <div class="field"><label>發給誰</label><select name="mode">
            <option value="all">全部玩家</option>
            <option value="below">只發給餘額低於門檻的人</option></select></div>
          <div class="field"><label>門檻（上面選「低於門檻」才用）</label><input name="below" type="number" value="0"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>只發給最近幾天有活動的人（0＝不限）</label><input name="active_days" type="number" min="0" value="14"></div>
          <div class="field"><label>財源</label><select name="source">
            <option value="pool">基金會餘額（推薦）</option>
            <option value="free">直接增發（憑空印錢，會通膨）</option></select></div>
          <div class="field"><label>公告頻道（留空＝用捐款公告頻道）</label>${H.chanSelect('channel', '')}</div>
        </div>
        <div class="form-row">
          <div class="field">${H.toggle('exclude_exempt', 1, '排除免稅名單（管理員／活動帳號）')}</div>
          <div class="field">${H.toggle('exclude_debt', 0, '排除餘額為負的人（欠稅大戶）')}</div>
          <div class="field"><label>公告理由（可留空）</label><input name="reason" placeholder="週年慶普發"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn secondary" id="preview">🔍 試算</button>
          <button class="btn" id="dorelief" disabled>💸 執行普發</button>
        </div>
        <div id="previewout" class="hint" style="margin-top:10px">先按「試算」看看會發給幾個人、總共多少。</div>
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
    // ---- 手動普發：先試算再執行，避免手滑把基金會發空 ----
    const rw = el.querySelector('#reliefwrap');
    const doBtn = el.querySelector('#dorelief');
    const out = el.querySelector('#previewout');
    let lastBody = null;
    el.querySelector('#preview').onclick = async () => {
      const b = H.collect(rw);
      if (!(+b.amount > 0)) return UI.err('請填每人要發多少');
      const r = await POST('/charity-relief-preview', b);
      lastBody = b;
      doBtn.disabled = r.people === 0 || !r.enough;
      out.innerHTML = r.people === 0
        ? '沒有符合條件的玩家。'
        : `會發給 <b>${r.people}</b> 人，每人 ${coin(b.amount)}，總共 <b>${coin(r.total)}</b>。`
        + (b.source === 'free'
          ? '<br>財源＝直接增發（不動基金會餘額）。'
          : `<br>基金會餘額 ${coin(r.pool)} → ${r.enough ? `發完剩 ${coin(r.pool - r.total)}` : '<b style="color:#ed4245">不夠，請降低金額或改用直接增發</b>'}`)
        + `<br><span style="opacity:.7">例：${r.sample.map(x => UI.esc(x.username || x.user_id)).join('、')}${r.people > r.sample.length ? ' …' : ''}</span>`;
    };
    doBtn.onclick = async () => {
      if (!lastBody) return UI.err('請先試算');
      if (!await UI.confirm('確定執行普發？錢會立刻進入玩家錢包，不能復原。')) return;
      try {
        const r = await POST('/charity-relief', lastBody);
        UI.ok(`已普發給 ${r.people} 人，共 ${r.total.toLocaleString('en-US')}`);
        App.go('charity');
      } catch (e) { UI.err(e.message); }
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
