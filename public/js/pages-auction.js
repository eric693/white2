// ===== 基金會拍賣會（後台）=====
// 沿用 charity 權限：拍賣是基金會的活動，成交金額與手續費都回到基金會。
App.page('auction', {
  help: {
    "intro": "限時競標稀有物品（特殊家具、珍稀寵物、成就稱號），手續費回到基金會。",
    "steps": [
      "建立拍賣品，設起標價、加價幅度與結標時間。",
      "需要時指定「參加資格身分組」，只有擁有該身分組的人能出價。",
      "結標後系統自動扣款並發給得標者。"
    ],
    "notes": [
      "出價會即時凍結玩家的星幣，被超越後自動退回。",
      "參加資格存的是 Discord 身分組 id，可以是任何身分組——基金會捐款達標給的身分組、活動限定、贊助者、VIP 都行。留空＝不限。",
      "另一種資格是「累計捐款門檻」：填了就只有用 /捐款 捐給基金會、累計達這個金額的玩家能參加，不必先做「捐款達標發身分組」那一套，門檻要改直接改數字。兩個都設＝兩個條件都要滿足；不符資格的玩家會看到自己還差多少。",
      "開始時間只給選到整點，因為拍賣是整點結算。"
    ]
  },
  title: '拍賣會', sub: '基金會限時競標：特殊家具、珍稀寵物、成就稱號；手續費回基金會', module: 'charity',

  async render(el) {
    await H.loadMeta();
    const [c, rows, targets] = await Promise.all([
      GET('/auction-config'), GET('/auctions'), GET('/auction-targets')
    ]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const when = (ms) => ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const KINDS = { furniture: '🛋️ 家具', pet: '🐾 寵物', title: '🏅 成就', item: '📦 物品（含素材）', plot: '🌱 格子（農地／溫室／牧場／孵化室／魚缸）' };
    const STATUS = {
      scheduled: '<span class="tag">排程中</span>', live: '<span class="tag ok">競標中</span>',
      ended: '<span class="tag primary">已成交</span>', failed: '<span class="tag">流標</span>',
      cancelled: '<span class="tag">已取消</span>'
    };
    const refName = (r) => {
      const list = targets[r.kind] || [];
      const t = list.find(x => x.id == r.ref_id);
      return r.title || (t ? (t.emoji || '') + t.name : `#${r.ref_id}`);
    };
    const parseMats = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

    el.innerHTML = `
      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用拍賣會（關閉＝排程中的場次不會開標）')}</div>
        <div class="field"><label>拍賣公告頻道</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">開標會在這裡發一則帶「出價」按鈕的公告，有人出價就即時更新，結標再發成交公告。</div></div>
        <div class="form-row">
          <div class="field"><label>成交手續費 %（進基金會）</label><input name="fee_pct" type="number" min="0" max="50" step="0.5" value="${c.fee_pct ?? 5}"></div>
          <div class="field"><label>最低加價 %</label><input name="min_inc_pct" type="number" min="0" value="${c.min_inc_pct ?? 5}"></div>
          <div class="field"><label>最低加價（絕對值）</label><input name="min_inc" type="number" min="0" value="${c.min_inc ?? 100}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>防狙擊：結束前幾分鐘內出價就延長</label><input name="antisnipe_min" type="number" min="0" value="${c.antisnipe_min ?? 3}"></div>
          <div class="field"><label>每次延長幾分鐘</label><input name="extend_min" type="number" min="0" value="${c.extend_min ?? 3}"></div>
          <div class="field"><label>單次出價上限＝身家的 %（0＝不限）</label><input name="max_bid_pct" type="number" min="0" max="100" value="${c.max_bid_pct ?? 0}"></div>
        </div>
        <div class="field">${H.toggle('to_pool', c.to_pool, '成交金額（扣掉手續費的部分）也進基金會')}
          <div class="hint">出價當下就從玩家錢包扣走、被超越自動退回。<b>手續費一律進基金會</b>；剩下的部分：
            開啟＝也進基金會池（之後透過普發流回玩家）；關閉＝直接銷毀（通膨回收更強，適合星幣過多時）。</div></div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🔨 拍賣場次</h3>
          <div style="display:flex;gap:6px">
            <button class="btn small secondary" id="clr">🧹 清除已結束</button>
            <button class="btn small" id="add">＋ 開一場拍賣</button>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>標的</th><th>類別</th><th>起標／直購</th><th>另收材料</th><th>時間</th><th>狀態</th><th>目前／成交</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map(r => {
      const top = (r.top_bids || [])[0];
      return `<tr>
              <td>${UI.esc(refName(r))}${(r.kind === 'item' || r.kind === 'plot') && r.qty > 1 ? ` ×${r.qty}` : ''}</td>
              <td>${KINDS[r.kind] || r.kind}</td>
              <td>${coin(r.start_price)}${r.buyout_price ? `<div class="hint" style="font-size:12px">直購 ${coin(r.buyout_price)}</div>` : ''}</td>
              <td class="wrap" style="font-size:13px">${parseMats(r.mats_cost).map(m => `${UI.esc(m.item)}×${m.count}`).join('、') || '—'}</td>
              <td style="white-space:nowrap;font-size:13px">${when(r.start_ts)}<br>～ ${when(r.end_ts)}</td>
              <td>${STATUS[r.status] || r.status}</td>
              <td>${r.status === 'ended'
          ? `${coin(r.final_price)}<div class="hint" style="font-size:12px">${UI.esc(r.winner_name)}｜手續費 ${coin(r.fee)}</div>`
          : (top ? `${coin(top.amount)}<div class="hint" style="font-size:12px">${H.who(top.user_id, top.username)}｜${r.bids} 次</div>` : '—')}</td>
              <td>${['ended', 'cancelled'].includes(r.status) ? ''
          : `<button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                   <button class="btn tiny danger" data-del="${r.id}">取消</button>`}</td>
            </tr>`;
    }).join('') : '<tr><td colspan="8" class="hint">還沒開過拍賣。</td></tr>'}
          </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          取消場次會把還鎖著的競標金<strong>全額退回</strong>。已經有人出價之後，標的與價格就鎖住不能改（避免拿玩家的錢當人質），只能改說明與結束時間。
        </div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/auction-config', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存'); App.go('auction');
    };

    // ---- 材料附加成本（給只能賣錢的素材一個出海口）----
    const matRows = (list = [], n = 3) => {
      const opts = (sel) => '<option value="">— 無 —</option>' + targets.items_by_name.map(it =>
        `<option value="${UI.esc(it.name)}" ${it.name === sel ? 'selected' : ''}>${UI.esc((it.emoji || '') + it.name)}</option>`).join('');
      return Array.from({ length: n }, (_, i) => {
        const m = list[i] || {};
        return `<div class="form-row" style="align-items:flex-end">
          <div class="field"><label>${i === 0 ? '得標另收的材料（選「無」＝只收星幣）' : ''}</label>
            <select name="mat_item${i}">${opts(m.item)}</select></div>
          <div class="field" style="max-width:120px"><label>${i === 0 ? '數量' : ''}</label>
            <input name="mat_count${i}" type="number" min="1" value="${m.count || ''}"></div>
        </div>`;
      }).join('');
    };
    const collectMats = (back, n = 3) => {
      const o = [];
      for (let i = 0; i < n; i++) {
        const item = UI.val(back, 'mat_item' + i);
        const count = parseInt(UI.val(back, 'mat_count' + i), 10);
        if (item && count > 0) o.push({ item, count });
      }
      return o;
    };
    // 拍賣是整點開場的，時間只給選到「時」——分鐘填了也沒有意義，反而容易填錯
    const toDateInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const toHourInput = (ms) => (ms ? String(new Date(ms).getHours()) : '');

    const form = (r = {}) => `
      <div class="form-row">
        <div class="field"><label>拍什麼</label><select name="kind" id="kindsel">
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === r.kind ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label>標的</label><select name="ref_id" id="refsel"></select></div>
        <div class="field" id="qtywrap" style="max-width:120px"><label>數量</label><input name="qty" type="number" min="1" value="${r.qty || 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>顯示名稱（留空＝用標的物名稱）</label><input name="title" value="${UI.esc(r.title || '')}"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="field"><label>介紹文（拍賣公告會顯示）</label><textarea name="description" rows="2">${UI.esc(r.description || '')}</textarea></div>
      <div class="field"><label>配圖網址（可留空）</label><input name="image_url" value="${UI.esc(r.image_url || '')}"></div>
      <div class="form-row">
        <div class="field"><label>起標價</label><input name="start_price" type="number" min="0" value="${r.start_price ?? 10000}"></div>
        <div class="field"><label>直接買下的價格（0＝不開放）</label><input name="buyout_price" type="number" min="0" value="${r.buyout_price ?? 0}"></div>
      </div>
      ${matRows(parseMats(r.mats_cost))}
      <div class="form-row">
        <div class="field"><label>開始時間（只選整點，留空＝馬上）</label>
          <div style="display:flex;gap:6px">
            <input name="start_date" type="date" style="flex:1" value="${toDateInput(r.start_ts)}">
            <select name="start_hour" style="width:110px">
              <option value="">時</option>
              ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${String(h) === toHourInput(r.start_ts) ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
            </select>
          </div></div>
        <div class="field"><label>持續（小時）</label><input name="duration_h" type="number" min="0.25" step="0.25" value="${r.end_ts && r.start_ts ? ((r.end_ts - r.start_ts) / 3600000).toFixed(2) : 24}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>參加資格：累計捐款門檻（星幣，0＝不限）</label>
          <input name="require_donate" type="number" min="0" value="${r.require_donate || 0}">
          <div class="hint">填了就只有「用 /捐款 捐給基金會、累計達這個金額」的玩家能參加。跟下面的身分組同時設＝兩個條件都要滿足。</div></div>
        <div class="field"><label>參加資格（身分組）</label>${H.roleSelect('require_role', (r.require_role || '').split(',')[0] || '', { emptyLabel: '— 不限，所有人都能出價 —' })}
          <div class="hint">只有這個身分組的人能參加。<b>不限定於基金會</b>——想用捐款者、贊助者、活動限定或任何身分組都可以，換一個就好。管理員一律不受限。</div></div>
        <div class="field"><label>沒有資格的人</label>
          <select name="require_mode">
            <option value="bid" ${(r.require_mode || 'bid') === 'bid' ? 'selected' : ''}>可以觀看，但不能出價</option>
            <option value="view" ${r.require_mode === 'view' ? 'selected' : ''}>禁止進入（連這場拍賣都看不到）</option>
          </select></div>
      </div>
      <div class="hint">出價會當場鎖款、被超越自動退回；結束前 ${c.antisnipe_min ?? 3} 分鐘內有人出價會自動延長 ${c.extend_min ?? 3} 分鐘。</div>`;

    // 標的下拉要跟著「拍什麼」連動
    const bindRefSelect = (back, r = {}) => {
      const kindSel = back.querySelector('#kindsel');
      const refSel = back.querySelector('#refsel');
      const qtyWrap = back.querySelector('#qtywrap');
      const fill = () => {
        const k = kindSel.value;
        // enabled=0 ＝ 平常買不到／不會掉落，標成「拍賣限定」讓管理員一眼看出獨家標的
        refSel.innerHTML = (targets[k] || []).map(t =>
          `<option value="${t.id}" ${t.id == r.ref_id ? 'selected' : ''}>${UI.esc((t.emoji || '') + t.name)}${
            t.enabled === 0 ? '　★拍賣限定' : (t.price ? `（原價 ${t.price}）` : '')}</option>`).join('');
        qtyWrap.style.display = (k === 'item' || k === 'plot') ? '' : 'none';
      };
      kindSel.onchange = fill;
      fill();
    };

    const open = (r = {}) => {
      UI.modal({
        title: r.id ? '編輯拍賣場次' : '開一場拍賣',
        bodyHTML: form(r),
        onOk: async (back) => {
          const b = H.collect(back);
          b.mats_cost = collectMats(back);
          if (b.start_date && b.start_hour === '') { UI.err('請選開始的整點時間'); return false; }
          if (!b.start_date && b.start_hour !== '') { UI.err('請選開始日期'); return false; }
          // 後端吃的是 start_at（可被 Date.parse 解析），這裡組成本地整點時間
          b.start_at = b.start_date ? `${b.start_date}T${String(parseInt(b.start_hour, 10)).padStart(2, '0')}:00` : '';
          delete b.start_date; delete b.start_hour;
          try {
            if (r.id) { const out = await PUT('/auctions/' + r.id, b); if (out.locked) UI.ok('已有人出價，價格與標的維持原樣'); }
            else await POST('/auctions', b);
          } catch (e) { UI.err(e.message); return false; }
          UI.ok('已儲存'); App.go('auction');
        }
      });
      setTimeout(() => {
        const back = document.querySelector('.modal-back:last-of-type');
        if (back) bindRefSelect(back, r);
      }, 0);
    };

    el.querySelector('#add').onclick = () => open();
    el.querySelector('#clr').onclick = async () => {
      if (!await UI.confirm('清除所有「已成交／流標／已取消」的場次？進行中與排程中的不會動，錢在成交或取消時就已經結清，這裡刪的只是歷史列表。')) return;
      const out = await DEL('/auctions-ended');
      UI.ok(out.removed ? `已清除 ${out.removed} 場` : '沒有已結束的場次'); App.go('auction');
    };
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => open(rows.find(x => x.id == b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('取消這場拍賣？還鎖著的競標金會全額退回出價者。')) return;
      try { const r = await DEL('/auctions/' + b.dataset.del); UI.ok(`已取消，退回 ${r.refunded} 筆競標金`); App.go('auction'); }
      catch (e) { UI.err(e.message); }
    });
  }
});
