// ===== 魚缸：只養 SSR 魚，每日飼料費，產星幣，可被偷 =====
App.page('aquarium', {
  title: '魚缸', sub: '只養 SSR 魚：每天要買飼料，會產星幣，沒餵會死', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [c, fish] = await Promise.all([GET('/aquarium'), GET('/aquarium-fish')]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    // 每天淨賺＝每日產出 －（一天要餵幾次 × 飼料費）
    const net = (f) => Math.round(f.coin_per_day - f.feed_cost * (24 / Math.max(1, c.feed_hours || 24)));

    el.innerHTML = `
      <div class="card" style="max-width:760px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用魚缸系統')}</div>
        <div class="form-row">
          <div class="field"><label>免費基礎魚缸格數</label><input name="max_slots" type="number" min="0" value="${c.max_slots ?? 0}">
            <div class="hint">每人「免費」送幾格（<strong>0＝完全要靠 /設施商店 買或 /製作 蓋</strong>）。買/製作的格數會再往上相加。</div></div>
          <div class="field"><label>餵一次撐幾小時</label><input name="feed_hours" type="number" min="1" value="${c.feed_hours ?? 24}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>最多可先餵到幾小時後</label><input name="stock_hours" type="number" min="1" value="${c.stock_hours ?? 48}">
            <div class="hint">防止一次囤一年的飼料。</div></div>
          <div class="field"><label>餓幾小時會死掉</label><input name="starve_hours" type="number" min="1" value="${c.starve_hours ?? 48}">
            <div class="hint">超過就整條魚消失，缸裡沒領的星幣也一起沒了。</div></div>
        </div>
        <div class="field" style="max-width:260px"><label>未領取星幣最多累積幾天份</label><input name="max_accrue_days" type="number" min="1" value="${c.max_accrue_days ?? 3}">
          <div class="hint">滿了就停產，逼玩家回來 <code>/撈金</code>。</div></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
        <h3>🕵️ 偷魚</h3>
        <div class="field">${H.toggle('steal_enabled', c.steal_enabled, '開放 /偷魚')}</div>
        <div class="form-row">
          <div class="field"><label>每人每日次數</label><input name="steal_daily_limit" type="number" min="0" value="${c.steal_daily_limit ?? 2}"></div>
          <div class="field"><label>成功率 %</label><input name="steal_success_pct" type="number" min="0" max="100" value="${c.steal_success_pct ?? 40}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>偷走未領星幣的 %</label><input name="steal_take_pct" type="number" min="0" max="100" value="${c.steal_take_pct ?? 20}"></div>
          <div class="field"><label>單次最多偷取星幣（0＝不限）</label><input name="steal_max" type="number" min="0" value="${c.steal_max ?? 300}">
            <div class="hint">一次偷魚最多只能偷這麼多星幣，避免魚貴時一次被偷好幾百。</div></div>
          <div class="field"><label>整條魚被撈走的機率 %</label><input name="steal_fish_pct" type="number" min="0" max="100" value="${c.steal_fish_pct ?? 3}">
            <div class="hint">魚很貴，建議壓在 5% 以內。</div></div>
        </div>
        <div class="form-row">
          <div class="field"><label>偷失敗罰款（星幣，0＝不罰）</label><input name="steal_fail_penalty" type="number" min="0" value="${c.steal_fail_penalty ?? 0}">
            <div class="hint">偷魚<strong>失敗被抓</strong>時，扣偷竊者這麼多星幣（星幣可扣成負數，賴不掉）。</div></div>
          <div class="field"><label>罰款去向</label>${H.toggle('steal_penalty_to_victim', c.steal_penalty_to_victim ?? 1, '罰款全額賠給受害者（關閉＝直接沒收充公）')}</div>
        </div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🐠 SSR 魚（水族商店內容）</h3>
          <button class="btn small" id="addfish">＋ 新增魚</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>魚</th><th>售價</th><th>每天產出</th><th>飼料費</th><th>每天淨賺</th><th>回本天數</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${fish.length ? fish.map(f => `<tr>
              <td>${UI.esc((f.emoji || '') + ' ' + f.name)}</td>
              <td>${coin(f.price)}</td>
              <td>${coin(f.coin_per_day)}</td>
              <td>${coin(f.feed_cost)} / 次</td>
              <td>${net(f) > 0 ? coin(net(f)) : `<span style="color:#e74c3c">${coin(net(f))}</span>`}</td>
              <td>${net(f) > 0 ? Math.ceil(f.price / net(f)) + ' 天' : '永遠不回本'}</td>
              <td>${f.enabled ? '✅' : '⬜'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-efish="${f.id}">編輯</button>
                <button class="btn tiny secondary" data-dfish="${f.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="8" class="hint">尚無魚（機器人啟動時會自動建立一批預設 SSR 魚）。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">魚缸產出的是<b>星幣</b>（不是背包物品），玩家用 <code>/撈金</code> 領走。買魚時會自動附第一份飼料。</div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/aquarium', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('aquarium');
    };

    const fishForm = (f = {}) => `
      <div class="form-row">
        <div class="field"><label>魚的名稱</label><input name="name" value="${UI.esc(f.name || '')}" placeholder="例如 錦鯉"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(f.emoji || '')}" style="text-align:center" placeholder="🎏">${H.emojiPicker('input[name="emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>售價（星幣）</label><input name="price" type="number" min="0" value="${f.price ?? 3000}"></div>
        <div class="field"><label>每天產出星幣</label><input name="coin_per_day" type="number" min="0" value="${f.coin_per_day ?? 100}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>飼料費（每次）</label><input name="feed_cost" type="number" min="0" value="${f.feed_cost ?? 40}"></div>
        <div class="field"><label>排序</label><input name="sort" type="number" value="${f.sort ?? 0}"></div>
      </div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(f.description || '')}"></div>
      <div class="field">${H.toggle('enabled', f.enabled ?? 1, '上架')}</div>
      <div class="hint">建議：每天淨賺 ≈ 售價 ÷ 50（約 50 天回本），才不會蓋過採集與牧場。</div>`;

    const openFish = (f) => {
      const m = UI.modal({
        title: f ? '編輯 SSR 魚' : '新增 SSR 魚', bodyHTML: fishForm(f || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填魚的名稱'); return false; }
          if (f) await PUT('/aquarium-fish/' + f.id, b); else await POST('/aquarium-fish', b);
          UI.ok('已儲存'); App.go('aquarium');
        }
      });
      H.bindEmojiPickers(m.back);
    };
    el.querySelector('#addfish').onclick = () => openFish(null);
    el.querySelectorAll('[data-efish]').forEach(b => b.onclick = () => openFish(fish.find(x => x.id == b.dataset.efish)));
    el.querySelectorAll('[data-dfish]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這條魚？玩家缸裡養著的這種魚也會一起消失。')) return;
      await DEL('/aquarium-fish/' + b.dataset.dfish); UI.ok('已刪除'); App.go('aquarium');
    });
  }
});
