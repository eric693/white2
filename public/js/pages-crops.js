// ===== 種植系統：農地 / 溫室 =====
App.page('crops', {
  title: '農地溫室', sub: '種作物、種花卉、成熟採收賣 NPC', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [c, seeds] = await Promise.all([GET('/crops'), GET('/crop-seeds')]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const PLOT = { field: '🌾 農地', greenhouse: '🏡 溫室' };

    el.innerHTML = `
      <div class="card" style="max-width:640px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用種植系統')}</div>
        <div class="form-row">
          <div class="field"><label>初始農地格數</label><input name="field_slots" type="number" min="0" value="${c.field_slots ?? 0}"></div>
          <div class="field"><label>初始溫室格數</label><input name="greenhouse_slots" type="number" min="0" value="${c.greenhouse_slots ?? 0}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">玩家的總格數＝這裡的初始格 ＋ 用 <code>/製作</code> 做「農地」「溫室」開出來的格。設 0 就代表一定要製作才有格子。玩家 <code>/種植</code> 種下、<code>/農地</code> 看進度、<code>/採收</code> 收成賣出。</div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🌱 種子（含成熟產物）</h3>
          <button class="btn small" id="addseed">＋ 新增種子</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>種子</th><th>種在</th><th>種子價</th><th>成熟時間</th><th>產物</th><th>收成量</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${seeds.length ? seeds.map(s => `<tr>
              <td>${UI.esc((s.emoji || '') + ' ' + s.name)}</td>
              <td>${PLOT[s.plot_type] || s.plot_type}</td>
              <td>${coin(s.seed_price)}</td>
              <td>${s.grow_minutes} 分（約 ${(s.grow_minutes / 60).toFixed(1)} 時）</td>
              <td>${UI.esc((s.product_emoji || '') + ' ' + (s.product_name || '—'))}（賣 ${s.product_price}）</td>
              <td>${s.yield_count}</td>
              <td>${s.enabled ? '✅' : '⬜'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-eseed="${s.id}">編輯</button>
                <button class="btn tiny secondary" data-dseed="${s.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="8" class="hint">尚無種子（機器人啟動時會自動建立一批預設）。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">產物會自動放進「牧場產物」類別，玩家 <code>/背包</code> 看得到、<code>/賣出</code> 賣得掉。</div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/crops', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('crops');
    };

    const seedForm = (s = {}) => `
      <div class="form-row">
        <div class="field"><label>種子名稱</label><input name="name" value="${UI.esc(s.name || '')}" placeholder="例如 番茄種子"></div>
        <div class="field"><label>種子圖示</label><input name="emoji" value="${UI.esc(s.emoji || '')}" style="text-align:center" placeholder="🍅">${H.emojiPicker('input[name="emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>種在哪</label>
          <select name="plot_type"><option value="field" ${s.plot_type !== 'greenhouse' ? 'selected' : ''}>🌾 農地</option><option value="greenhouse" ${s.plot_type === 'greenhouse' ? 'selected' : ''}>🏡 溫室</option></select></div>
        <div class="field"><label>種子價（金幣）</label><input name="seed_price" type="number" min="0" value="${s.seed_price ?? 20}"></div>
      </div>
      <div class="field"><label>成熟時間（分鐘）</label><input name="grow_minutes" type="number" min="1" value="${s.grow_minutes ?? 180}"></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="form-row">
        <div class="field"><label>成熟產物名稱</label><input name="product_name" value="${UI.esc(s.product_name || '')}" placeholder="例如 番茄"></div>
        <div class="field"><label>產物圖示</label><input name="product_emoji" value="${UI.esc(s.product_emoji || '')}" style="text-align:center" placeholder="🍅">${H.emojiPicker('input[name="product_emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>收成量</label><input name="yield_count" type="number" min="1" value="${s.yield_count ?? 1}"></div>
        <div class="field"><label>產物賣出單價</label><input name="product_price" type="number" min="0" value="${s.product_price ?? 10}"></div>
      </div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${s.sort ?? 0}"></div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(s.description || '')}"></div>
      <div class="field">${H.toggle('enabled', s.enabled ?? 1, '上架')}</div>`;

    const openSeed = (s) => {
      const m = UI.modal({
        title: s ? '編輯種子' : '新增種子', bodyHTML: seedForm(s || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填種子名稱'); return false; }
          if (!b.product_name) { UI.err('請填產物名稱'); return false; }
          if (s) await PUT('/crop-seeds/' + s.id, b); else await POST('/crop-seeds', b);
          UI.ok('已儲存'); App.go('crops');
        }
      });
      H.bindEmojiPickers(m.back);
    };
    el.querySelector('#addseed').onclick = () => openSeed(null);
    el.querySelectorAll('[data-eseed]').forEach(b => b.onclick = () => openSeed(seeds.find(x => x.id == b.dataset.eseed)));
    el.querySelectorAll('[data-dseed]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個種子？玩家種在田裡的這種作物也會一起移除。')) return;
      await DEL('/crop-seeds/' + b.dataset.dseed); UI.ok('已刪除'); App.go('crops');
    });
  }
});
