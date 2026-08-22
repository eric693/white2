// ===== 基金會拍賣會（後台）=====
// 沿用 charity 權限：拍賣是基金會的活動，成交金額與手續費都回到基金會。
App.page('auction', {
  title: '拍賣會', sub: '基金會限時競標：特殊家具、珍稀寵物、成就稱號；手續費回基金會', module: 'charity',

  async render(el) {
    await H.loadMeta();
    const [c, rows, targets] = await Promise.all([
      GET('/auction-config'), GET('/auctions'), GET('/auction-targets')
    ]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const when = (ms) => ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const KINDS = { furniture: '🛋️ 家具', pet: '🐾 寵物', title: '🏅 成就', item: '📦 物品' };
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
        <div class="field">${H.toggle('to_pool', c.to_pool, '成交金額全數進基金會（建議開啟）')}
          <div class="hint">出價當下就從玩家錢包扣走、被超越自動退回。開啟這個＝得標金進基金會池；關閉＝直接銷毀（更強的回收）。</div></div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🔨 拍賣場次</h3>
          <button class="btn small" id="add">＋ 開一場拍賣</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>標的</th><th>類別</th><th>起標／直購</th><th>另收材料</th><th>時間</th><th>狀態</th><th>目前／成交</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map(r => {
      const top = (r.top_bids || [])[0];
      return `<tr>
              <td>${UI.esc(refName(r))}${r.kind === 'item' && r.qty > 1 ? ` ×${r.qty}` : ''}</td>
              <td>${KINDS[r.kind] || r.kind}</td>
              <td>${coin(r.start_price)}${r.buyout_price ? `<div class="hint" style="font-size:12px">直購 ${coin(r.buyout_price)}</div>` : ''}</td>
              <td class="wrap" style="font-size:13px">${parseMats(r.mats_cost).map(m => `${UI.esc(m.item)}×${m.count}`).join('、') || '—'}</td>
              <td style="white-space:nowrap;font-size:13px">${when(r.start_ts)}<br>～ ${when(r.end_ts)}</td>
              <td>${STATUS[r.status] || r.status}</td>
              <td>${r.status === 'ended'
          ? `${coin(r.final_price)}<div class="hint" style="font-size:12px">${UI.esc(r.winner_name)}｜手續費 ${coin(r.fee)}</div>`
          : (top ? `${coin(top.amount)}<div class="hint" style="font-size:12px">${UI.esc(top.username)}｜${r.bids} 次</div>` : '—')}</td>
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
    // datetime-local 需要本地時間字串
    const toLocalInput = (ms) => {
      if (!ms) return '';
      const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 16);
    };

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
        <div class="field"><label>開始時間（留空＝馬上）</label><input name="start_at" type="datetime-local" value="${toLocalInput(r.start_ts)}"></div>
        <div class="field"><label>持續（小時）</label><input name="duration_h" type="number" min="0.25" step="0.25" value="${r.end_ts && r.start_ts ? ((r.end_ts - r.start_ts) / 3600000).toFixed(2) : 24}"></div>
      </div>
      <div class="hint">出價會當場鎖款、被超越自動退回；結束前 ${c.antisnipe_min ?? 3} 分鐘內有人出價會自動延長 ${c.extend_min ?? 3} 分鐘。</div>`;

    // 標的下拉要跟著「拍什麼」連動
    const bindRefSelect = (back, r = {}) => {
      const kindSel = back.querySelector('#kindsel');
      const refSel = back.querySelector('#refsel');
      const qtyWrap = back.querySelector('#qtywrap');
      const fill = () => {
        const k = kindSel.value;
        refSel.innerHTML = (targets[k] || []).map(t =>
          `<option value="${t.id}" ${t.id == r.ref_id ? 'selected' : ''}>${UI.esc((t.emoji || '') + t.name)}${t.price ? `（原價 ${t.price}）` : ''}</option>`).join('');
        qtyWrap.style.display = k === 'item' ? '' : 'none';
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
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => open(rows.find(x => x.id == b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('取消這場拍賣？還鎖著的競標金會全額退回出價者。')) return;
      try { const r = await DEL('/auctions/' + b.dataset.del); UI.ok(`已取消，退回 ${r.refunded} 筆競標金`); App.go('auction'); }
      catch (e) { UI.err(e.message); }
    });
  }
});
