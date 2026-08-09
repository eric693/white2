// ===== 經營系統：牧場（養動物、每日產出、偷偷樂）=====
App.page('ranch', {
  title: '牧場經營', sub: '養動物、每日產蛋/擠奶、收成賣 NPC、偷偷樂', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [c, animals, hatch, hopts, routes] = await Promise.all([
      GET('/ranch'), GET('/ranch-animals'), GET('/ranch-hatch'), GET('/ranch-hatch-options'), GET('/ranch-steal-routes')
    ]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const KINDNM = { fish: '釣魚', mine: '挖礦', wood: '伐木', forage: '採集', hunt: '狩獵', farm: '牧場產物' };

    el.innerHTML = `
      <div class="card" style="max-width:720px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用牧場經營系統')}</div>
        <div class="form-row">
          <div class="field"><label>初始牧場格數（其餘靠 /製作「蓋牧場」開；設 0＝一定要製作才有）</label><input name="max_slots" type="number" min="0" max="25" value="${c.max_slots ?? 0}"></div>
          <div class="field"><label>未收成最多累積幾天產量</label><input name="max_accrue_days" type="number" min="1" value="${c.max_accrue_days ?? 7}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">動物每天各自生產，玩家用 <code>/收成</code> 收進背包後可用 <code>/賣出</code> 賣給 NPC。
          累積上限是為了避免有人放著不理無限囤積。</div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>🕵️ 偷偷樂</h3>
        <div class="field">${H.toggle('steal_enabled', c.steal_enabled, '開放玩家去別人牧場偷未收成的產物')}</div>
        <div class="form-row">
          <div class="field"><label>每人每日可偷次數</label><input name="steal_daily_limit" type="number" min="0" value="${c.steal_daily_limit ?? 3}"></div>
          <div class="field"><label>偷取成功機率 %</label><input name="steal_success_pct" type="number" min="0" max="100" value="${c.steal_success_pct ?? 50}"></div>
          <div class="field"><label>成功時偷走對方未收成的 %<br><span class="hint">只有「按比例」模式會用到</span></label><input name="steal_take_pct" type="number" min="0" max="100" value="${c.steal_take_pct ?? 50}"></div>
        </div>
        <div class="field"><label>偷取模式</label>
          <select name="steal_mode">
            <option value="one" ${(c.steal_mode || 'one') === 'one' ? 'selected' : ''}>一次只偷 1 個（產物 1 個，或改成牽走 1 隻動物）</option>
            <option value="pct" ${c.steal_mode === 'pct' ? 'selected' : ''}>按比例（每一格各偷走下方的 %）</option>
          </select></div>
        <div class="hint" style="margin-bottom:10px">「一次只偷 1 個」＝被偷的人不會一次被清空，損失小很多；<b>搶到動物那次就不會再拿產物</b>。</div>
        <div class="field"><label>🐄 偷成功後，再把「整隻動物」也搶走的機率 %（0＝不會搶動物）</label><input name="steal_animal_pct" type="number" min="0" max="100" value="${c.steal_animal_pct ?? 0}"></div>
        <div class="field">${H.toggle('steal_guard', c.steal_guard, '看門狗／貓也可以被偷走（關閉＝防禦動物是安全區）')}</div>
        <div class="hint" style="margin-bottom:10px">開啟後連保鑣都會被搶。不過看門動物「這次成功咬到小偷」時，該次就不會被牽走任何動物，所以牠還是有機會自保。</div>
        <div class="field"><label>預設公告頻道（被偷者沒對應到下方路由時用這個；留空＝只私訊被偷的人）</label>${H.chanSelect('steal_channel', c.steal_channel || '')}</div>
        <div class="hint" style="margin-bottom:10px">只能偷「還沒被收成」的產物；已收成放進背包的不會被偷。失敗會空手而回，一樣算一次。成功偷竊會依「被偷者的身分組」把公告發到下方對應的頻道並 @ 該身分組。</div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>🥚 孵化室</h3>
        <div class="field"><label>初始孵化室格數（其餘靠 /製作「蓋孵化室」開；設 0＝一定要製作才有）</label><input name="hatch_slots" type="number" min="0" value="${c.hatch_slots ?? 0}"></div>
        <div class="hint" style="margin-bottom:10px">玩家用 <code>/孵化 蛋名稱</code> 把背包裡的蛋放進孵化室，時間到用 <code>/孵化室</code> 領取，孵出的動物直接住進牧場空格。蛋可以是動物生的，也可以是採集撿到的（下方「孵化對應」設定哪顆蛋孵成哪隻動物）。</div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🕵️ 偷竊公告路由（身分組 → 頻道）</h3>
          <button class="btn small" id="addroute">＋ 新增對應</button>
        </div>
        <div class="hint" style="margin:8px 0">被偷的人屬於哪個身分組，公告就發到對應的頻道並 @ 該身分組。一個群組配一個頻道，各自看各自的偷竊事件。沒對應到的就用上面的「預設公告頻道」。</div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>被偷者身分組</th><th>公告頻道</th><th></th></tr></thead>
          <tbody>
            ${routes.length ? routes.map(r => `<tr>
              <td>${UI.esc(H.roleName(r.role_id))}</td>
              <td>${UI.esc(H.chanName(r.channel_id))}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-eroute="${r.id}">編輯</button>
                <button class="btn tiny secondary" data-droute="${r.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="3" class="hint">尚無對應，成功偷竊都發到預設公告頻道。</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🐾 可購買的動物（畜牧商店）</h3>
          <button class="btn small" id="addanimal">＋ 新增動物</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>動物</th><th>售價</th><th>產物</th><th>每日產量</th><th>產物單價</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${animals.length ? animals.map(a => `<tr>
              <td>${UI.esc((a.emoji || '') + ' ' + a.name)}</td>
              <td>${coin(a.price)}</td>
              <td>${a.guard_pct > 0 ? `🛡️ 看門 ${a.guard_pct}%` : UI.esc((a.product_emoji || '') + ' ' + (a.product_name || '—'))}</td>
              <td>${a.guard_pct > 0 ? '—' : a.produce_per_day}</td>
              <td>${a.guard_pct > 0 ? `掉 ${a.guard_penalty}🪙` : coin(a.product_price)}</td>
              <td>${a.enabled ? '✅ 上架' : '⬜ 停售'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-eanimal="${a.id}">編輯</button>
                <button class="btn tiny secondary" data-danimal="${a.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="7" class="hint">尚無動物，按「新增動物」建立。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">產物會自動放進「牧場產物」類別，玩家的 <code>/背包</code> 看得到、<code>/賣出</code> 賣得掉。</div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🥚 孵化對應（蛋 → 動物）</h3>
          <button class="btn small" id="addhatch">＋ 新增孵化</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>蛋</th><th>孵出動物</th><th>孵化時間</th><th>失敗率</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${hatch.length ? hatch.map(h => `<tr>
              <td>${UI.esc((h.egg_emoji || '') + ' ' + (h.egg_name || '（已刪除物品）'))}</td>
              <td>${UI.esc((h.animal_emoji || '') + ' ' + (h.animal_name || '（已刪除動物）'))}</td>
              <td>${h.hatch_minutes} 分（約 ${(h.hatch_minutes / 60).toFixed(1)} 小時）</td>
              <td>${h.fail_pct > 0 ? h.fail_pct + '%' : '—'}</td>
              <td>${h.enabled ? '✅ 啟用' : '⬜ 停用'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-ehatch="${h.id}">編輯</button>
                <button class="btn tiny secondary" data-dhatch="${h.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="6" class="hint">尚無孵化對應。想讓採集撿到的蛋能孵化，先到「釣魚挖礦」把蛋加成掉落物，再回來這裡設定它孵成哪隻動物。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      const b = H.collect(el.querySelector('#cfgwrap'));
      await PUT('/ranch', b);
      UI.ok('已儲存設定'); App.go('ranch');
    };

    const animalForm = (a = {}) => `
      <div class="form-row">
        <div class="field"><label>動物名稱</label><input name="name" value="${UI.esc(a.name || '')}" placeholder="例如 雞"></div>
        <div class="field"><label>動物圖示</label><input name="emoji" value="${UI.esc(a.emoji || '')}" style="text-align:center" placeholder="🐔">${H.emojiPicker('input[name="emoji"]')}</div>
      </div>
      <div class="field"><label>售價（金幣）</label><input name="price" type="number" min="0" value="${a.price ?? 500}"></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="hint" style="margin-bottom:8px">🥚 <b>產蛋奶動物</b>：填下面產物欄。　🛡️ <b>看門動物（狗/貓）</b>：產物欄留空，把「看門機率」設 &gt;0。</div>
      <div class="form-row">
        <div class="field"><label>產物名稱（看門動物留空）</label><input name="product_name" value="${UI.esc(a.product_name || '')}" placeholder="例如 雞蛋"></div>
        <div class="field"><label>產物圖示</label><input name="product_emoji" value="${UI.esc(a.product_emoji || '')}" style="text-align:center" placeholder="🥚">${H.emojiPicker('input[name="product_emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>每日產量（一天總共產幾個）</label><input name="produce_per_day" type="number" min="0" value="${a.produce_per_day ?? 1}"></div>
        <div class="field"><label>產物賣出單價</label><input name="product_price" type="number" min="0" value="${a.product_price ?? 30}"></div>
      </div>
      <div class="field"><label>每產 1 個要幾分鐘（0＝用每日產量平均，例如每日 2 → 每 12 小時 1 個）</label>
        <input name="produce_interval_minutes" type="number" min="0" value="${a.produce_interval_minutes ?? 0}"></div>
      <div class="hint" style="margin-bottom:6px">每個產物各自計時，成熟一個就能收一個，不用等整批。</div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="form-row">
        <div class="field"><label>🛡️ 看門機率 %（0＝不看門）</label><input name="guard_pct" type="number" min="0" max="100" value="${a.guard_pct ?? 0}"></div>
        <div class="field"><label>看門懲罰（小偷最多掉幾星幣）</label><input name="guard_penalty" type="number" min="0" value="${a.guard_penalty ?? 0}"></div>
      </div>
      <div class="field"><label>排序（小的排前面）</label><input name="sort" type="number" value="${a.sort ?? 0}"></div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(a.description || '')}" placeholder="顯示在畜牧商店的一句話"></div>
      <div class="field">${H.toggle('enabled', a.enabled ?? 1, '上架（停售後玩家買不到，已擁有的不受影響）')}</div>`;

    const openAnimal = (a) => {
      const m = UI.modal({
        title: a ? '編輯動物' : '新增動物', bodyHTML: animalForm(a || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填動物名稱'); return false; }
          if (!b.product_name && !(parseInt(b.guard_pct, 10) > 0)) { UI.err('請填產物名稱；若是看門動物請把看門機率設 >0'); return false; }
          if (a) await PUT('/ranch-animals/' + a.id, b); else await POST('/ranch-animals', b);
          UI.ok('已儲存'); App.go('ranch');
        }
      });
      H.bindEmojiPickers(m.back);
    };

    el.querySelector('#addanimal').onclick = () => openAnimal(null);
    el.querySelectorAll('[data-eanimal]').forEach(b =>
      b.onclick = () => openAnimal(animals.find(x => x.id == b.dataset.eanimal)));
    el.querySelectorAll('[data-danimal]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這隻動物？玩家已養的這種動物也會一起移除（背包裡的存貨保留）。')) return;
      await DEL('/ranch-animals/' + b.dataset.danimal); UI.ok('已刪除'); App.go('ranch');
    });

    // ---- 孵化對應 ----
    const eggOptions = (sel) => hopts.items.map(it =>
      `<option value="${it.id}" ${sel == it.id ? 'selected' : ''}>${UI.esc((it.emoji || '') + ' ' + it.name + '（' + (KINDNM[it.kind] || it.kind) + '）')}</option>`).join('');
    const animalOptions = (sel) => hopts.animals.map(a =>
      `<option value="${a.id}" ${sel == a.id ? 'selected' : ''}>${UI.esc((a.emoji || '') + ' ' + a.name)}</option>`).join('');

    const hatchForm = (h = {}) => `
      <div class="field"><label>要孵化的蛋（任何物品都可以）</label>
        <select name="egg_item_id">${hopts.items.length ? eggOptions(h.egg_item_id) : '<option value="">（尚無物品，先到釣魚挖礦新增）</option>'}</select></div>
      <div class="field"><label>孵出的動物</label>
        <select name="animal_id">${hopts.animals.length ? animalOptions(h.animal_id) : '<option value="">（尚無動物，先在上方新增）</option>'}</select></div>
      <div class="form-row">
        <div class="field"><label>孵化時間（分鐘）</label><input name="hatch_minutes" type="number" min="1" value="${h.hatch_minutes ?? 240}"></div>
        <div class="field"><label>孵化失敗機率 %（0＝一定成功；失敗那顆蛋就沒了）</label><input name="fail_pct" type="number" min="0" max="100" value="${h.fail_pct ?? 0}"></div>
      </div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${h.sort ?? 0}"></div>
      <div class="field">${H.toggle('enabled', h.enabled ?? 1, '啟用此孵化對應')}</div>`;

    const openHatch = (h) => UI.modal({
      title: h ? '編輯孵化對應' : '新增孵化對應', bodyHTML: hatchForm(h || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.egg_item_id || !b.animal_id) { UI.err('請選擇蛋與動物'); return false; }
        if (h) await PUT('/ranch-hatch/' + h.id, b); else await POST('/ranch-hatch', b);
        UI.ok('已儲存'); App.go('ranch');
      }
    });

    el.querySelector('#addhatch').onclick = () => openHatch(null);
    el.querySelectorAll('[data-ehatch]').forEach(b =>
      b.onclick = () => openHatch(hatch.find(x => x.id == b.dataset.ehatch)));
    el.querySelectorAll('[data-dhatch]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個孵化對應？')) return;
      await DEL('/ranch-hatch/' + b.dataset.dhatch); UI.ok('已刪除'); App.go('ranch');
    });

    // ---- 偷竊公告路由 ----
    const routeForm = (r = {}) => `
      <div class="field"><label>被偷者的身分組</label>${H.roleSelect('role_id', r.role_id || '')}</div>
      <div class="field"><label>公告要發到的頻道</label>${H.chanSelect('channel_id', r.channel_id || '')}</div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${r.sort ?? 0}"></div>`;
    const openRoute = (r) => UI.modal({
      title: r ? '編輯對應' : '新增對應', bodyHTML: routeForm(r || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.role_id || !b.channel_id) { UI.err('請選身分組與頻道'); return false; }
        if (r) await PUT('/ranch-steal-routes/' + r.id, b); else await POST('/ranch-steal-routes', b);
        UI.ok('已儲存'); App.go('ranch');
      }
    });
    el.querySelector('#addroute').onclick = () => openRoute(null);
    el.querySelectorAll('[data-eroute]').forEach(b => b.onclick = () => openRoute(routes.find(x => x.id == b.dataset.eroute)));
    el.querySelectorAll('[data-droute]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個對應？')) return;
      await DEL('/ranch-steal-routes/' + b.dataset.droute); UI.ok('已刪除'); App.go('ranch');
    });
  }
});
