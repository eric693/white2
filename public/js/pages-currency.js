// ===== 貨幣與玩家（獨立頁）=====
// 以前這塊埋在「釣魚挖礦」頁最底下，每次要調某個人的錢都得整頁滑到最下面。
// 拆成獨立一頁：一進來就是玩家名單（像黑名單那樣直接看到名字），可搜尋、可排序、可直接改錢。
App.page('currency', {
  title: '貨幣與玩家', sub: '所有玩家的餘額一覽，直接搜尋名字就能增減貨幣', module: 'gather',

  async render(el) {
    const [c, players, transfers, resetGroups, itemList] = await Promise.all([
      GET('/gather'), GET('/gather-players'), GET('/econ-transfers').catch(() => []),
      GET('/gather-reset-groups').catch(() => []), GET('/gather-item-list').catch(() => [])
    ]);
    const coin = (n) => `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')}`;
    const total = players.reduce((a, p) => a + (p.coins || 0), 0);
    // 設施等級一覽：Lv 與「用了幾格 / 總格數」，一眼看得出誰的規模大、誰該課比較多土地稅
    const USED = { field: 'field_plots', greenhouse: 'greenhouse_plots', ranch: 'animals', aquarium: 'fish' };
    const fac = (p, type, emoji) => {
      const f = (p.facilities || {})[type];
      if (!f) return '';
      const usedKey = USED[type];
      const used = usedKey ? p[usedKey] : null;
      return `<span title="${type}">${emoji}Lv${f.tier}${used != null ? `(${used}/${f.slots})` : ''}</span> `;
    };

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
          <td style="font-size:13px;white-space:nowrap">
            ${fac(p, 'field', '🌾')}${fac(p, 'greenhouse', '🏡')}${fac(p, 'ranch', '🐔')}${fac(p, 'aquarium', '🐠')}${fac(p, 'hatch', '🥚')}
          </td>
          <td style="font-size:13px;white-space:nowrap">
            ${p.home_level ? `🏠Lv${p.home_level}` : ''}${p.kitchen_level ? ` 🍳Lv${p.kitchen_level}` : ''}
            ${p.partners ? ` 💞${p.partners}` : ''}
            ${p.shares ? `<br>📈${Number(p.shares).toLocaleString('en-US')} 股` : ''}
          </td>
          <td style="white-space:nowrap">
            ${p.stamina_bonus ? `<b>${p.stamina_bonus > 0 ? '+' : ''}${p.stamina_bonus}</b>` : '<span class="hint">—</span>'}
            <button class="btn tiny secondary" data-stam="${p.user_id}" data-name="${UI.esc(p.username || '')}" data-cur="${p.stamina_bonus || 0}" data-note="${UI.esc(p.stamina_note || '')}">調整</button>
          </td>
          <td style="white-space:nowrap">
            <button class="btn tiny secondary" data-coins="${p.user_id}" data-name="${UI.esc(p.username || '')}" data-cur="${p.coins}">增減貨幣</button>
            <button class="btn tiny secondary" data-give="${p.user_id}" data-name="${UI.esc(p.username || '')}">發素材</button>
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
          <thead><tr><th>#</th><th>玩家</th><th>持有</th><th>累計賺取</th><th>圖鑑</th>
            <th>設施等級<div class="hint" style="font-weight:400;font-size:11px">農地/溫室/牧場/魚缸/孵化</div></th>
            <th>家園·股</th>
            <th>體力上限<div class="hint" style="font-weight:400;font-size:11px">個別加減</div></th><th></th></tr></thead>
          <tbody id="plist">${rowsHTML()}</tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">
          「清空」只刪玩家累積的東西（錢包、背包、道具、圖鑑、牧場、農地、任務進度…），
          你設定好的掉落物、商店、配方都會保留。<b>無法復原。</b>
        </div>
      </div>

      <div class="card">
        <h3>🧹 重置系統</h3>
        <div class="hint" style="margin-bottom:10px">
          勾選要清掉的部分 —— 想整個重來就全勾，只想把股市砍掉重練就只勾股票。
          管理員設定好的內容（掉落物、商店、動物、配方、成就定義…）一律保留。<b>無法復原。</b>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px" id="rsgroups">
          ${resetGroups.map(g => `<label class="switch"><input type="checkbox" data-rs value="${g.key}"> ${UI.esc(g.label)}</label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:flex-end">
          <button class="btn small secondary" id="rsall">全選／全不選</button>
          <div class="field" style="max-width:260px;margin:0"><label>只重置某位玩家（留空＝全服）</label>
            <input id="rsuser" placeholder="貼上 Discord user ID"></div>
          <button class="btn danger" id="rsgo">執行重置</button>
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

    const rsBoxes = () => [...el.querySelectorAll('[data-rs]')];
    el.querySelector('#rsall').onclick = () => {
      const allOn = rsBoxes().every(x => x.checked);
      rsBoxes().forEach(x => { x.checked = !allOn; });
    };
    el.querySelector('#rsgo').onclick = async () => {
      const groups = rsBoxes().filter(x => x.checked).map(x => x.value);
      if (!groups.length) return UI.err('請至少勾選一項');
      const user_id = el.querySelector('#rsuser').value.trim();
      const names = groups.map(g => (resetGroups.find(x => x.key === g) || {}).label).join('、');
      if (!await UI.confirm(`確定要重置：${names}${user_id ? `\n（只針對玩家 ${user_id}）` : '\n（全服所有玩家）'}？無法復原。`)) return;
      const r = await POST('/gather-players/reset', { groups, user_id: user_id || null });
      UI.ok(`已清除 ${Number(r.cleared).toLocaleString('en-US')} 筆`);
      App.go('currency');
    };

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
      el.querySelectorAll('[data-give]').forEach(b => b.onclick = () => {
        // 測試新內容、活動補償都用這個 —— 一次可以發 5 種，數量填負數就是扣回來
        const KINDS = { mine: '⛏️ 礦石', wood: '🪓 木材', forage: '🧺 採集', hunt: '🏹 狩獵', fish: '🎣 魚', farm: '🥚 農牧', craft: '🛠️ 加工品' };
        const optsFor = (sel) => '<option value="">— 不發 —</option>' + Object.entries(KINDS).map(([k, label]) => {
          const list = itemList.filter(it => it.kind === k);
          if (!list.length) return '';
          return `<optgroup label="${label}">` + list.map(it =>
            `<option value="${it.id}" ${it.id == sel ? 'selected' : ''}>${UI.esc((it.emoji || '') + it.name)}（${it.rarity}）</option>`).join('') + '</optgroup>';
        }).join('');
        UI.modal({
          title: `發素材給「${b.dataset.name || b.dataset.give}」`,
          bodyHTML: `
            <div class="hint" style="margin-bottom:8px">
              直接把素材放進玩家背包（測試新玩法、活動補償都用這個）。
              數量填<b>負數</b>就是從背包扣回來，扣不到負數。
            </div>
            ${[0, 1, 2, 3, 4].map(n => `
              <div class="form-row" style="align-items:flex-end">
                <div class="field"><label>${n === 0 ? '素材' : ''}</label><select name="item${n}">${optsFor('')}</select></div>
                <div class="field" style="max-width:130px"><label>${n === 0 ? '數量' : ''}</label>
                  <input name="cnt${n}" type="number" value="${n === 0 ? 100 : ''}" placeholder="例如 100"></div>
              </div>`).join('')}`,
          onOk: async (back) => {
            const items = [];
            for (let n = 0; n < 5; n++) {
              const id = UI.val(back, 'item' + n);
              const cnt = parseInt(UI.val(back, 'cnt' + n), 10);
              if (id && Number.isFinite(cnt) && cnt) items.push({ item_id: Number(id), count: cnt });
            }
            if (!items.length) { UI.err('請至少選一種素材並填數量'); return false; }
            const r = await POST(`/gather-players/${b.dataset.give}/items-bulk`, { items });
            UI.ok(`已發放 ${r.kinds} 種素材`);
          }
        });
      });
      el.querySelectorAll('[data-stam]').forEach(b => b.onclick = () => {
        UI.modal({
          title: `調整「${b.dataset.name || b.dataset.stam}」的每日體力上限`,
          bodyHTML: `
            <div class="hint" style="margin-bottom:8px">
              全服每日體力是 <b>${c.daily_points || 0}</b> 點（釣魚挖礦與逛街共用）。
              這裡是<b>只對這位玩家</b>的永久加減，例如他在別的活動達標就多給幾點。
            </div>
            <div class="field"><label>體力上限 ±（目前 ${b.dataset.cur}）</label>
              <input name="stamina_bonus" type="number" value="${b.dataset.cur}"></div>
            <div class="field"><label>備註（給管理員自己看）</label>
              <input name="note" value="${b.dataset.note}" placeholder="例如：完成另一個遊戲的挑戰"></div>`,
          onOk: async (back) => {
            const body = H.collect(back);
            await POST(`/gather-players/${b.dataset.stam}/stamina`, body);
            UI.ok('已調整'); App.go('currency');
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
