// ===== 家園與成就（後台）=====
// 小屋 15 階、家具、廚房與食譜、寵物、成就、好感度階級，全部改成後台可增刪改。
// 以前這些數值都埋在程式的預設清單裡，要調一個家具的加成就得改程式重啟。
App.page('home', {
  help: {
    "intro": "小屋（家園）等級、家具、廚房料理、寵物、成就、同居與逛街，玩家的居家系統都在這裡。",
    "steps": [
      "「等級」設每階的升級費用、家具上限與加成。",
      "「家具」設價格與加成，玩家要擺出來才有效果，收在倉庫沒有作用。",
      "「同居能力」決定每位角色搬進玩家家裡會帶什麼能力。",
      "同居角色可以指派一個「工作區域」（農地／溫室／牧場／孵化室／魚缸），一位角色就把那一區包辦到底。"
    ],
    "notes": [
      "寵物與同居的數量上限已於 2026-09 取消。房屋等級只決定玩家「能不能開始養／能不能邀請」，開了之後不限數量——改由寵物稅與同居稅的倍增累進節制（第 1 個基礎、第 2 個 ×2、第 3 個 ×4…），在稅金那一頁設定。",
      "工作區域是「一位角色顧一區、把該區完整自動化」：派到農地就收成＋重新播種，派到牧場就照顧＋收產物。一個區域只能派一位，一位角色也只能顧一區。",
      "必要物資不足時該動作自動暫停（沒種子就不播、沒飼料就不餵，收成與領取照常），補足後下一輪自然恢復，不必重新指派。",
      "工作是不間斷的：收成／照顧類（含工作區域）每 5 分鐘自動跑一次，成熟就收、收完就補種，田不會空著；只有「每日配給類」能力是每天早上 8:40 發一次。",
      "換人不會動到任何資料：指派只是一個欄位，設施、作物、動物與進度都在玩家自己身上。",
      "同居能力由後台決定，玩家沒得選：一位角色建議只勾 1 個，勾多個時會用排序最前面的那一個。",
      "改了某角色的能力，已經住進玩家家裡的也會跟著換，不用請玩家重搬。"
    ]
  },
  title: '小屋與成就', sub: '小屋（家園）15 階、簽到、家具、廚房料理、寵物、成就、同居與逛街，全部可直接改', module: 'home',

  async render(el) {
    const meta = await GET('/home-meta');
    const BUFFS = meta.buff_types;                 // [{key,label}]
    const METRICS = meta.metrics;                  // [{key,label,unit,derived}]
    const buffLabel = (k) => (BUFFS.find(b => b.key === k) || {}).label || k || '—';
    const metricLabel = (k) => (METRICS.find(m => m.key === k) || {}).label || k;

    const TABS = [
      ['config', '⚙️ 總設定'], ['levels', '🏠 小屋階級'], ['furniture', '🛋️ 家具'],
      ['kitchen', '🍳 廚房與料理'], ['pets', '🐾 寵物'], ['ach', '🏅 成就'],
      ['affinity', '💕 好感度'], ['giftpref', '🎁 角色喜好'], ['partner', '💞 同居能力'], ['roleskill', '🎭 角色能力'], ['stroll', '🛍️ 逛街角色'], ['strollev', '🎲 逛街事件'], ['partnerroles', '🏠 可同居角色'], ['players', '👥 玩家現況']
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
      open: (row = {}) => {
        const m = UI.modal({
          title: row.id ? `編輯：${row.name || row.level || ''}` : title,
          bodyHTML: formHTML(row),
          onOk: async (back) => {
            const body = toBody(back, row);
            try {
              if (row.id) await PUT(`/${path}/${row.id}`, body); else await POST(`/${path}`, body);
            } catch (e) { UI.err(e.message); return false; }
            UI.ok('已儲存'); draw();
          }
        });
        // after：開窗後才能綁的事件（例如表單裡自己會長出來的欄位）
        if (after) { try { after(m.back, row); } catch (e) { console.error(e); } }
        return m;
      },
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
              <div class="field"><label>遇到角色的機率 %</label><input name="stroll_role_pct" type="number" min="0" max="100" value="${c.stroll_role_pct ?? 25}">
                <div class="hint">其餘機率會抽「逛街事件」（撿到垃圾／零錢／白逛一圈…）。<b>逛街不一定有收穫，也不一定遇得到人</b>，設 100% 就會退回舊的「每次必定遇到角色」。</div></div>
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
              <div class="field"><label>房屋要到第幾階才能開始同居</label><input name="partner_level" type="number" min="0" value="${c.partner_level ?? 6}">
                <div class="hint">這是<b>門檻</b>，不是名額：到了這一階就能邀請，之後住幾位都不限。</div></div>
            </div>
            <div class="hint" style="margin-bottom:10px">
              <b>同居沒有數量上限</b>（2026-09 起取消），改由<b>同居稅</b>節制——稅是倍增累進的
              （第 1 位基礎、第 2 位 ×2、第 3 位 ×4⋯第 6 位就是基礎的 32 倍），養得起就儘管養。
              用錢節制比寫死名額好：不必為了多住一位去逼玩家把房子蓋到滿級。金額在「稅金」那一頁設定。<br>
              對象是<b>隨機</b>的（玩家不能挑要跟誰住，只能請他搬走再抽一次）—— 可以挑的話所有人都會選同一位。
            </div>

            <h3 style="margin-top:18px">🥫 寵物飼料</h3>
            <div class="field">${H.toggle('pet_food_enabled', c.pet_food_enabled ?? 1, '餵寵物要消耗飼料（關閉＝餵食免費，只有冷卻限制）')}</div>
            <div class="form-row">
              <div class="field"><label>飼料售價（每份）</label><input name="pet_food_price" type="number" min="1" value="${c.pet_food_price ?? 500}"></div>
              <div class="field"><label>餵一次消耗幾份</label><input name="pet_food_cost" type="number" min="1" value="${c.pet_food_cost ?? 1}"></div>
            </div>
            <div class="hint" style="margin-bottom:10px">玩家在寵物面板可以直接買（1／5／10 份），不用跑去別的商店。</div>

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
              <div class="field"><label>能力分類</label><select name="category">
                <option value="">— 不分類 —</option>
                ${[['guard', '🛡️ 全防護'], ['material', '📦 素材加成（要指定素材）'], ['stock', '📈 股市加成'],
                   ['sell', '💰 銷售加成'], ['rare', '✨ 稀有率提升'], ['speed', '⏱️ 生產加速'], ['resist', '🎲 反機率'], ['affinity', '💕 好感度加成']]
                  .map(([k, v]) => `<option value="${k}" ${k === r.category ? 'selected' : ''}>${v}</option>`).join('')}
              </select></div>
              <div class="field"><label>滿親密度時的 %</label><input name="buff_pct" type="number" min="0" value="${r.buff_pct ?? 0}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>📦 指定素材（選了就是「這一種素材的掉落率 +X%」）</label>
                <select name="target_item">
                  <option value="">— 不指定（用下面的通用能力）—</option>
                  ${meta.items.map(it => `<option value="${UI.esc(it.name)}" ${it.name === r.target_item ? 'selected' : ''}>${UI.esc((it.emoji || '') + it.name)}</option>`).join('')}
                </select></div>
              <div class="field"><label>通用能力（沒指定素材時才用）</label>${buffSelect('buff_type', r.buff_type)}</div>
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
              <td>${r.buff_pct
        ? `${r.target_item ? UI.esc(r.target_item) + ' 掉落率' : UI.esc(buffLabel(r.buff_type))} +${r.buff_pct}%`
        : '—'}</td>
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

      if (tab === 'partner') {
        const rows = await GET('/home-partner-skills');
        const meta = await GET('/home-meta');
        const abil = meta.abilities || [];
        const abilOf = (code) => abil.find(a => a.code === code) || null;
        const UNIT = { count: '數量（個）', coins: '金額（星幣）', pct: '百分比（%）', none: '不需數值' };
        // 好感階段數值：後台每一列填「好感度到第幾階 → 數值」，由低到高
        const tierRows = (t) => (t || []).map((x, n) => `
          <div class="form-row tier-row" data-n="${n}">
            <div class="field"><label>好感階級 ≥</label><input class="t-lv" type="number" min="0" value="${x.lv ?? 0}"></div>
            <div class="field"><label>數值下限</label><input class="t-min" type="number" value="${x.min ?? 0}"></div>
            <div class="field"><label>數值上限</label><input class="t-max" type="number" value="${x.max ?? 0}"></div>
            <button type="button" class="btn tiny danger t-del" style="align-self:flex-end;margin-bottom:6px">刪</button>
          </div>`).join('');
        const parseTiers = (r) => { try { return JSON.parse(r.tiers || '[]'); } catch { return []; } };

        const c = crud('home-partner-skills', '新增同居能力',
          (r = {}) => {
            const a = abilOf(r.code);
            return `
            <div class="field"><label>能力行為</label><select name="code">
              <option value="">— 請選擇 —</option>
              ${abil.map(x => `<option value="${x.code}" ${r.code === x.code ? 'selected' : ''}>${x.kind_label}｜${UI.esc(x.name)}（${UI.esc(x.desc)}）</option>`).join('')}
            </select>
              <div class="hint">程式支援的 18 種行為。分類與加成種類會跟著這個選擇自動決定。</div></div>
            <div class="form-row">
              <div class="field"><label>顯示名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="⛏️ 挖礦助手"></div>
              <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>基礎數值下限</label><input name="val_min" type="number" min="0" value="${r.val_min ?? 0}"></div>
              <div class="field"><label>基礎數值上限</label><input name="val_max" type="number" min="0" value="${r.val_max ?? 0}">
                <div class="hint">${a ? UI.esc(UNIT[a.unit] || '') : '選好能力行為後會說明單位'}。上下限相同＝固定值。</div></div>
            </div>
            <div class="field"><label>好感階段數值（可留空＝一律用基礎數值）</label>
              <div id="tiers">${tierRows(parseTiers(r))}</div>
              <button type="button" class="btn tiny secondary" id="tadd">＋ 新增一階</button>
              <div class="hint">好感度到第幾階就換成那一階的數值。例：低好感 ×5、階級 8 起 ×7、階級 10 起 ×10。</div></div>
            <div class="field"><label>補充說明（玩家選單看得到）</label><input name="description" value="${UI.esc(r.description || '')}"></div>
            <div class="field">${H.toggle('enabled', r.id ? r.enabled : 1, '啟用（角色可以選）')}</div>`;
          },
          (back) => {
            const f = H.collect(back);
            f.tiers = [...back.querySelectorAll('.tier-row')].map(row => ({
              lv: row.querySelector('.t-lv').value,
              min: row.querySelector('.t-min').value,
              max: row.querySelector('.t-max').value
            }));
            return f;
          },
          // crud 開窗後綁定「新增一階／刪一階」
          (back) => {
            const box = back.querySelector('#tiers');
            const bind = () => back.querySelectorAll('.t-del').forEach(b => b.onclick = () => { b.closest('.tier-row').remove(); });
            back.querySelector('#tadd').onclick = () => {
              const n = box.querySelectorAll('.tier-row').length;
              box.insertAdjacentHTML('beforeend', `
                <div class="form-row tier-row" data-n="${n}">
                  <div class="field"><label>好感階級 ≥</label><input class="t-lv" type="number" min="0" value="0"></div>
                  <div class="field"><label>數值下限</label><input class="t-min" type="number" value="0"></div>
                  <div class="field"><label>數值上限</label><input class="t-max" type="number" value="0"></div>
                  <button type="button" class="btn tiny danger t-del" style="align-self:flex-end;margin-bottom:6px">刪</button>
                </div>`);
              bind();
            };
            bind();
          });

        const valText = (r) => {
          const a = abilOf(r.code);
          if (!a || a.unit === 'none') return '—';
          const t = parseTiers(r);
          const base = r.val_min === r.val_max ? `${r.val_min}` : `${r.val_min}～${r.val_max}`;
          const grow = t.length ? `　→ ${t.map(x => `Lv.${x.lv}：${x.min === x.max ? x.min : `${x.min}～${x.max}`}`).join('／')}` : '';
          return `${base}${a.unit === 'pct' ? '%' : ''}${grow}`;
        };

        body.innerHTML = `
          <div class="toolbar">
            <button class="btn" id="add">＋ 新增能力</button>
            <button class="btn secondary" id="seed">📥 匯入／補齊預設 18 種能力</button>
            <div class="spacer" style="flex:1"></div><span class="hint">共 ${rows.length} 種</span>
          </div>
          <div class="hint" style="margin-bottom:10px">
            這裡是<b>能力池</b>：定義有哪些能力、數值多少、怎麼隨好感度成長。<br>
            哪一位角色可以用哪些能力，到「🎭 角色能力」分頁勾選；玩家同居後只能從勾選的候選裡<b>啟用 1 個</b>。
          </div>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>能力</th><th>分類</th><th>數值</th><th>狀態</th><th></th></tr></thead>
            <tbody>${rows.length ? rows.map(r => {
              const a = abilOf(r.code);
              return `<tr>
              <td>${UI.esc(r.name)}${r.code ? '' : ' <span class="hint">（舊資料，請重設能力行為）</span>'}</td>
              <td>${a ? UI.esc(a.kind_label) : '—'}</td>
              <td>${UI.esc(valText(r))}</td>
              <td>${H.enabledTag(r.enabled)}</td>
              <td><button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-del="${r.id}">刪除</button></td></tr>`;
            }).join('')
        : '<tr><td colspan="5" class="hint">還沒有能力。按上面的「匯入預設 18 種能力」開始。</td></tr>'}
            </tbody></table></div>`;
        body.querySelector('#add').onclick = () => c.open();
        body.querySelector('#seed').onclick = async () => {
          const r = await POST('/home-partner-skills/seed', {});
          UI.ok(r.count ? `已補進 ${r.count} 種` : '已經是最新的了'); draw();
        };
        bindRows(body, c, rows);
        return;
      }

      if (tab === 'giftpref') {
        const d = await GET('/gift-prefs');
        const byRole = new Map();
        for (const p of d.prefs) {
          if (!byRole.has(p.role_id)) byRole.set(p.role_id, new Map());
          byRole.get(p.role_id).set(p.item, p.weight);
        }
        const emo = (w) => w >= 200 ? '💖' : w >= 150 ? '💕' : w <= 50 ? '💔' : '🤍';
        const itemEmoji = new Map(d.items.map(it => [it.name, it.emoji || '']));
        const roleRow = (r) => {
          const m = byRole.get(r.id) || new Map();
          const love = [...m].filter(([, w]) => w >= 200), like = [...m].filter(([, w]) => w >= 150 && w < 200), hate = [...m].filter(([, w]) => w <= 50);
          const show = (arr) => arr.map(([it]) => UI.esc((itemEmoji.get(it) || '') + it)).join('、') || '—';
          return `<tr data-role="${r.id}">
            <td>${UI.esc(r.name)}<div class="hint">${UI.esc(r.author || '')}</div></td>
            <td class="wrap" style="font-size:13px">💖 ${show(love)}</td>
            <td class="wrap" style="font-size:13px">💕 ${show(like)}</td>
            <td class="wrap" style="font-size:13px">💔 ${show(hate)}</td>
            <td><button class="btn tiny secondary" data-pref="${r.id}">設定喜好</button></td></tr>`;
        };
        body.innerHTML = `
          <div class="card">
            <h3>🎁 每位角色喜歡什麼禮物</h3>
            <div class="hint" style="margin-bottom:10px">
              送禮拿到的好感 ＝ <b>禮物的基礎好感 × 這裡的倍率</b>。
              💖 最喜歡 ×2、💕 喜歡 ×1.5、🤍 普通 ×1、💔 討厭 ×0.5。<br>
              玩家<b>送過才會知道</b>是哪些（會記進送禮圖鑑），所以這裡是「答案」，不會直接公開給玩家看。
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
              <input id="kw" placeholder="搜尋角色名字" style="max-width:200px">
              <button class="btn small secondary" id="randnew">🎲 幫還沒設定的角色隨機產生</button>
              <button class="btn small secondary" id="randall">🎲 全部重新隨機</button>
              <div class="spacer" style="flex:1"></div>
              <span class="hint">共 ${d.roles.length} 位角色｜${d.items.length} 種可送禮物</span>
            </div>
            <div class="table-wrap" style="max-height:520px;overflow:auto"><table class="list">
              <thead><tr><th>角色</th><th>最喜歡</th><th>喜歡</th><th>討厭</th><th></th></tr></thead>
              <tbody id="plist">${d.roles.map(roleRow).join('')}</tbody>
            </table></div>
          </div>`;
        const bindPref = () => body.querySelectorAll('[data-pref]').forEach(b => b.onclick = () => {
          const rid = parseInt(b.dataset.pref, 10);
          const role = d.roles.find(x => x.id === rid);
          const m = byRole.get(rid) || new Map();
          UI.modal({
            title: `${role.name}　喜歡的禮物`,
            bodyHTML: `
              <div class="hint" style="margin-bottom:8px">沒特別設定的就是 🤍 普通（×1），不用每個都選。</div>
              <div id="pf" style="display:flex;flex-direction:column;gap:6px;max-height:55vh;overflow:auto">
                ${d.items.map(it => `
                  <div class="form-row" style="align-items:center;gap:8px;margin:0">
                    <div style="flex:1">${UI.esc((it.emoji || '') + it.name)}<span class="hint">　基礎 +${it.gift_aff}</span></div>
                    <select data-item="${UI.esc(it.name)}" style="max-width:170px">
                      ${(() => {
                        // 目前的權重可能不是這四個標準值（工藝禮物的預設是 260／300）。
                        // 以前沒把它列進選項 → 下拉選不到、瀏覽器自動落到第一個「最喜歡 200」，
                        // 一按儲存就把 260 悄悄壓成 200（玩家會覺得好感度莫名變少）。
                        const cur = m.get(it.name) || 100;
                        const levels = d.levels.some(l => l.weight === cur)
                          ? d.levels
                          : [{ weight: cur, label: `⭐ 目前設定（×${(cur / 100).toFixed(cur % 100 ? 1 : 0)}）` }, ...d.levels];
                        return levels.map(l => `<option value="${l.weight}" ${cur === l.weight ? 'selected' : ''}>${l.label}</option>`).join('');
                      })()}
                    </select>
                  </div>`).join('')}
              </div>`,
            onOk: async (back) => {
              const prefs = [...back.querySelectorAll('#pf select')].map(sel => ({
                item: sel.dataset.item, weight: parseInt(sel.value, 10)
              }));
              await POST('/gift-prefs', { role_id: rid, prefs });
              UI.ok('已儲存'); draw();
            }
          });
        });
        body.querySelector('#kw').oninput = (e) => {
          const kw = e.target.value.trim();
          body.querySelector('#plist').innerHTML = d.roles.filter(r => !kw || (r.name || '').includes(kw)).map(roleRow).join('');
          bindPref();
        };
        body.querySelector('#randnew').onclick = async () => {
          if (!await UI.confirm('幫「還沒設定過喜好」的角色隨機產生（每位 3 個最喜歡、3 個喜歡、2 個討厭）？已設定的不會動。')) return;
          const out = await POST('/gift-prefs/randomize', { only_empty: true });
          UI.ok(`已產生 ${out.roles} 位`); draw();
        };
        body.querySelector('#randall').onclick = async () => {
          if (!await UI.confirm('全部角色重新隨機一次？現有的喜好設定會被覆蓋，玩家已經送過探索出來的答案也會跟著改變。')) return;
          const out = await POST('/gift-prefs/randomize', {});
          UI.ok(`已重新產生 ${out.roles} 位`); draw();
        };
        bindPref();
        return;
      }

      if (tab === 'roleskill') {
        const d = await GET('/role-skills');
        const skills = d.skills.filter(x => x.enabled);
        const byRole = new Map();
        for (const p of d.picked) {
          if (!byRole.has(p.role_id)) byRole.set(p.role_id, new Set());
          byRole.get(p.role_id).add(p.skill_id);
        }
        const roleRow = (r) => {
          const set = byRole.get(r.id) || new Set();
          return `<tr data-role="${r.id}">
            <td>${UI.esc(r.name)}<div class="hint">${UI.esc(r.author || '')}</div></td>
            <td>${set.size ? `${set.size} 種` : '<span class="hint">未設定＝全部可選</span>'}</td>
            <td><button class="btn tiny secondary" data-pick="${r.id}">設定能力</button></td></tr>`;
        };
        body.innerHTML = `
          <div class="card">
            <h3>🎭 每位角色的專屬能力</h3>
            <div class="hint" style="margin-bottom:10px">
              這裡決定<b>每位角色同居時會帶什麼能力</b> —— 玩家沒得選，搬進來就直接套用你設定的能力。<br>
              建議<b>一位角色只勾 1 個</b>；勾多個時會用排序最前面的那一個。<br>
              一個都沒勾＝自動用能力清單最前面的那個，所以<b>新增角色不必先設定也能用</b>。<br>
              改了之後<b>已經住進玩家家裡的角色也會跟著換</b>，不用請玩家重搬。
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
              <input id="kw" placeholder="搜尋角色名字" style="max-width:200px">
              <div class="spacer" style="flex:1"></div>
              <span class="hint">共 ${d.roles.length} 位角色｜${skills.length} 種可用能力</span>
            </div>
            <div class="table-wrap" style="max-height:520px;overflow:auto"><table class="list">
              <thead><tr><th>角色</th><th>已勾選</th><th></th></tr></thead>
              <tbody id="rlist">${d.roles.map(roleRow).join('')}</tbody>
            </table></div>
          </div>`;
        const bindPick = () => body.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
          const rid = parseInt(b.dataset.pick, 10);
          const role = d.roles.find(x => x.id === rid);
          const set = byRole.get(rid) || new Set();
          UI.modal({
            title: `${role.name}　可用能力`,
            bodyHTML: `
              <div class="hint" style="margin-bottom:8px">全部不勾＝所有能力都能選。</div>
              <div id="sk" style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow:auto">
                ${skills.map(x => `<label style="display:flex;gap:8px;align-items:center">
                  <input type="checkbox" value="${x.id}" ${set.has(x.id) ? 'checked' : ''}>${UI.esc(x.name)}</label>`).join('')}
              </div>`,
            onOk: async (back) => {
              const ids = [...back.querySelectorAll('#sk input:checked')].map(x => parseInt(x.value, 10));
              await POST('/role-skills', { role_id: rid, skill_ids: ids });
              UI.ok('已儲存'); draw();
            }
          });
        });
        body.querySelector('#kw').oninput = (e) => {
          const kw = e.target.value.trim();
          body.querySelector('#rlist').innerHTML = d.roles
            .filter(r => !kw || (r.name || '').includes(kw)).map(roleRow).join('');
          bindPick();
        };
        bindPick();
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
              目前<b>${onCount}</b> 位角色會在逛街時出現。<br>同居對象是另一份名單（見「🏠 可同居角色」），兩者已經完全分開。
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

      if (tab === 'strollev') {
        const { rows, items } = await GET('/stroll-events');
        const total = rows.filter(r => r.enabled).reduce((a, r) => a + r.weight, 0) || 1;
        const itemOpts = (sel) => `<option value="0">— 不給物品 —</option>`
          + items.map(it => `<option value="${it.id}" ${it.id === sel ? 'selected' : ''}>${UI.esc((it.emoji || '') + it.name)}（${it.price}）</option>`).join('');
        const row = (r) => `<tr data-ev="${r.id}">
          <td><input name="emoji" value="${UI.esc(r.emoji || '')}" style="width:56px"></td>
          <td><input name="name" value="${UI.esc(r.name)}" style="min-width:120px"></td>
          <td><input name="text" value="${UI.esc(r.text || '')}" style="min-width:240px"></td>
          <td><select name="item_id">${itemOpts(r.item_id)}</select>
              <input name="qty" type="number" min="1" value="${r.qty || 1}" style="width:60px"></td>
          <td><input name="coins" type="number" value="${r.coins || 0}" style="width:90px"></td>
          <td><input name="weight" type="number" min="0" value="${r.weight}" style="width:70px">
              <div class="hint">${((r.enabled ? r.weight : 0) / total * 100).toFixed(1)}%</div></td>
          <td><label class="switch"><input name="enabled" type="checkbox" ${r.enabled ? 'checked' : ''}></label></td>
          <td><button class="btn small" data-save="${r.id}">儲存</button>
              <button class="btn small danger" data-del="${r.id}">刪除</button></td>
        </tr>`;
        body.innerHTML = `
          <div class="card">
            <h3>🎲 逛街隨機事件</h3>
            <div class="hint" style="margin-bottom:10px">
              沒有遇到角色的時候，就從這張表抽一個結果。機率＝該事件權重 ÷ 全部啟用事件的權重總和。<br>
              星幣可以填<b>負數</b>（例如「被路邊攤坑了」）。撿到的物品會直接進背包；那個物品能不能賣、
              回收價多少，到「釣魚挖礦 → 物品」頁改就好。<br>
              遇到角色的機率在「⚙️ 設定」分頁調整。
            </div>
            <div class="table-wrap"><table class="list">
              <thead><tr><th>圖示</th><th>名稱</th><th>玩家看到的文字</th><th>撿到物品／數量</th><th>星幣</th><th>權重</th><th>啟用</th><th></th></tr></thead>
              <tbody id="evlist">${rows.map(row).join('') || '<tr><td colspan="8" class="hint">還沒有事件</td></tr>'}</tbody>
            </table></div>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
              <div class="field" style="margin:0;max-width:70px"><label>圖示</label><input id="nemoji" value="🛍️"></div>
              <div class="field" style="margin:0;max-width:160px"><label>名稱</label><input id="nname" placeholder="例如 撿到雨傘"></div>
              <div class="field" style="margin:0;flex:1;min-width:200px"><label>文字</label><input id="ntext" placeholder="玩家會看到的那句話"></div>
              <div class="field" style="margin:0;max-width:100px"><label>星幣</label><input id="ncoins" type="number" value="0"></div>
              <div class="field" style="margin:0;max-width:90px"><label>權重</label><input id="nweight" type="number" min="0" value="10"></div>
              <button class="btn" id="addev">新增事件</button>
            </div>
          </div>`;
        const readRow = (tr) => ({
          emoji: tr.querySelector('[name=emoji]').value,
          name: tr.querySelector('[name=name]').value,
          text: tr.querySelector('[name=text]').value,
          item_id: Number(tr.querySelector('[name=item_id]').value) || 0,
          qty: Number(tr.querySelector('[name=qty]').value) || 1,
          coins: Number(tr.querySelector('[name=coins]').value) || 0,
          weight: Number(tr.querySelector('[name=weight]').value) || 0,
          enabled: tr.querySelector('[name=enabled]').checked
        });
        body.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
          try { await PUT(`/stroll-events/${b.dataset.save}`, readRow(b.closest('tr'))); UI.ok('已儲存'); draw(); }
          catch (e) { UI.err(e.message); }
        });
        body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
          if (!confirm('確定刪除這個事件？')) return;
          try { await DEL(`/stroll-events/${b.dataset.del}`); UI.ok('已刪除'); draw(); }
          catch (e) { UI.err(e.message); }
        });
        body.querySelector('#addev').onclick = async () => {
          const name = body.querySelector('#nname').value.trim();
          if (!name) return UI.err('請填事件名稱');
          try {
            await POST('/stroll-events', {
              emoji: body.querySelector('#nemoji').value, name,
              text: body.querySelector('#ntext').value,
              coins: Number(body.querySelector('#ncoins').value) || 0,
              weight: Number(body.querySelector('#nweight').value) || 10
            });
            UI.ok('已新增'); draw();
          } catch (e) { UI.err(e.message); }
        };
        return;
      }

      if (tab === 'partnerroles') {
        const roles = await GET('/partner-roles');
        const authors = [...new Set(roles.map(r => (r.author || '').trim()))].sort();
        const onCount = roles.filter(r => r.partner_ok && r.enabled).length;
        const rows = (list, kw) => list
          .filter(r => !kw || (r.name || '').includes(kw) || (r.author || '').includes(kw))
          .map(r => `<tr>
            <td>${UI.esc(r.name)}</td>
            <td style="font-size:13px">${UI.esc(r.author || '')}</td>
            <td>${r.enabled ? '✅' : '<span class="hint">停用</span>'}</td>
            <td><label class="switch"><input type="checkbox" data-prole="${r.id}" ${r.partner_ok ? 'checked' : ''}> ${r.partner_ok ? '可同居' : '不可'}</label></td>
          </tr>`).join('') || '<tr><td colspan="4" class="hint">找不到符合的角色</td></tr>';
        const bind = () => body.querySelectorAll('[data-prole]').forEach(cb => cb.onchange = async () => {
          try {
            await POST('/partner-roles', { ids: [Number(cb.dataset.prole)], partner_ok: cb.checked });
            cb.parentElement.lastChild.textContent = cb.checked ? ' 可同居' : ' 不可';
          } catch (e) { UI.err(e.message); cb.checked = !cb.checked; }
        });
        body.innerHTML = `
          <div class="card">
            <h3>🏠 誰可以被邀請同居</h3>
            <div class="hint" style="margin-bottom:10px">
              轉盤與同居已經完全分開：轉盤可以放其他創作者的角色，但<b>抽到不會自動變成同居對象</b>。
              誰能被娶回家由這裡決定。目前 <b>${onCount}</b> 位角色可同居。<br>
              同居人數沒有上限，改由<b>同居稅</b>倍增累進節制（第 1 位基礎、第 2 位 ×2、第 3 位 ×4…）。
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
              <div class="field" style="max-width:220px;margin:0"><label>依作者批次設定</label>
                <select id="pauthor">${authors.map(a => `<option value="${UI.esc(a)}">${UI.esc(a || '（沒有作者）')}（${roles.filter(r => (r.author || '').trim() === a).length}）</option>`).join('')}</select></div>
              <button class="btn small" id="pon">整個作者開放</button>
              <button class="btn small secondary" id="poff">整個作者排除</button>
              <div class="spacer" style="flex:1"></div>
              <input id="pkw" placeholder="搜尋角色或作者" style="max-width:180px">
            </div>
            <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="list">
              <thead><tr><th>角色</th><th>作者</th><th>轉盤啟用</th><th>可否同居</th></tr></thead>
              <tbody id="prlist">${rows(roles, '')}</tbody>
            </table></div>
          </div>`;
        body.querySelector('#pkw').oninput = (e) => { body.querySelector('#prlist').innerHTML = rows(roles, e.target.value.trim()); bind(); };
        body.querySelector('#pon').onclick = async () => {
          await POST('/partner-roles', { author: body.querySelector('#pauthor').value, partner_ok: true });
          UI.ok('已開放'); draw();
        };
        body.querySelector('#poff').onclick = async () => {
          await POST('/partner-roles', { author: body.querySelector('#pauthor').value, partner_ok: false });
          UI.ok('已排除'); draw();
        };
        bind();
        return;
      }

      if (tab === 'players') {
        const rows = await GET('/home-players');
        body.innerHTML = `
          <div class="table-wrap"><table class="list">
            <thead><tr><th>玩家</th><th>房屋</th><th>廚房</th><th>寵物</th><th>擺出家具</th><th>成就</th><th>累計簽到</th><th></th></tr></thead>
            <tbody>${rows.length ? rows.map(r => `<tr>
              <td>${H.who(r.user_id, r.username)}</td>
              <td>Lv.${r.level}</td><td>${r.kitchen_level ? 'Lv.' + r.kitchen_level : '—'}</td>
              <td>${r.pets}</td><td>${r.furniture}</td><td>${r.achievements}</td><td>${r.checkins} 天</td>
              <td><button class="btn tiny secondary" data-lv="${r.user_id}" data-name="${UI.esc(r.username || '')}"
                    data-cur="${r.level}" data-k="${r.kitchen_level || 0}">調整等級</button></td>
            </tr>`).join('') : '<tr><td colspan="8" class="hint">還沒有人開始蓋家園。</td></tr>'}
            </tbody></table></div>`;
        body.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => UI.modal({
          title: `調整「${b.dataset.name || b.dataset.lv}」的等級`,
          bodyHTML: `
            <div class="hint" style="margin-bottom:8px">用便宜的價格硬升上去要退回、或活動補償都用這裡。</div>
            <div class="form-row">
              <div class="field"><label>家園階級（目前 ${b.dataset.cur}）</label><input name="level" type="number" min="1" value="${b.dataset.cur}"></div>
              <div class="field"><label>廚房等級（目前 ${b.dataset.k}，0＝沒有廚房）</label><input name="kitchen_level" type="number" min="0" value="${b.dataset.k}"></div>
            </div>
            <div class="field"><label>順便退錢給他（0＝不退）</label><input name="refund" type="number" min="0" value="0"></div>`,
          onOk: async (back) => {
            await POST(`/home-players/${b.dataset.lv}/level`, H.collect(back));
            UI.ok('已調整'); draw();
          }
        }));
        return;
      }
    };

    shell();
    draw();
  }
});
