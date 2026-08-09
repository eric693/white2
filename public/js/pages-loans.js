// ===== 物資貸款：抵押工具／作物／魚借星幣，到期沒收 =====
App.page('loans', {
  title: '物資貸款', sub: '抵押工具、農地作物、魚缸的魚借星幣；還清贖回，到期沒收', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const c = await GET('/loans');
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const ST = { open: '未還清', repaid: '✅ 已還清', defaulted: '❌ 違約沒收' };
    const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—');

    el.innerHTML = `
      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>設定</h3>
        <div class="hint" style="margin-bottom:10px">玩家用 <code>/貸款 金額</code> 借錢，系統自動挑抵押品代管（<b>只收工具、農地／溫室作物、魚缸的魚</b>）。
          工具被押走期間<b>不能採集</b>（需搭配採集頁的「禁止徒手」）、作物收不到、魚不產星幣。
          <code>/還款</code> 全部還清 → 抵押品原封不動還回去；到期沒還 → 沒收抵押品、債務一併結清。</div>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用物資貸款')}</div>
        <div class="form-row">
          <div class="field"><label>抵押率 %（可借 ÷ 抵押品估值）</label><input name="ltv_pct" type="number" min="1" max="100" value="${c.ltv_pct ?? 70}">
            <div class="hint">70％＝估值 10,000 的物資只能借 7,000，還不出來對玩家就是虧的。</div></div>
          <div class="field"><label>單筆上限（0＝不限）</label><input name="max_loan" type="number" min="0" value="${c.max_loan ?? 0}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>期限（天）</label><input name="term_days" type="number" min="1" value="${c.term_days ?? 7}"></div>
          <div class="field"><label>利息 %（借出時就算進應還金額）</label><input name="interest_pct" type="number" min="0" max="100" step="0.5" value="${c.interest_pct ?? 5}"></div>
          <div class="field"><label>同時最多幾筆未還</label><input name="max_open" type="number" min="1" value="${c.max_open ?? 1}"></div>
        </div>
        <div class="field"><label>抵押品挑選順序</label>
          <select name="collateral_order">
            <option value="tool,crop,fish" ${(c.collateral_order||'tool,crop,fish')==='tool,crop,fish'?'selected':''}>工具 → 作物 → 魚（推薦：先押最容易贖回的）</option>
            <option value="crop,fish,tool" ${c.collateral_order==='crop,fish,tool'?'selected':''}>作物 → 魚 → 工具（工具最後才動）</option>
            <option value="fish,crop,tool" ${c.collateral_order==='fish,crop,tool'?'selected':''}>魚 → 作物 → 工具</option>
            <option value="crop" ${c.collateral_order==='crop'?'selected':''}>只收作物</option>
            <option value="tool" ${c.collateral_order==='tool'?'selected':''}>只收工具</option>
          </select>
          <div class="hint">同一類裡面一律「便宜的先押」，盡量少押到貴的東西。</div></div>
        <div class="field">${H.toggle('debtor_only', c.debtor_only, '只有餘額是負數（負債）的人才能貸款')}</div>
        <div class="field"><label>公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">借款與到期沒收都會公告，違約會被大家看到。</div></div>
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
            <td>${l.id}</td><td>${UI.esc(l.username || l.user_id)}</td><td>${coin(l.principal)}</td><td>${coin(l.interest)}</td>
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
