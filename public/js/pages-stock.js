// ===== 財經新聞快報 ＋ 星幣股市 =====
// 預設兩個開關都是關的，管理員自己決定什麼時候上線。
App.page('stock', {
  title: '新聞與股市', sub: '財經快報影響物價與股價，手續費銷毀星幣', module: 'stock',

  async render(el) {
    await H.loadMeta();
    const [c, syms, news, mods, targets] = await Promise.all([
      GET('/market'), GET('/stock-symbols'), GET('/market-news'), GET('/market-modifiers'), GET('/market-targets')
    ]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const spark = (a) => {
      if (!a || !a.length) return '—';
      const lo = Math.min(...a), hi = Math.max(...a);
      if (hi === lo) return BARS[3].repeat(a.length);
      return a.map(v => BARS[Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
    };
    // 伺服器是 UTC，一律用台北時間顯示，否則管理員看到的時間會差 8 小時
    const when = (ms) => new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const hhmm = (ms) => new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
    const SCOPES = { all: '🌐 全部物品', crop: '🌾 菜價（種植產物）', ranch: '🥚 副產品（牧場產物）', kind: '⛏️ 某類採集', item: '📦 單一物品' };

    el.innerHTML = `
      <div class="card" style="max-width:760px" id="cfgwrap">
        <h3>總開關</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用財經新聞快報（新聞會改變物品賣價）')}</div>
        <div class="field">${H.toggle('stock_enabled', c.stock_enabled, '啟用星幣股市（/股市 /買股 /賣股）')}</div>
        <div class="hint" style="margin:6px 0 14px">
          兩個都預設關閉。只開新聞也可以——玩家會看到 <code>/行情</code> 與賣價浮動，但沒有股票可以買。
          新聞的股價效果只在股市開啟時才會套用。
        </div>

        <div class="form-row">
          <div class="field"><label>快報發布頻道</label>${H.chanSelect('news_channel', c.news_channel)}</div>
          <div class="field"><label>股市指令限定頻道（逗號分隔的頻道 ID，留空＝不限）</label>
            <input name="channels" value="${UI.esc(c.channels || '')}" placeholder="留空＝所有頻道都能用"></div>
        </div>

        <h3 style="margin-top:18px">股市參數</h3>
        <div class="form-row">
          <div class="field"><label>結算間隔（分鐘）</label><input name="tick_minutes" type="number" min="1" value="${c.tick_minutes ?? 60}"></div>
          <div class="field"><label>交易稅 %（買賣各收，直接銷毀，可填小數如 1.5）</label><input name="fee_pct" type="number" min="0" max="50" step="0.1" value="${c.fee_pct ?? 2}"></div>
          <div class="field"><label>單次漲跌停 %</label><input name="limit_pct" type="number" min="1" max="100" value="${c.limit_pct ?? 20}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>單筆最少股數</label><input name="min_trade" type="number" min="1" value="${c.min_trade ?? 1}"></div>
          <div class="field"><label>單筆最多股數</label><input name="max_trade" type="number" min="0" value="${c.max_trade ?? 100}"></div>
          <div class="field"><label>每人持股上限：所有股票加總（0＝不限）</label><input name="max_shares" type="number" min="0" value="${c.max_shares ?? 500}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>交易冷卻（秒）</label><input name="trade_cooldown_s" type="number" min="0" value="${c.trade_cooldown_s ?? 30}"></div>
          <div class="field"><label>每日交易次數上限（0＝不限）</label><input name="daily_trade_limit" type="number" min="0" value="${c.daily_trade_limit ?? 0}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">持有上限是巨鯨防線：餘額異常大的帳號也只能吃下固定股數。</div>

        <h3 style="margin-top:18px">物價倍率護欄</h3>
        <div class="form-row">
          <div class="field"><label>賣價倍率下限 %</label><input name="mult_floor_pct" type="number" min="1" max="100" value="${c.mult_floor_pct ?? 40}"></div>
          <div class="field"><label>賣價倍率上限 %</label><input name="mult_ceil_pct" type="number" min="100" value="${c.mult_ceil_pct ?? 250}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">多則新聞同時生效時倍率會相乘，這兩個值是最後的硬夾限，防止疊加失控。</div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <h3>回收與參與</h3>
        <div class="form-row">
          <div class="field"><label>近 7 天銷毀星幣</label><div style="font-size:22px">${coin(c.stats?.burnedWeek)}</div></div>
          <div class="field"><label>累計銷毀</label><div style="font-size:22px">${coin(c.burned_total)}</div></div>
          <div class="field"><label>流通市值</label><div style="font-size:22px">${coin(c.stats?.mktCap)}</div></div>
          <div class="field"><label>交易過的玩家</label><div style="font-size:22px">${c.stats?.traders ?? 0} 人</div></div>
        </div>
        <div class="hint">「近 7 天銷毀」是判斷回收池有沒有在運作的唯一依據。長期偏低就把手續費調高，或增加新聞頻率。</div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">📈 股票</h3>
          <button class="btn small" id="addsym">＋ 新增股票</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>代號</th><th>名稱</th><th>現價</th><th>錨價</th><th>波動</th><th>回歸</th><th>走勢</th><th>持有人</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${syms.length ? syms.map(s => `<tr>
              <td><code>${UI.esc(s.code)}</code></td>
              <td>${UI.esc((s.emoji || '') + ' ' + s.name)}</td>
              <td>${coin(s.price)}</td>
              <td>${coin(s.anchor)}</td>
              <td>${s.vol_pct}%</td>
              <td>${s.revert_pct}%</td>
              <td style="font-family:monospace">${spark(s.history)}</td>
              <td>${s.holders}</td>
              <td>${H.enabledTag(s.enabled)}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-esym="${s.id}">編輯</button>
                <button class="btn tiny secondary" data-dsym="${s.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="10" class="hint">尚無股票（機器人啟動時會建立一批預設）。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">
          <b>波動</b>＝每次結算的標準差，數字越大越刺激；<b>錨價</b>是長期合理價，<b>回歸</b>越大越會被拉回錨價。
          建議至少留一支低波動（3～4%）給新手、一支高波動（12%以上）給賭徒。
        </div>
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
      // 排程中的快報要看得到「幾點開始、幾點結束」，不然管理員記不住自己排到幾點
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
      </div>

      <div class="card">
        <h3>📒 最近成交</h3>
        <div id="trades" class="hint">載入中…</div>
      </div>`;

    // ---- 儲存設定 ----
    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/market', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('stock');
    };

    // ---- 股票表單 ----
    const symForm = (s = {}) => `
      <div class="form-row">
        <div class="field"><label>代號</label><input name="code" value="${UI.esc(s.code || '')}" placeholder="2330"></div>
        <div class="field"><label>名稱</label><input name="name" value="${UI.esc(s.name || '')}" placeholder="白光雞蛋"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(s.emoji || '')}" style="text-align:center" placeholder="🐔">${H.emojiPicker('input[name="emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>現價</label><input name="price" type="number" value="${s.price ?? 100}" title="可以填 0 或負數">
          <div class="hint">⚠️ <strong>調整分級時不要動這欄！</strong>直接改現價＝憑空給（或扣）持有玩家一大筆星幣。只有新股上市才需要設。</div></div>
        <div class="field"><label>錨價（長期合理價）</label><input name="anchor" type="number" value="${s.anchor ?? s.price ?? 100}" title="想讓股價跌到負的，這裡也要設成負數，否則會被拉回正的">
          <div class="hint">✅ <strong>要分級／調股價高低就改這欄。</strong>現價會靠「回歸強度」在幾天內慢慢漲/跌到錨價，玩家不會一夕暴富。</div></div>
      </div>
      <div class="form-row">
        <div class="field"><label>波動率 %／次</label><input name="vol_pct" type="number" min="0" max="60" value="${s.vol_pct ?? 8}"></div>
        <div class="field"><label>趨勢 %／次（可負）</label><input name="drift_pct" type="number" value="${s.drift_pct ?? 0}"></div>
        <div class="field"><label>回歸強度 %</label><input name="revert_pct" type="number" min="0" max="100" value="${s.revert_pct ?? 10}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>價格下限</label><input name="floor_price" type="number" value="${s.floor_price ?? 10}" title="可以填 0 或負數，股價就能跌破零"></div>
        <div class="field"><label>價格上限</label><input name="ceil_price" type="number" min="1" value="${s.ceil_price ?? 100000}"></div>
        <div class="field"><label>排序</label><input name="sort" type="number" value="${s.sort ?? 0}"></div>
      </div>
      <div class="field"><label>說明（顯示在個股頁尾）</label><input name="description" value="${UI.esc(s.description || '')}"></div>
      <div class="field">${H.toggle('enabled', s.id ? s.enabled : 1, '啟用（掛牌）')}</div>
      <div class="hint">波動率 3～4%＝牛皮股、8～10%＝一般、12% 以上＝妖股。回歸強度 0 就是純隨機遊走，長期會跑掉，建議至少 8。</div>`;

    const openSym = (s = {}) => {
      const m = UI.modal({
        title: s.id ? `編輯股票：${s.name}` : '新增股票',
        bodyHTML: symForm(s),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.code || !b.name) { UI.err('請填代號與名稱'); return false; }
          try {
            if (s.id) await PUT('/stock-symbols/' + s.id, b); else await POST('/stock-symbols', b);
          } catch (e) { UI.err(e.message); return false; }
          UI.ok('已儲存'); App.go('stock');
        }
      });
      H.bindEmojiPickers(m.back);   // 啟用表情選擇器（含伺服器自訂表情）
    };

    el.querySelector('#addsym').onclick = () => openSym();
    el.querySelectorAll('[data-esym]').forEach(b => b.onclick = () => openSym(syms.find(x => x.id == b.dataset.esym)));
    el.querySelectorAll('[data-dsym]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這支股票？相關的 K 線紀錄也會一起刪除。')) return;
      try { await DEL('/stock-symbols/' + b.dataset.dsym); UI.ok('已刪除'); App.go('stock'); }
      catch (e) { UI.err(e.message); }
    });

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
            // 表單填的是「漲跌 %」（+30 ＝ 漲三成），後端存的是倍率 %（130 ＝ ×1.3）
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
          UI.ok(v('start_at') ? '已排程，到時間會自動生效' : '已發布，一分鐘內生效'); App.go('stock');
        },
        // 選了「某類採集 / 單一物品」才顯示目標下拉
        afterOpen: null
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
      await DEL('/market-news/' + b.dataset.dnews); UI.ok('已撤銷'); App.go('stock');
    });
    el.querySelector('#clearnews').onclick = async () => {
      if (!await UI.confirm('清除所有「已結束」的快報？（時段已過的，不影響還在生效中的）')) return;
      const r = await DEL('/market-news-ended'); UI.ok(`已清除 ${r.removed || 0} 則`); App.go('stock');
    };
    el.querySelectorAll('[data-dmod]').forEach(b => b.onclick = async () => {
      await DEL('/market-modifiers/' + b.dataset.dmod); UI.ok('已結束'); App.go('stock');
    });

    // ---- 成交紀錄 ----
    GET('/stock-trades').then(rows => {
      const box = el.querySelector('#trades');
      if (!rows.length) { box.textContent = '還沒有人交易過。'; return; }
      box.classList.remove('hint');
      box.innerHTML = `<div class="table-wrap"><table class="list">
        <thead><tr><th>時間</th><th>玩家</th><th>股票</th><th>買賣</th><th>股數</th><th>成交價</th><th>手續費</th><th>損益</th></tr></thead>
        <tbody>${rows.map(t => `<tr>
          <td>${when(t.ts)}</td>
          <td>${UI.esc(t.username || t.user_id)}</td>
          <td>${UI.esc((t.emoji || '') + (t.name || ''))}</td>
          <td>${t.side === 'buy' ? '📥 買' : '📤 賣'}</td>
          <td>${t.shares}</td>
          <td>${coin(t.price)}</td>
          <td>${coin(t.fee)}</td>
          <td>${t.side === 'sell' ? (t.pnl >= 0 ? '📈 +' : '📉 ') + Number(t.pnl).toLocaleString('en-US') : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`;
    }).catch(() => { el.querySelector('#trades').textContent = '讀取失敗。'; });
  }
});
