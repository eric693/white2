// ===== 稅金：農地稅／養殖稅／所得稅，定期自動結算 =====
App.page('tax', {
  title: '稅金', sub: '定期課徵農地稅／養殖稅／所得稅，把囤積的星幣抽回去', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [c, periods] = await Promise.all([GET('/tax'), GET('/tax-periods')]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const DOW = ['日', '一', '二', '三', '四', '五', '六'];

    const bracketRow = (b = { over: 0, pct: 5 }) => `
      <tr>
        <td><input class="bk-over" type="number" min="0" value="${b.over ?? 0}" style="width:100%"></td>
        <td><input class="bk-pct" type="number" min="0" max="100" step="0.5" value="${b.pct ?? 0}" style="width:100%"></td>
        <td><button class="btn tiny secondary bk-del">刪除</button></td>
      </tr>`;

    el.innerHTML = `
      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用稅金系統（關閉＝完全不課稅）')}</div>
        <div class="form-row">
          <div class="field"><label>課稅頻率</label>
            <select name="period">
              <option value="week" ${c.period === 'week' ? 'selected' : ''}>每週</option>
              <option value="day" ${c.period === 'day' ? 'selected' : ''}>每日</option>
              <option value="month" ${c.period === 'month' ? 'selected' : ''}>每月</option>
            </select></div>
          <div class="field"><label>每週幾課（頻率＝每週時有效）</label>
            <select name="dow">${DOW.map((d, i) => `<option value="${i}" ${(c.dow ?? 1) === i ? 'selected' : ''}>星期${d}</option>`).join('')}</select></div>
          <div class="field"><label>每月幾號（頻率＝每月時有效）</label><input name="dom" type="number" min="1" max="28" value="${c.dom ?? 1}"></div>
          <div class="field"><label>結算時間（台北）</label><input name="run_time" value="${c.run_time || '09:00'}" placeholder="09:00"></div>
        </div>
        <div class="field"><label>稅收公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">會公布本期總稅收與納稅大戶排行。</div></div>
        <div class="form-row">
          <div class="field">${H.toggle('dm_bill', c.dm_bill, '私訊每個人自己的稅單')}</div>
          <div class="field"><label>稅額低於多少就免徵</label><input name="min_total" type="number" min="0" value="${c.min_total ?? 1}">
            <div class="hint">避免對只有幾十塊的新手洗版。</div></div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>💰 所得稅（對「目前餘額」累進課徵）</h3>
        <div class="field">${H.toggle('income_enabled', c.income_enabled, '開徵所得稅')}</div>
        <div class="form-row">
          <div class="field"><label>免稅額</label><input name="income_free" type="number" min="0" value="${c.income_free ?? 100000}">
            <div class="hint">餘額低於這個數字完全不課，超過的部分才進級距。</div></div>
          <div class="field"><label>單次稅額上限（占餘額 %）</label><input name="income_max_pct" type="number" min="0" max="100" value="${c.income_max_pct ?? 50}">
            <div class="hint">三稅合計不會超過餘額的這個比例，避免一次被抄家。</div></div>
        </div>
        <div class="table-wrap"><table class="list" id="bktable">
          <thead><tr><th>超過這個金額的部分</th><th>課 %</th><th style="width:80px"></th></tr></thead>
          <tbody>${(c.brackets || []).map(bracketRow).join('')}</tbody>
        </table></div>
        <button class="btn small secondary" id="addbk" style="margin-top:8px">＋ 新增級距</button>
        <div class="hint" style="margin-top:6px">跟真的所得稅一樣是<b>分段課</b>：例如「超過 50 萬課 10%」只對第 50 萬以上的那一段課，不是整筆跳級。</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🌾 農地稅（依「種著作物的格數」課，空地不課）</h3>
        <div class="field">${H.toggle('land_enabled', c.land_enabled, '開徵農地稅')}</div>
        <div class="form-row">
          <div class="field"><label>每格農地</label><input name="land_field" type="number" min="0" value="${c.land_field ?? 50}"></div>
          <div class="field"><label>每格溫室</label><input name="land_greenhouse" type="number" min="0" value="${c.land_greenhouse ?? 120}"></div>
          <div class="field"><label>前幾格免稅</label><input name="land_free" type="number" min="0" value="${c.land_free ?? 2}"></div>
        </div>
        <div class="hint">只算「正在種東西」的格子，所以放著不採收＝一直被課稅，會逼玩家把作物收掉。</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🐄 養殖稅（牧場動物＋魚缸的魚）</h3>
        <div class="field">${H.toggle('breed_enabled', c.breed_enabled, '開徵養殖稅')}</div>
        <div class="form-row">
          <div class="field"><label>每隻牧場動物</label><input name="breed_animal" type="number" min="0" value="${c.breed_animal ?? 80}"></div>
          <div class="field"><label>每條 SSR 魚</label><input name="breed_fish" type="number" min="0" value="${c.breed_fish ?? 200}"></div>
          <div class="field"><label>前幾隻／條免稅</label><input name="breed_free" type="number" min="0" value="${c.breed_free ?? 1}"></div>
        </div>

        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="savecfg">儲存設定</button>
          <button class="btn secondary" id="dryrun">試算（不扣款）</button>
          <button class="btn secondary" id="runnow">立即課徵一期</button>
        </div>
        <div class="hint" style="margin-top:6px">試算與立即課徵都是用<b>目前儲存的設定</b>，改完記得先儲存。</div>
      </div>

      <div class="card">
        <h3>稅收紀錄</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>期間</th><th>人數</th><th>實收</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th></th></tr></thead>
          <tbody>
            ${periods.length ? periods.map(p => `<tr>
              <td>${UI.esc(p.period)}</td><td>${p.people}</td><td>${coin(p.paid)}</td>
              <td>${coin(p.income)}</td><td>${coin(p.land)}</td><td>${coin(p.breed)}</td>
              <td><button class="btn tiny secondary" data-period="${UI.esc(p.period)}">明細</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="hint">還沒課過稅。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    const collectCfg = () => {
      const body = H.collect(el.querySelector('#cfgwrap'));
      body.brackets = [...el.querySelectorAll('#bktable tbody tr')].map(tr => ({
        over: +tr.querySelector('.bk-over').value || 0,
        pct: +tr.querySelector('.bk-pct').value || 0
      })).filter(b => b.pct > 0);
      return body;
    };

    const bindDel = () => el.querySelectorAll('.bk-del').forEach(b => b.onclick = () => b.closest('tr').remove());
    bindDel();
    el.querySelector('#addbk').onclick = () => {
      el.querySelector('#bktable tbody').insertAdjacentHTML('beforeend', bracketRow());
      bindDel();
    };

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/tax', collectCfg());
      UI.ok('已儲存設定'); App.go('tax');
    };

    const showResult = (r) => {
      const rows = r.top.map(t => `<tr><td>${UI.esc(t.username || t.user_id)}</td><td>${coin(t.balance)}</td>
        <td>${coin(t.income)}</td><td>${coin(t.land)}</td><td>${coin(t.breed)}</td><td><b>${coin(t.total)}</b></td></tr>`).join('');
      UI.modal({
        title: r.dryRun ? `試算結果（未扣款）` : `已課徵 ${r.period}`,
        bodyHTML: `<p>共 <b>${r.people}</b> 人要繳，總額 <b>${coin(r.sum)}</b>${r.dryRun ? '（僅試算）' : ''}</p>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>玩家</th><th>餘額</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th>合計</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="hint">沒有人要繳稅。</td></tr>'}</tbody></table></div>`,
        okText: '關閉'
      });
    };

    el.querySelector('#dryrun').onclick = async () => showResult(await POST('/tax-run', { dry: '1' }));
    el.querySelector('#runnow').onclick = async () => {
      if (!await UI.confirm('立即課徵一期？會真的從玩家錢包扣款並公告，無法復原。')) return;
      const r = await POST('/tax-run', {});
      UI.ok('已完成課徵'); showResult(r); App.go('tax');
    };

    el.querySelectorAll('[data-period]').forEach(b => b.onclick = async () => {
      const rows = await GET('/tax-records?period=' + encodeURIComponent(b.dataset.period));
      UI.modal({
        title: `${b.dataset.period} 稅單明細`,
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>當時餘額</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th>應繳</th><th>實繳</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${UI.esc(r.username || r.user_id)}</td><td>${coin(r.balance)}</td>
            <td>${coin(r.income_tax)}</td><td>${coin(r.land_tax)}</td><td>${coin(r.breed_tax)}</td>
            <td>${coin(r.total)}</td><td>${r.paid < r.total ? `<span style="color:#e74c3c">${coin(r.paid)}</span>` : coin(r.paid)}</td>
          </tr>`).join('')}</tbody></table></div>`,
        okText: '關閉'
      });
    });
  }
});
