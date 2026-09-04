// ===== 物資貸款：抵押工具／作物／魚借星幣，到期沒收 =====
App.page('loans', {
  help: {
    "intro": "讓玩家用資產抵押借星幣救急。借出的錢從慈善基金會的池子出，還款也回到池子。",
    "steps": [
      "設定可抵押的資產種類與估值成數（可借金額 ＝ 抵押品估值 × 成數）。",
      "設定利息％與還款期限；到期沒還會沒收抵押品。",
      "信用貸款是免抵押的小額借款，另外設單筆上限與同時筆數。"
    ],
    "notes": [
      "開「只限欠債者」時，只有餘額是負數的人能辦物資貸款，避免變成無限套利。",
      "餘額是負數的人不能再辦信用貸款，免得越借越深。",
      "基金會池子不夠時借不出來，這是刻意的，池子空了就要先讓它回血。"
    ]
  },
  title: '物資貸款', sub: '抵押工具、農地作物、魚缸的魚借星幣；還清贖回，到期沒收', module: 'loans',

  async render(el) {
    await H.loadMeta();
    const c = await GET('/loans');
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const ST = { open: '未還清', repaid: '✅ 已還清', defaulted: '❌ 違約沒收' };
    const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—');

    el.innerHTML = `
      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>🏦 銀行設定</h3>
        <div class="hint" style="margin-bottom:10px">
          2026-09 起銀行只有兩項業務：<b>存款</b>與<b>信用貸款</b>。
          物資貸款／物資抵押已停辦——已經借出去的舊貸款照常可以 <code>/還款</code>，
          還清一樣把抵押品還給玩家，但不會再有新的物資貸款。
        </div>

        <h4 style="margin:14px 0 6px">💰 存款</h4>
        <div class="field">${H.toggle('deposit_enabled', c.deposit_enabled ?? 1, '啟用存款（玩家用 /銀行 自由存提）')}</div>
        <div class="form-row">
          <div class="field"><label>年利率 %</label><input name="deposit_apr" type="number" min="0" max="100" step="0.0001" value="${c.deposit_apr ?? 0.0001}">
            <div class="hint">按日累積：每天利息＝存款 × 年利率 ÷ 365。利率很低時每天不到 1 星幣，系統會先累著，<b>滿 1 星幣才入帳</b>，不會被捨去吃掉。<br>存款定位是「保管」不是投資；想調成有感的利率就往上加。</div></div>
          <div class="field"><label>單人存款上限（0＝不限）</label><input name="deposit_max" type="number" min="0" value="${c.deposit_max ?? 0}"></div>
        </div>
        <div class="hint">存提款只是錢換位置，<b>不列入所得</b>，不會被課所得稅。</div>

        <h4 style="margin:18px 0 6px">🪪 信用貸款</h4>
        <div class="field">${H.toggle('credit_enabled', c.credit_enabled ?? 1, '啟用信用貸款（免抵押）')}</div>
        <div class="form-row">
          <div class="field"><label>單筆上限</label><input name="credit_max" type="number" min="1" value="${c.credit_max ?? 50000}"></div>
          <div class="field"><label>利息 %（借出時就算進應還金額）</label><input name="credit_interest_pct" type="number" min="0" max="100" step="0.5" value="${c.credit_interest_pct ?? 15}">
            <div class="hint">免抵押的風險由利息承擔，所以比舊的物資貸款高。</div></div>
        </div>
        <div class="form-row">
          <div class="field"><label>期限（天）</label><input name="credit_term_days" type="number" min="1" value="${c.credit_term_days ?? 7}"></div>
          <div class="field"><label>同時最多幾筆未還</label><input name="credit_max_open" type="number" min="1" value="${c.credit_max_open ?? 1}"></div>
        </div>
        <div class="field">${H.toggle('debtor_only', c.debtor_only, '只有餘額是負數（負債）的人才能貸款')}</div>
        <div class="field"><label>公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">借款與到期沒收都會公告，違約會被大家看到。</div></div>

        <details style="margin-top:14px">
          <summary class="hint">舊制物資貸款設定（已停辦，只影響尚未還清的舊貸款）</summary>
          <div class="form-row" style="margin-top:8px">
            <div class="field"><label>抵押率 %</label><input name="ltv_pct" type="number" min="1" max="100" value="${c.ltv_pct ?? 70}"></div>
            <div class="field"><label>期限（天）</label><input name="term_days" type="number" min="1" value="${c.term_days ?? 7}"></div>
            <div class="field"><label>利息 %</label><input name="interest_pct" type="number" min="0" max="100" step="0.5" value="${c.interest_pct ?? 5}"></div>
          </div>
        </details>

        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="savecfg">儲存設定</button>
          <button class="btn secondary" id="sweep">立即處理到期貸款</button>
        </div>
      </div>

      <div class="card">
        <h3>貸款清單</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>#</th><th>玩家</th><th>借款</th><th>利息</th><th>還欠</th><th>抵押品</th><th>到期</th><th>狀態</th><th></th></tr></thead>
          <tbody>${(c.loans || []).length ? c.loans.map(l => `<tr>
            <td>${l.id}</td><td>${H.who(l.user_id, l.username)}</td><td>${coin(l.principal)}</td><td>${coin(l.interest)}</td>
            <td>${l.status === 'open' ? `<b>${coin(l.owed)}</b>` : coin(l.owed)}</td>
            <td>${(l.collaterals || []).map(x => UI.esc(x.detail)).join('、') || '<span class="hint">已沒收／已贖回</span>'}</td>
            <td>${when(l.due_ms)}</td>
            <td>${ST[l.status] || UI.esc(l.status)}</td>
            <td>${l.status === 'open' ? `<button class="btn tiny secondary" data-forgive="${l.id}">免除</button>` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="9" class="hint">還沒有人貸款。</td></tr>'}</tbody>
        </table></div>
        <div class="hint">「免除」＝債務歸零並把抵押品還給玩家（客服補償用）；原格子被佔走的抵押品會自動折現。</div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/loans', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('loans');
    };
    el.querySelector('#sweep').onclick = async () => {
      if (!await UI.confirm('立即處理所有已到期未還的貸款？會沒收抵押品並通知玩家。')) return;
      const r = await POST('/loans-sweep', {});
      UI.ok(`已處理 ${r.count} 筆`); App.go('loans');
    };
    el.querySelectorAll('[data-forgive]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm(`免除貸款 #${b.dataset.forgive}？債務歸零、抵押品還給玩家。`)) return;
      await POST('/loans-forgive', { id: +b.dataset.forgive });
      UI.ok('已免除'); App.go('loans');
    });
  }
});
