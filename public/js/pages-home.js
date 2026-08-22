// ===== 家園與成就（後台）=====
// 房屋 12 階、家具、廚房與食譜、寵物、成就、好感度階級，全部改成後台可增刪改。
// 以前這些數值都埋在程式的預設清單裡，要調一個家具的加成就得改程式重啟。
App.page('home', {
  title: '家園與成就', sub: '房屋階級、家具、廚房料理、寵物能力、成就與好感度，全部可直接改', module: 'home',

  async render(el) {
    const meta = await GET('/home-meta');
    const BUFFS = meta.buff_types;                 // [{key,label}]
    const METRICS = meta.metrics;                  // [{key,label,unit,derived}]
    const buffLabel = (k) => (BUFFS.find(b => b.key === k) || {}).label || k || '—';
    const metricLabel = (k) => (METRICS.find(m => m.key === k) || {}).label || k;

    const TABS = [
      ['config', '⚙️ 總設定'], ['levels', '🏠 房屋階級'], ['furniture', '🛋️ 家具'],
      ['kitchen', '🍳 廚房與料理'], ['pets', '🐾 寵物'], ['ach', '🏅 成就'],
      ['affinity', '💕 好感度'], ['stroll', '🛍️ 逛街角色'], ['players', '👥 玩家現況']
    ];
    let tab = sessionStorage.getItem('w2_home_tab') || 'config';
    if (!TABS.some(t => t[0] === tab)) tab = 'config';

    const shell = () => {
      el.innerHTML = `
        <div class="toolbar" style="flex-wrap:wrap;gap:6px">
          ${TABS.map(([k, label]) =>
        `<button class="btn small ${k === tab ? '' : 'secondary'}" data-tab="${k}">${label}</button>`).join('')}
        </div>
        <div id="tabbody">載入中…</div>`;
      el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
        tab = b.dataset.tab; sessionStorage.setItem('w2_home_tab', tab); shell(); draw();
      });
    };

    // ---- 材料編輯器：材料一律是 [{item,count}]，用物品名稱比對 ----
    const matRows = (list = [], n = 5) => {
      const opts = (sel) => `<option value="">— 無 —</option>` + meta.items.map(it =>
        `<option value="${UI.esc(it.name)}" ${it.name === sel ? 'selected' : ''}>${UI.esc((it.emoji || '') + it.name)}</option>`).join('');
      return Array.from({ length: n }, (_, i) => {
        const m = list[i] || {};
        return `<div class="form-row" style="align-items:flex-end">
          <div class="field"><label>${i === 0 ? '材料（用物品名稱，選「無」＝不用）' : ''}</label>
            <select name="mat_item${i}">${opts(m.item)}</select></div>
          <div class="field" style="max-width:120px"><label>${i === 0 ? '數量' : ''}</label>
            <input name="mat_count${i}" type="number" min="1" value="${m.count || ''}"></div>
        </div>`;
      }).join('');
    };
    const collectMats = (back, n = 5) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const item = UI.val(back, 'mat_item' + i);
        const count = parseInt(UI.val(back, 'mat_count' + i), 10);
        if (item && Number.isFinite(count) && count > 0) out.push({ item, count });
      }
      return out;
    };
    const parseMats = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
    const matText = (s) => parseMats(s).map(m => `${UI.esc(m.item)}×${m.count}`).join('、') || '—';

    const buffSelect = (name, sel) => `<select name="${name}">
      <option value="">— 無加成 —</option>
      ${BUFFS.map(b => `<option value="${b.key}" ${b.key === sel ? 'selected' : ''}>${UI.esc(b.label)}</option>`).join('')}
    </select>`;

    // 共用：新增／編輯彈窗
    const crud = (path, title, formHTML, toBody, after) => ({
      open: (row = {}) => UI.modal({
        title: row.id ? `編輯：${row.name || row.level || ''}` : title,
        bodyHTML: formHTML(row),
        onOk: async (back) => {
          const body = toBody(back, row);
          try {
            if (row.id) await PUT(`/${path}/${row.id}`, body); else await POST(`/${path}`, body);
          } catch (e) { UI.err(e.message); return false; }
          UI.ok('已儲存'); draw();
        }
      }),
      del: async (row) => {
        if (!await UI.confirm(`刪除「${row.name || ('Lv.' + row.level)}」？玩家已經擁有的不會被收回，但之後就買不到／解不到了。`)) return;
        try { await DEL(`/${path}/${row.id}`); UI.ok('已刪除'); draw(); } catch (e) { UI.err(e.message); }
      }
    });

    const bindRows = (body, c, rows) => {
      body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => c.open(rows.find(x => x.id == b.dataset.edit)));
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => c.del(rows.find(x => x.id == b.dataset.del)));
    };

    const roleRows = (roles, kw) => {
      const k = (kw || '').trim().toLowerCase();
      const list = roles.filter(r => !k || String(r.name).toLowerCase().includes(k));
      return list.map(r => `<tr>
        <td>${UI.esc(r.name)}</td>
        <td style="font-size:13px">${UI.esc(r.author || '')}</td>
        <td>${r.enabled ? '✅' : '<span class="hint">停用</span>'}</td>
        <td><label class="switch"><input type="checkbox" data-role="${r.id}" ${r.stroll_ok ? 'checked' : ''}> ${r.stroll_ok ? '會出現' : '不出現'}</label></td>
      </tr>`).join('') || '<tr><td colspan="4" class="hint">找不到符合的角色</td></tr>';
    };
    const bindRoleToggles = (body) => {
      body.querySelectorAll('[data-role]').forEach(cb => cb.onchange = async () => {
        try {
          await POST('/stroll-roles', { ids: [Number(cb.dataset.role)], stroll_ok: cb.checked });
          cb.parentElement.lastChild.textContent = cb.checked ? ' 會出現' : ' 不出現';
        } catch (e) { UI.err(e.message); cb.checked = !cb.checked; }
      });
    };

    // ---------- 各分頁 ----------
    const draw = async () => {
      const body = el.querySelector('#tabbody');
      body.innerHTML = '載入中…';

      if (tab === 'config') {
        const c = await GET('/home-config');
        body.innerHTML = `
          <div class="card" style="max-width:760px" id="cfg">
            <h3>總開關</h3>
            <div class="field">${H.toggle('enabled', c.enabled, '啟用家園系統')}</div>
            <div class="form-row">
              <div class="field"><label>成就同時可裝備幾個</label><input name="title_slots" type="number" min="1" value="${c.title_slots ?? 3}">
                <div class="hint">解鎖再多，同時只有這麼多個加成生效。改小不會沒收玩家已裝備的，但下次結算就只算前面幾個。</div></div>
              <div class="field"><label>單一加成總和上限 %</label><input name="buff_cap_pct" type="number" min="0" value="${c.buff_cap_pct ?? 30}">
                <div class="hint">房屋＋家具＋寵物＋成就＋料理全部加起來，每一種加成最多就到這個數字。</div></div>
            </div>
            <div class="form-row">
              <div class="field">${H.toggle('visit_enabled', c.visit_enabled, '開放邀請角色來訪')}</div>
              <div class="field"><label>每日送禮次數上限（每角色）</label><input name="gift_daily_limit" type="number" min="0" value="${c.gift_daily_limit ?? 5}"></div>
              <div class="field"><label>每日邀請次數上限</label><input name="visit_daily_limit" type="number" min="0" value="${c.visit_daily_limit ?? 3}"></div>
            </div>

            <h3 style="margin-top:18px">📅 小屋簽到</h3>
            <div class="field">${H.toggle('checkin_enabled', c.checkin_enabled, '開放每日簽到')}</div>
            <div class="form-row">
              <div class="field"><label>每日基礎金幣</label><input name="checkin_base" type="number" min="0" value="${c.checkin_base ?? 500}"></div>
              <div class="field"><label>每連續一天多給</label><input name="checkin_streak" type="number" min="0" value="${c.checkin_streak ?? 100}"></div>
              <div class="field"><label>連續加碼封頂在第幾天</label><input name="checkin_max" type="number" min="1" value="${c.checkin_max ?? 7}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>一週七天全簽的額外獎勵</label><input name="checkin_week" type="number" min="0" value="${c.checkin_week ?? 3000}"></div>
              <div class="field"><label>房屋每一階額外 +%</label><input name="checkin_home_pct" type="number" min="0" value="${c.checkin_home_pct ?? 10}"></div>
            </div>
            <div class="hint" style="margin-bottom:10px">
              實際領到 ＝ 基礎 ＋ 連續天數×加碼（封頂） ＋ 基礎×房屋階級×每階%；整週全簽再加獎勵。
              斷一天連續就從頭算。
            </div>
            <h3 style="margin-top:18px">🛍️ 逛街（隨機遇到角色）</h3>
            <div class="field">${H.toggle('stroll_enabled', c.stroll_enabled ?? 1, '開放逛街（玩家在好感度面板點「逛街」隨機遇到角色）')}</div>
            <div class="form-row">
              <div class="field"><label>逛一次消耗幾點體力</label><input name="stroll_cost" type="number" min="1" value="${c.stroll_cost ?? 1}"></div>
              <div class="field"><label>遇到就加的好感點數</label><input name="stroll_points" type="number" min="0" value="${c.stroll_points ?? 3}"></div>
            </div>
            <div class="hint" style="margin-bottom:8px">
              體力＝「釣魚挖礦」頁的<b>每日採集點數</b>那一池（目前設定就是玩家每天的總行動額度），
              釣魚、挖礦、逛街共用，而且<b>不受任何加成影響</b>。要讓玩家能多動，
              就調高每日採集點數，或在特殊商店上架「體力」商品讓他們花錢買。
            </div>
            <div class="hint" style="margin-bottom:10px">
              遇到誰是隨機的（玩家不能挑）；沒遇過的角色權重比較高，兩百多位角色才會輪流出場。
              角色會講的台詞在「角色轉盤」那一頁每位角色各自設定。
            </div>

            <h3 style="margin-top:18px">💞 同居</h3>
            <div class="field">${H.toggle('partner_enabled', c.partner_enabled ?? 1, '開放同居（角色搬進玩家家裡，每期課伴侶稅）')}</div>
            <div class="form-row">
              <div class="field"><label>最多同時跟幾位同居</label><input name="partner_slots" type="number" min="1" value="${c.partner_slots ?? 1}"></div>
              <div class="field"><label>好感度要到第幾階才可能同居</label><input name="partner_level" type="number" min="0" value="${c.partner_level ?? 6}"></div>
            </div>
            <div class="hint" style="margin-bottom:10px">
              對象是<b>隨機</b>的（玩家不能挑要跟誰住，只能請他搬走再抽一次）—— 可以挑的話所有人都會選同一位。
              伴侶稅的金額在「稅金」那一頁設定。
            </div>

            <h3 style="margin-top:18px">💸 用金幣代替材料</h3>
            <div class="field">${H.toggle('buy_mats_enabled', c.buy_mats_enabled ?? 1, '允許用金幣硬升家園／廚房（材料折現）')}</div>
            <div class="field"><label>材料折現倍率 %（5000＝市價的 50 倍）</label><input name="buy_mats_mult" type="number" min="100" value="${c.buy_mats_mult ?? 5000}">
              <div class="hint">刻意設成天價：這是給錢多到沒地方花的人用的出海口，自己去挖永遠比較划算。</div></div>

            <button class="btn" id="save">儲存設定</button>
          </div>`;
        body.querySelector('#save').onclick = async () => {
          await PUT('/home-config', H.collect(body.querySelector('#cfg')));
          UI.ok('已儲存'); draw();
        };
        return;
      }

      if (tab === 'levels') {
        const rows = await GET('/home-levels');
        const c = crud('home-levels', '新增房屋階級',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>階級</label><input name="level" type="number" min="1" value="${r.level ?? (rows.length + 1)}"></div>
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="木屋"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
            </div>
            <div class="field"><label>解鎖說明（顯示給玩家看）</label><input name="unlocks" value="${UI.esc(r.unlocks || '')}"></div>
            <div class="field"><label>升到這一階要的金幣</label><input name="coins" type="number" min="0" value="${r.coins ?? 0}"></div>
            ${matRows(parseMats(r.materials))}
            <div class="form-row">
              <div class="field"><label>可擺家具數</label><input name="furniture_cap" type="number" min="0" value="${r.furniture_cap ?? 5}"></div>
              <div class="field"><label>可養寵物數</label><input name="pet_cap" type="number" min="0" value="${r.pet_cap ?? 0}"></div>
              <div class="field"><label>家園整體加成 %（售價）</label><input name="home_buff_pct" type="number" min="0" value="${r.home_buff_pct ?? 0}"></div>
            </div>
            <div class="field">${H.toggle('kitchen_ok', r.kitchen_ok, '這一階起可以蓋廚房')}</div>
            <div class="field">${H.toggle('visit_ok', r.visit_ok, '這一階起角色才願意來訪')}</div>`,
          (back) => ({ ...H.collect(back), materials: collectMats(back) }));

        body.innerHTML = `
          <div class="toolbar"><button class="btn" id="add">＋ 新增階級</button></div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>階</th><th>名稱</th><th>金幣</th><th>材料</th><th>家具</th><th>寵物</th><th>加成</th><th>解鎖</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td>Lv.${r.level}</td>
              <td>${UI.esc((r.emoji || '') + r.name)}</td>
              <td>${Number(r.coins).toLocaleString('en-US')}</td>
              <td class="wrap" style="font-size:13px">${matText(r.materials)}</td>
              <td>${r.furniture_cap}</td><td>${r.pet_cap}</td>
              <td>${r.home_buff_pct ? '+' + r.home_buff_pct + '%' : '—'}</td>
              <td style="font-size:13px">${r.kitchen_ok ? '🍳' : ''}${r.visit_ok ? '💕' : ''} ${UI.esc(r.unlocks || '')}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'furniture') {
        const rows = await GET('/home-furniture');
        const CATS = { living: '客廳', bedroom: '臥室', kitchen: '廚房', garden: '庭院', collection: '收藏', special: '特殊' };
        const c = crud('home-furniture', '新增家具',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>分類</label><select name="category">
                ${Object.entries(CATS).map(([k, v]) => `<option value="${k}" ${k === r.category ? 'selected' : ''}>${v}</option>`).join('')}
              </select></div>
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>售價</label><input name="price" type="number" min="0" value="${r.price ?? 0}"></div>
              <div class="field"><label>需要房屋階</label><input name="min_level" type="number" min="1" value="${r.min_level ?? 1}"></div>
              <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>
            </div>
            ${matRows(parseMats(r.materials), 3)}
            <div class="form-row">
              <div class="field"><label>加成種類</label>${buffSelect('buff_type', r.buff_type)}</div>
              <div class="field"><label>加成 %（要擺出來才生效）</label><input name="buff_pct" type="number" min="0" value="${r.buff_pct ?? 0}"></div>
            </div>
            <div class="field"><label>說明</label><input name="description" value="${UI.esc(r.description || '')}"></div>
            <div class="field">${H.toggle('enabled', r.id ? r.enabled : 1, '啟用（可購買）')}</div>`,
          (back) => ({ ...H.collect(back), materials: collectMats(back, 3) }));

        body.innerHTML = `
          <div class="toolbar"><button class="btn" id="add">＋ 新增家具</button>
            <div class="spacer" style="flex:1"></div>
            <span class="hint">共 ${rows.length} 件</span></div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>分類</th><th>名稱</th><th>價格</th><th>材料</th><th>階</th><th>加成</th><th>狀態</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td>${CATS[r.category] || r.category}</td>
              <td>${UI.esc((r.emoji || '') + r.name)}</td>
              <td>${Number(r.price).toLocaleString('en-US')}</td>
              <td class="wrap" style="font-size:13px">${matText(r.materials)}</td>
              <td>${r.min_level}</td>
              <td>${r.buff_pct ? `${UI.esc(buffLabel(r.buff_type))} +${r.buff_pct}%` : '—'}</td>
              <td>${H.enabledTag(r.enabled)}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'kitchen') {
        const [levels, recipes] = await Promise.all([GET('/home-kitchen-levels'), GET('/home-recipes')]);
        const lv = crud('home-kitchen-levels', '新增廚房等級',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>等級</label><input name="level" type="number" min="1" value="${r.level ?? (levels.length + 1)}"></div>
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>升級金幣</label><input name="coins" type="number" min="0" value="${r.coins ?? 0}"></div>
              <div class="field"><label>完美加成 %（把品質往高處推）</label><input name="perfect_pct" type="number" min="0" value="${r.perfect_pct ?? 0}"></div>
            </div>
            ${matRows(parseMats(r.materials), 3)}
            <div class="field"><label>說明</label><input name="description" value="${UI.esc(r.description || '')}"></div>`,
          (back) => ({ ...H.collect(back), materials: collectMats(back, 3) }));

        const rc = crud('home-recipes', '新增食譜',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>料理名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
              <div class="field"><label>需要廚房等級</label><input name="min_kitchen" type="number" min="1" value="${r.min_kitchen ?? 1}"></div>
            </div>
            ${matRows(parseMats(r.materials), 4)}
            <div class="form-row">
              <div class="field"><label>烹飪時間（分）</label><input name="cook_minutes" type="number" min="1" value="${r.cook_minutes ?? 30}"></div>
              <div class="field"><label>基礎售價</label><input name="base_price" type="number" min="0" value="${r.base_price ?? 0}"></div>
              <div class="field"><label>送禮好感基數</label><input name="affinity_base" type="number" min="0" value="${r.affinity_base ?? 0}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>吃了給的加成</label>${buffSelect('buff_type', r.buff_type)}</div>
              <div class="field"><label>加成 %</label><input name="buff_pct" type="number" min="0" value="${r.buff_pct ?? 0}"></div>
              <div class="field"><label>持續（分）</label><input name="buff_minutes" type="number" min="0" value="${r.buff_minutes ?? 0}"></div>
            </div>
            <div class="field"><label>說明</label><input name="description" value="${UI.esc(r.description || '')}"></div>
            <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>
            <div class="field">${H.toggle('enabled', r.id ? r.enabled : 1, '啟用')}</div>`,
          (back) => ({ ...H.collect(back), materials: collectMats(back, 4) }));

        body.innerHTML = `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <h3 style="margin:0">🍳 廚房等級</h3><button class="btn small" id="addlv">＋ 新增等級</button></div>
            <div class="table-wrap" style="margin-top:10px"><table class="list">
              <thead><tr><th>級</th><th>名稱</th><th>金幣</th><th>材料</th><th>完美加成</th><th></th></tr></thead>
              <tbody>${levels.map(r => `<tr>
                <td>Lv.${r.level}</td><td>${UI.esc((r.emoji || '') + r.name)}</td>
                <td>${Number(r.coins).toLocaleString('en-US')}</td>
                <td class="wrap" style="font-size:13px">${matText(r.materials)}</td>
                <td>+${r.perfect_pct || 0}%</td>
                <td><button class="btn tiny secondary" data-elv="${r.id}">編輯</button>
                    <button class="btn tiny danger" data-dlv="${r.id}">刪除</button></td></tr>`).join('')}
              </tbody></table></div>
            <div class="hint" style="margin-top:8px">廚房等級同時決定「一次能煮幾道」（Lv.1 一道、Lv.10 十道）。</div>
          </div>
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <h3 style="margin:0">📖 食譜</h3><button class="btn small" id="addrc">＋ 新增食譜</button></div>
            <div class="table-wrap" style="margin-top:10px"><table class="list">
              <thead><tr><th>料理</th><th>廚房</th><th>材料</th><th>時間</th><th>售價</th><th>好感</th><th>加成</th><th>狀態</th><th></th></tr></thead>
              <tbody>${recipes.map(r => `<tr>
                <td>${UI.esc((r.emoji || '') + r.name)}</td><td>Lv.${r.min_kitchen}</td>
                <td class="wrap" style="font-size:13px">${matText(r.materials)}</td>
                <td>${r.cook_minutes} 分</td>
                <td>${Number(r.base_price).toLocaleString('en-US')}</td>
                <td>${r.affinity_base || 0}</td>
                <td style="font-size:13px">${r.buff_pct ? `${UI.esc(buffLabel(r.buff_type))} +${r.buff_pct}%／${r.buff_minutes}分` : '—'}</td>
                <td>${H.enabledTag(r.enabled)}</td>
                <td><button class="btn tiny secondary" data-erc="${r.id}">編輯</button>
                    <button class="btn tiny danger" data-drc="${r.id}">刪除</button></td></tr>`).join('')}
              </tbody></table></div>
          </div>`;
        body.querySelector('#addlv').onclick = () => lv.open();
        body.querySelector('#addrc').onclick = () => rc.open();
        body.querySelectorAll('[data-elv]').forEach(b => b.onclick = () => lv.open(levels.find(x => x.id == b.dataset.elv)));
        body.querySelectorAll('[data-dlv]').forEach(b => b.onclick = () => lv.del(levels.find(x => x.id == b.dataset.dlv)));
        body.querySelectorAll('[data-erc]').forEach(b => b.onclick = () => rc.open(recipes.find(x => x.id == b.dataset.erc)));
        body.querySelectorAll('[data-drc]').forEach(b => b.onclick = () => rc.del(recipes.find(x => x.id == b.dataset.drc)));
        return;
      }

      if (tab === 'pets') {
        const rows = await GET('/home-pets');
        const c = crud('home-pets', '新增寵物',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
              <div class="field"><label>稀有度</label><select name="rarity">
                ${['N', 'R', 'SR', 'SSR', 'UR'].map(x => `<option ${x === r.rarity ? 'selected' : ''}>${x}</option>`).join('')}
              </select></div>
            </div>
            <div class="form-row">
              <div class="field"><label>需要房屋階</label><input name="min_level" type="number" min="1" value="${r.min_level ?? 3}"></div>
              <div class="field"><label>售價（0＝不販售）</label><input name="price" type="number" min="0" value="${r.price ?? 0}"></div>
              <div class="field"><label>餵食間隔（小時）</label><input name="feed_hours" type="number" min="1" value="${r.feed_hours ?? 24}"></div>
            </div>
            ${matRows(parseMats(r.materials), 3)}
            <div class="form-row">
              <div class="field"><label>技能名稱</label><input name="skill_name" value="${UI.esc(r.skill_name || '')}" placeholder="牧場守望"></div>
              <div class="field"><label>能力</label>${buffSelect('buff_type', r.buff_type)}</div>
              <div class="field"><label>滿親密度時的 %</label><input name="buff_pct" type="number" min="0" value="${r.buff_pct ?? 0}"></div>
            </div>
            <div class="hint">能力按親密度比例給：親密度 50 ＝ 只有一半效果，0 ＝ 完全沒效果（不餵就沒用）。
              防竊類（牧場防護／魚缸防護／全域防竊／反擊機率）就是取代看門動物的那一套。</div>
            <div class="field"><label>說明</label><input name="description" value="${UI.esc(r.description || '')}"></div>
            <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>
            <div class="field">${H.toggle('enabled', r.id ? r.enabled : 1, '啟用（可領養）')}</div>`,
          (back) => ({ ...H.collect(back), materials: collectMats(back, 3) }));

        body.innerHTML = `
          <div class="toolbar"><button class="btn" id="add">＋ 新增寵物</button>
            <div class="spacer" style="flex:1"></div><span class="hint">共 ${rows.length} 種</span></div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>寵物</th><th>稀有</th><th>階</th><th>售價</th><th>材料</th><th>技能</th><th>能力</th><th>餵食</th><th>狀態</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td>${UI.esc((r.emoji || '') + r.name)}</td><td>${r.rarity}</td><td>${r.min_level}</td>
              <td>${Number(r.price).toLocaleString('en-US')}</td>
              <td class="wrap" style="font-size:13px">${matText(r.materials)}</td>
              <td>${UI.esc(r.skill_name || '')}</td>
              <td>${r.buff_pct ? `${UI.esc(buffLabel(r.buff_type))} +${r.buff_pct}%` : '—'}</td>
              <td>${r.feed_hours}h</td>
              <td>${H.enabledTag(r.enabled)}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'ach') {
        const rows = await GET('/home-achievements');
        const c = crud('home-achievements', '新增成就',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}"></div>
              <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
              <div class="field"><label>分類（自由填，只用於歸類）</label><input name="cat" value="${UI.esc(r.cat || '')}" placeholder="mine／daily／guard…"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>解鎖條件</label><select name="metric">
                <option value="">— 舊式：依分類的收集數 —</option>
                ${METRICS.map(m => `<option value="${m.key}" ${m.key === r.metric ? 'selected' : ''}>${UI.esc(m.label)}${m.derived ? '' : '（累計）'}</option>`).join('')}
              </select></div>
              <div class="field"><label>門檻</label><input name="need" type="number" min="0" value="${r.need ?? 0}"></div>
              <div class="field"><label>解鎖獎金</label><input name="reward_coins" type="number" min="0" value="${r.reward_coins ?? 0}"></div>
            </div>
            <div class="field"><label>任務提示（顯示在進度條旁）</label><input name="hint" value="${UI.esc(r.hint || '')}" placeholder="挖礦 300 次"></div>
            <div class="form-row">
              <div class="field"><label>加成一</label>${buffSelect('buff_type', r.buff_type)}</div>
              <div class="field"><label>%</label><input name="buff_pct" type="number" min="0" value="${r.buff_pct ?? 0}"></div>
              <div class="field"><label>加成二</label>${buffSelect('buff2_type', r.buff2_type)}</div>
              <div class="field"><label>%</label><input name="buff2_pct" type="number" min="0" value="${r.buff2_pct ?? 0}"></div>
            </div>
            <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>
            <div class="field">${H.toggle('enabled', r.id ? r.enabled : 1, '啟用')}</div>
            <div class="hint">玩家同時只能裝備「總設定」裡設定的數量（預設 3 個），所以成就可以放心多做。</div>`,
          (back) => H.collect(back));

        body.innerHTML = `
          <div class="toolbar"><button class="btn" id="add">＋ 新增成就</button>
            <div class="spacer" style="flex:1"></div><span class="hint">共 ${rows.length} 個</span></div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>成就</th><th>解鎖條件</th><th>門檻</th><th>加成</th><th>獎金</th><th>狀態</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td>${UI.esc((r.emoji || '') + r.name)}<div class="hint" style="font-size:12px">${UI.esc(r.hint || r.description || '')}</div></td>
              <td>${r.metric ? UI.esc(metricLabel(r.metric)) : `收集數（${UI.esc(r.cat || '')}）`}</td>
              <td>${Number(r.need).toLocaleString('en-US')}</td>
              <td style="font-size:13px">${[
            r.buff_pct ? `${UI.esc(buffLabel(r.buff_type))} +${r.buff_pct}%` : '',
            r.buff2_pct ? `${UI.esc(buffLabel(r.buff2_type))} +${r.buff2_pct}%` : ''].filter(Boolean).join('<br>') || '—'}</td>
              <td>${r.reward_coins ? Number(r.reward_coins).toLocaleString('en-US') : '—'}</td>
              <td>${H.enabledTag(r.enabled)}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'affinity') {
        const rows = await GET('/home-affinity-levels');
        const c = crud('home-affinity-levels', '新增好感度階級',
          (r = {}) => `
            <div class="form-row">
              <div class="field"><label>階級</label><input name="level" type="number" min="1" value="${r.level ?? (rows.length + 1)}"></div>
              <div class="field"><label>名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="點頭之交"></div>
              <div class="field"><label>需要好感點數</label><input name="need" type="number" min="0" value="${r.need ?? 0}"></div>
            </div>
            <div class="field"><label>獎勵說明</label><input name="reward" value="${UI.esc(r.reward || '')}"></div>
            <div class="field"><label>到這一階解鎖的成就</label><select name="title_id">
              <option value="0">— 不給 —</option>
              ${meta.titles.map(t => `<option value="${t.id}" ${t.id == r.title_id ? 'selected' : ''}>${UI.esc((t.emoji || '') + t.name)}</option>`).join('')}
            </select></div>`,
          (back) => H.collect(back));

        body.innerHTML = `
          <div class="toolbar"><button class="btn" id="add">＋ 新增階級</button></div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>階</th><th>名稱</th><th>需要點數</th><th>獎勵</th><th>解鎖成就</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td>Lv.${r.level}</td><td>${UI.esc(r.name)}</td>
              <td>${Number(r.need).toLocaleString('en-US')}</td>
              <td>${UI.esc(r.reward || '—')}</td>
              <td>${UI.esc(((meta.titles.find(t => t.id == r.title_id) || {}).name) || '—')}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'stroll') {
        const roles = await GET('/stroll-roles');
        const authors = [...new Set(roles.map(r => (r.author || '').trim()))].sort();
        const onCount = roles.filter(r => r.stroll_ok && r.enabled).length;
        body.innerHTML = `
          <div class="card">
            <h3>🛍️ 誰會在逛街時出現</h3>
            <div class="hint" style="margin-bottom:10px">
              轉盤裡不是「角色」的項目（模擬器、活動介紹…），或不想讓他參與逛街的作者，可以在這裡排除。
              目前<b>${onCount}</b> 位角色會在逛街時出現（同居對象也只從這份名單裡抽）。
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
              <div class="field" style="max-width:220px;margin:0"><label>依作者批次設定</label>
                <select id="author">${authors.map(a => `<option value="${UI.esc(a)}">${UI.esc(a || '（沒有作者）')}（${roles.filter(r => (r.author || '').trim() === a).length}）</option>`).join('')}</select></div>
              <button class="btn small" id="aon">整個作者開放</button>
              <button class="btn small secondary" id="aoff">整個作者排除</button>
              <div class="spacer" style="flex:1"></div>
              <input id="kw" placeholder="搜尋角色名字" style="max-width:180px">
            </div>
            <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="list">
              <thead><tr><th>角色</th><th>作者</th><th>轉盤啟用</th><th>逛街出現</th></tr></thead>
              <tbody id="rlist">${roleRows(roles, '')}</tbody>
            </table></div>
          </div>`;
        const repaint = (kw) => { body.querySelector('#rlist').innerHTML = roleRows(roles, kw); bindRoleToggles(body); };
        body.querySelector('#kw').oninput = (e) => repaint(e.target.value);
        body.querySelector('#aon').onclick = async () => {
          await POST('/stroll-roles', { author: body.querySelector('#author').value, stroll_ok: true });
          UI.ok('已開放'); draw();
        };
        body.querySelector('#aoff').onclick = async () => {
          await POST('/stroll-roles', { author: body.querySelector('#author').value, stroll_ok: false });
          UI.ok('已排除'); draw();
        };
        bindRoleToggles(body);
        return;
      }

      if (tab === 'players') {
        const rows = await GET('/home-players');
        body.innerHTML = `
          <div class="table-wrap"><table class="list">
            <thead><tr><th>玩家</th><th>房屋</th><th>廚房</th><th>寵物</th><th>擺出家具</th><th>成就</th><th>累計簽到</th></tr></thead>
            <tbody>${rows.length ? rows.map(r => `<tr>
              <td>${UI.esc(r.username || r.user_id)}</td>
              <td>Lv.${r.level}</td><td>${r.kitchen_level ? 'Lv.' + r.kitchen_level : '—'}</td>
              <td>${r.pets}</td><td>${r.furniture}</td><td>${r.achievements}</td><td>${r.checkins} 天</td>
            </tr>`).join('') : '<tr><td colspan="7" class="hint">還沒有人開始蓋家園。</td></tr>'}
            </tbody></table></div>`;
        return;
      }
    };

    shell();
    draw();
  }
});
