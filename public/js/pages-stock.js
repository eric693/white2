// ===== 星幣股市 =====
// 新聞已經拆成獨立的一頁（pages-news.js，權限 key＝news），因為它掌管全服物價，
// 權責跟「掛幾支股票、手續費收多少」完全是兩回事，要能分別交給不同管理員。
App.page('stock', {
  title: '股市', sub: '掛牌股票、交易參數與成交紀錄（新聞在「財經新聞」那一頁）', module: 'stock',

  async render(el) {
    await H.loadMeta();
    const [c, syms] = await Promise.all([GET('/market'), GET('/stock-symbols')]);
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

    el.innerHTML = `
      <div class="card" style="max-width:760px" id="cfgwrap">
        <h3>總開關</h3>
        <div class="field">${H.toggle('stock_enabled', c.stock_enabled, '啟用星幣股市（/股市 /買股 /賣股）')}</div>
        <div class="hint" style="margin:6px 0 14px">
          財經新聞（會改變全服物價的那個）已經獨立成
          <a href="#news">財經新聞</a> 那一頁，開關與快報都在那邊發。
          新聞裡的股價效果，只有這裡的股市開啟時才會套用。
        </div>

        <div class="field"><label>股市指令限定頻道（逗號分隔的頻道 ID，留空＝不限）</label>
          <input name="channels" value="${UI.esc(c.channels || '')}" placeholder="留空＝所有頻道都能用"></div>

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
