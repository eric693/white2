// ===== 貨幣與玩家（獨立頁）=====
// 以前這塊埋在「釣魚挖礦」頁最底下，每次要調某個人的錢都得整頁滑到最下面。
// 拆成獨立一頁：一進來就是玩家名單（像黑名單那樣直接看到名字），可搜尋、可排序、可直接改錢。
App.page('currency', {
  title: '貨幣與玩家', sub: '所有玩家的餘額一覽，直接搜尋名字就能增減貨幣', module: 'gather',

  async render(el) {
    const [c, players, transfers] = await Promise.all([
      GET('/gather'), GET('/gather-players'), GET('/econ-transfers').catch(() => [])
    ]);
    const coin = (n) => `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')}`;
    const total = players.reduce((a, p) => a + (p.coins || 0), 0);

    let keyword = '';
    let sort = 'coins';

    const rowsHTML = () => {
      const kw = keyword.trim().toLowerCase();
      let list = players.filter(p =>
        !kw || String(p.username || '').toLowerCase().includes(kw) || String(p.user_id).includes(kw));
      list = list.slice().sort((a, b) =>
        sort === 'name' ? String(a.username || '').localeCompare(String(b.username || ''))
          : sort === 'earned' ? (b.total_earned || 0) - (a.total_earned || 0)
            : (b.coins || 0) - (a.coins || 0));
      if (!list.length) return '<tr><td colspan="6" class="empty">找不到符合的玩家</td></tr>';
      return list.map((p, n) => `
        <tr>
          <td>${n + 1}</td>
          <td class="wrap"><strong>${UI.esc(p.username || '未知玩家')}</strong>
            <div style="color:var(--muted);font-size:12px">${UI.esc(p.user_id)}</div></td>
          <td style="white-space:nowrap"><b>${coin(p.coins)}</b></td>
          <td style="white-space:nowrap">${coin(p.total_earned)}</td>
          <td>${p.collected} 種</td>
          <td style="white-space:nowrap">
            <button class="btn tiny secondary" data-coins="${p.user_id}" data-name="${UI.esc(p.username || '')}" data-cur="${p.coins}">增減貨幣</button>
            <button class="btn tiny danger" data-wipe="${p.user_id}" data-name="${UI.esc(p.username || '')}">清空</button>
          </td>
        </tr>`).join('');
    };

    const paint = () => {
      el.querySelector('#plist').innerHTML = rowsHTML();
      bind();
    };

    el.innerHTML = `
      <div class="card" style="max-width:720px" id="cfgwrap">
        <h3>貨幣設定</h3>
        <div class="form-row">
          <div class="field"><label>貨幣名稱</label><input name="currency_name" value="${UI.esc(c.currency_name || '星幣')}"></div>
          <div class="field"><label>貨幣圖示</label><input name="currency_emoji" data-bemoji value="${UI.esc(c.currency_emoji || '🪙')}" style="text-align:center"></div>
          <div class="field"><label>新玩家初始貨幣</label><input name="start_coins" type="number" min="0" value="${c.start_coins || 0}"></div>
        </div>
        <div class="field">${H.toggle('transfer_enabled', c.transfer_enabled, '開放玩家之間互轉貨幣（/轉帳）')}</div>
        <div class="form-row">
          <div class="field"><label>轉帳手續費 %</label><input name="transfer_fee_pct" type="number" min="0" max="100" value="${c.transfer_fee_pct ?? 0}"></div>
          <div class="field"><label>每日轉出上限（0＝不限）</label><input name="transfer_daily_max" type="number" min="0" value="${c.transfer_daily_max ?? 0}"></div>
          <div class="field"><label>單筆最低金額</label><input name="transfer_min" type="number" min="0" value="${c.transfer_min ?? 0}"></div>
        </div>
        <button class="btn" id="savecfg">儲存貨幣設定</button>
        <div class="hint" style="margin-top:8px">其他遊戲參數（冷卻、掉落、商店…）還是在「釣魚挖礦」那一頁。</div>
      </div>

      <div class="card">
        <div class="form-row" style="align-items:flex-end">
          <div class="field"><label>總流通量</label><div style="font-size:22px;font-weight:700">${coin(total)}</div></div>
          <div class="field"><label>玩家數</label><div style="font-size:22px">${players.length}</div></div>
          <div class="field"><label>搜尋玩家（名字或 ID）</label><input id="kw" placeholder="打幾個字就好，不用完整名字"></div>
          <div class="field" style="max-width:180px"><label>排序</label>
            <select id="sort">
              <option value="coins">餘額由多到少</option>
              <option value="earned">累計賺取</option>
              <option value="name">名字</option>
            </select></div>
        </div>
      </div>

      <div class="card">
        <div class="table-wrap"><table class="list">
          <thead><tr><th>#</th><th>玩家</th><th>持有</th><th>累計賺取</th><th>圖鑑</th><th></th></tr></thead>
          <tbody id="plist">${rowsHTML()}</tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">
          「清空」只刪玩家累積的東西（錢包、背包、道具、圖鑑、牧場、農地、任務進度…），
          你設定好的掉落物、商店、配方都會保留。<b>無法復原。</b>
        </div>
      </div>

      <div class="card">
        <h3>最近轉帳</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>從</th><th>給</th><th>金額</th><th>手續費</th></tr></thead>
          <tbody>${(transfers || []).slice(0, 30).map(t => `<tr>
            <td>${UI.esc(t.created_at || '')}</td>
            <td>${UI.esc(t.from_name || t.from_id)}</td>
            <td>${UI.esc(t.to_name || t.to_id)}</td>
            <td>${coin(t.amount)}</td>
            <td>${coin(t.fee)}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">還沒有轉帳紀錄。</td></tr>'}
        </tbody></table></div>
      </div>`;

    H.bindEmojiPickers(el.querySelector('#cfgwrap'));
    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/gather', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存'); App.go('currency');
    };
    el.querySelector('#kw').oninput = (e) => { keyword = e.target.value; paint(); };
    el.querySelector('#sort').onchange = (e) => { sort = e.target.value; paint(); };

    function bind() {
      el.querySelectorAll('[data-coins]').forEach(b => b.onclick = () => {
        UI.modal({
          title: `調整「${b.dataset.name || b.dataset.coins}」的貨幣`,
          bodyHTML: `
            <div class="hint" style="margin-bottom:8px">目前餘額：<b>${coin(b.dataset.cur)}</b></div>
            <div class="field"><label>增減金額（正數＝給，負數＝扣）</label><input name="delta" type="number" placeholder="例如 10000 或 -5000"></div>
            <div class="hint">⚠️ 這是直接印錢／銷毀，不會留下遊戲內的來源紀錄（但後台操作紀錄查得到）。</div>`,
          onOk: async (back) => {
            const delta = parseInt(UI.val(back, 'delta'), 10);
            if (!Number.isFinite(delta) || !delta) { UI.err('請填要增減的金額'); return false; }
            const r = await POST(`/gather-players/${b.dataset.coins}/coins`, { delta });
            UI.ok(`已調整，餘額 ${Number(r.coins).toLocaleString('en-US')}`);
            App.go('currency');
          }
        });
      });
      el.querySelectorAll('[data-wipe]').forEach(b => b.onclick = async () => {
        if (!await UI.confirm(`清空「${b.dataset.name || b.dataset.wipe}」的所有遊戲資料？無法復原。`)) return;
        await DEL('/gather-players/' + b.dataset.wipe);
        UI.ok('已清空'); App.go('currency');
      });
    }
    bind();
  }
});
