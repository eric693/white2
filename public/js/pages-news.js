// ===== 財經新聞（獨立頁面）=====
// 為什麼要從股市頁拆出來：新聞掌管的是「全服所有物品的賣價 ＋ 股價」，
// 權責比其他任何一頁都大，所以給它自己的鑰匙（news），可以單獨交給某個管理員，
// 而那個人不會同時拿到股票掛牌、參數與成交紀錄。
App.page('news', {
  title: '財經新聞', sub: '快報會改變全服物價與股價 —— 這一頁掌管所有東西的價錢', module: 'news',

  async render(el) {
    await H.loadMeta();
    const [c, news, mods, targets] = await Promise.all([
      GET('/market'), GET('/market-news'), GET('/market-modifiers'), GET('/market-targets')
    ]);
    const when = (ms) => new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const hhmm = (ms) => new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
    const SCOPES = { all: '🌐 全部物品', crop: '🌾 菜價（種植產物）', ranch: '🥚 副產品（牧場產物）', kind: '⛏️ 某類採集', item: '📦 單一物品' };

    el.innerHTML = `
      <div class="card" style="max-width:760px" id="cfgwrap">
        <h3>新聞開關</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用財經新聞快報（新聞會改變物品賣價）')}</div>
        <div class="hint" style="margin:6px 0 14px">
          關掉之後所有物品都是原價，已排程的快報也不會生效。
          新聞的<strong>股價</strong>效果另外還要「股市」那一頁有開啟股市才會套用。
        </div>
        <div class="field"><label>快報發布頻道</label>${H.chanSelect('news_channel', c.news_channel)}</div>

        <h3 style="margin-top:18px">物價倍率護欄</h3>
        <div class="form-row">
          <div class="field"><label>賣價倍率下限 %</label><input name="mult_floor_pct" type="number" min="1" max="100" value="${c.mult_floor_pct ?? 40}"></div>
          <div class="field"><label>賣價倍率上限 %</label><input name="mult_ceil_pct" type="number" min="100" value="${c.mult_ceil_pct ?? 250}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">多則新聞同時生效時倍率會相乘，這兩個值是最後的硬夾限，防止疊加失控。</div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">📰 財經快報</h3>
          <div style="display:flex;gap:6px">
            <button class="btn small secondary" id="clearnews">🧹 清除已結束</button>
            <button class="btn small" id="addnews">＋ 發布快報</button>
          </div>
        </div>
        <div class="hint" style="margin-top:6px">一則快報可以同時影響物價（賣價倍率）與股價，效果在你設定的「時段內」持續（每小時結算都套用）。</div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>標題</th><th>影響</th><th>生效時段</th><th>狀態</th><th>發布者</th><th></th></tr></thead>
          <tbody>
            ${news.length ? news.map(n => {
      const dur = Math.max(1, n.duration_h || 6) * 3600000;
      const ended = n.applied && ((n.effect_ts || 0) + dur) < Date.now();
      const slot = n.effect_ts
        ? `${when(n.effect_ts)} ～ ${hhmm(n.effect_ts + dur)}`
        : '發布後立即生效';
      const left = (!n.applied && n.effect_ts > Date.now())
        ? `<div class="hint" style="font-size:12px">還有 ${Math.max(1, Math.round((n.effect_ts - Date.now()) / 60000))} 分開始</div>`
        : '';
      let fx = []; let sf = [];
      try { fx = JSON.parse(n.effects || '[]'); } catch (e) { fx = []; }
      try { sf = JSON.parse(n.stock_fx || '[]'); } catch (e) { sf = []; }
      const fxText = [
        ...fx.map(f => `${(f.mult_pct >= 100) ? '📈' : '📉'} ${SCOPES[f.scope] || f.scope} ${f.mult_pct >= 100 ? '+' : ''}${f.mult_pct - 100}%（×${(f.mult_pct / 100).toFixed(2)}）`),
        ...sf.map(f => {
          const s = targets.symbols.find(x => x.id == f.symbol_id);
          return `${f.impact_pct >= 0 ? '📈' : '📉'} ${s ? s.name : '#' + f.symbol_id} ${f.impact_pct >= 0 ? '+' : ''}${f.impact_pct}%`;
        })
      ].join('<br>');
      return `<tr>
              <td style="max-width:240px">${UI.esc(n.headline)}</td>
              <td style="font-size:13px">${fxText || '—'}</td>
              <td style="white-space:nowrap">${slot}<div class="hint" style="font-size:12px">共 ${n.duration_h} 小時</div>${left}</td>
              <td>${ended ? '<span class="tag">已結束</span>' : (n.applied ? (n.announced ? '<span class="tag ok">生效中·已發布</span>' : '<span class="tag ok">生效中</span>') : '<span class="tag">排程中</span>')}</td>
              <td>${UI.esc(n.created_by || '')}</td>
              <td><button class="btn tiny secondary" data-dnews="${n.id}">撤銷</button></td>
            </tr>`;
    }).join('') : '<tr><td colspan="6" class="hint">還沒有發過快報。</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>⏳ 目前生效中的行情倍率</h3>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>來源</th><th>影響範圍</th><th>倍率</th><th>結束時間</th><th></th></tr></thead>
          <tbody>
            ${mods.length ? mods.map(m => {
      let what = SCOPES[m.scope] || m.scope;
      if (m.scope === 'item') {
        const it = targets.items.find(x => x.id == m.scope_key);
        what = it ? `📦 ${it.emoji || ''}${it.name}` : `📦 #${m.scope_key}`;
      } else if (m.scope === 'kind') {
        const k = targets.kinds.find(x => x.key === m.scope_key);
        what = k ? k.label : m.scope_key;
      }
      return `<tr>
              <td>${UI.esc(m.headline || m.label || '—')}</td>
              <td>${what}</td>
              <td>${(m.mult_pct >= 100) ? '📈' : '📉'} ${m.mult_pct >= 100 ? '+' : ''}${m.mult_pct - 100}%　×${(m.mult_pct / 100).toFixed(2)}</td>
              <td>${when(m.end_ts)}</td>
              <td><button class="btn tiny secondary" data-dmod="${m.id}">提前結束</button></td>
            </tr>`;
    }).join('') : '<tr><td colspan="5" class="hint">目前市場平靜，所有物品都是原價。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/market', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('news');
    };

    // ---- 發布快報 ----
    const effectRow = (idx) => `
      <div class="form-row" data-fx="${idx}" style="align-items:flex-end">
        <div class="field"><label>影響範圍</label>
          <select name="scope${idx}" data-scope="${idx}">
            <option value="">— 不使用 —</option>
            ${Object.entries(SCOPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></div>
        <div class="field" data-key="${idx}" style="display:none"><label>指定目標</label>
          <select name="scope_key${idx}"></select></div>
        <div class="field"><label>賣價漲跌 %</label><input name="mult${idx}" type="number" min="-90" max="400" step="5" value="0" placeholder="+30 ＝ 漲三成"></div>
      </div>`;

    const stockRow = (idx, symsOpt) => `
      <div class="form-row" style="align-items:flex-end">
        <div class="field"><label>股票</label>
          <select name="sym${idx}"><option value="">— 不使用 —</option>${symsOpt}</select></div>
        <div class="field"><label>下一盤衝擊 %</label><input name="imp${idx}" type="number" min="-50" max="50" value="0"></div>
        <div class="field"><label>波動倍率 %</label><input name="vm${idx}" type="number" min="100" max="400" value="100"></div>
      </div>`;

    el.querySelector('#addnews').onclick = () => {
      const symsOpt = targets.symbols.map(s => `<option value="${s.id}">${UI.esc((s.emoji || '') + s.name)}（${UI.esc(s.code)}）</option>`).join('');
      UI.modal({
        title: '發布財經快報', okText: '發布',
        bodyHTML: `
          <div class="field"><label>標題</label><input name="headline" placeholder="🥚 蛋雞流感席捲南區牧場"></div>
          <div class="field"><label>內文</label><textarea name="body" rows="3" placeholder="產蛋量預估下滑三成，蛋商已開始搶貨。"></textarea></div>
          <div class="form-row">
            <div class="field"><label>開始時間（幾點播報，留空＝馬上）</label><input name="start_at" type="datetime-local"></div>
            <div class="field"><label>持續（小時）</label><input name="duration_h" type="number" min="1" max="168" value="3"></div>
          </div>
          <div class="hint">例：開始 12:00、持續 3 小時 → 12:00～15:00 這段時間，選的股票<strong>每小時都朝設定方向漲/跌</strong>，物價倍率也維持。</div>
          <div class="field"><label>配圖網址（可留空）</label><input name="image_url" placeholder="https://…"></div>
          <h4 style="margin:14px 0 4px">物價影響（賣出價，整段時間有效）</h4>
          ${[0, 1, 2].map(effectRow).join('')}
          <h4 style="margin:14px 0 4px">股價影響（每小時結算的漲跌 %，整段時間持續）</h4>
          ${[0, 1].map(i => stockRow(i, symsOpt)).join('')}
          <div class="hint" style="margin-top:8px">物價與股價<strong>都填「漲跌 %」</strong>：<strong>+30</strong> ＝ 漲三成、<strong>-30</strong> ＝ 跌三成、<strong>0</strong> ＝ 不使用。物價效果整段時間維持；股價的 % 是<strong>每小時</strong>朝該方向走（受漲跌停限制）。長期漲跌都要有，只發利多等於印鈔。</div>`,
        onOk: async (back) => {
          const v = (n) => UI.val(back, n);
          const effects = [];
          for (const i of [0, 1, 2]) {
            const scope = v('scope' + i);
            if (!scope) continue;
            const delta = parseInt(v('mult' + i), 10);
            if (!Number.isFinite(delta) || delta === 0) continue;
            if (delta <= -100) { UI.err('賣價漲跌不能低於 -90%（賣價不能歸零或變負）'); return false; }
            effects.push({ scope, scope_key: v('scope_key' + i) || '', mult_pct: 100 + delta });
          }
          const stock_fx = [];
          for (const i of [0, 1]) {
            const sid = v('sym' + i);
            if (!sid) continue;
            stock_fx.push({ symbol_id: parseInt(sid, 10), impact_pct: parseInt(v('imp' + i), 10) || 0, vol_mult: parseInt(v('vm' + i), 10) || 100 });
          }
          if (!v('headline')) { UI.err('請填標題'); return false; }
          if (!effects.length && !stock_fx.length) { UI.err('至少要加一條影響'); return false; }
          try {
            const startAt = v('start_at');
            const effect_ts = startAt ? new Date(startAt).getTime() : 0;
            await POST('/market-news', {
              headline: v('headline'), body: v('body'), image_url: v('image_url'),
              duration_h: parseInt(v('duration_h'), 10) || 3, effects, stock_fx, effect_ts
            });
          } catch (e) { UI.err(e.message); return false; }
          UI.ok(v('start_at') ? '已排程，到時間會自動生效' : '已發布，一分鐘內生效'); App.go('news');
        }
      });

      // modal 開啟後綁定 scope → 目標下拉的連動
      setTimeout(() => {
        const back = document.querySelector('.modal-back:last-of-type');
        if (!back) return;
        back.querySelectorAll('[data-scope]').forEach(sel => {
          sel.onchange = () => {
            const idx = sel.dataset.scope;
            const wrap = back.querySelector(`[data-key="${idx}"]`);
            const target = wrap.querySelector('select');
            if (sel.value === 'item') {
              target.innerHTML = targets.items.map(it => `<option value="${it.id}">${UI.esc((it.emoji || '') + it.name)}（${it.price}）</option>`).join('');
              wrap.style.display = '';
            } else if (sel.value === 'kind') {
              target.innerHTML = targets.kinds.map(k => `<option value="${k.key}">${k.label}</option>`).join('');
              wrap.style.display = '';
            } else {
              target.innerHTML = ''; wrap.style.display = 'none';
            }
          };
        });
      }, 0);
    };

    el.querySelectorAll('[data-dnews]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('撤銷這則快報？還在生效的物價倍率會立刻結束，已成交的交易不會回溯。')) return;
      await DEL('/market-news/' + b.dataset.dnews); UI.ok('已撤銷'); App.go('news');
    });
    el.querySelector('#clearnews').onclick = async () => {
      if (!await UI.confirm('清除所有「已結束」的快報？（時段已過的，不影響還在生效中的）')) return;
      const r = await DEL('/market-news-ended'); UI.ok(`已清除 ${r.removed || 0} 則`); App.go('news');
    };
    el.querySelectorAll('[data-dmod]').forEach(b => b.onclick = async () => {
      await DEL('/market-modifiers/' + b.dataset.dmod); UI.ok('已結束'); App.go('news');
    });
  }
});
