// ===== 特殊兌換商店 =====
App.page('special', {
  title: '特殊商店', sub: '花星幣兌換虛擬獎勵，兌換後通知管理員處理', module: 'special',

  async render(el) {
    await H.loadMeta();
    const [c, items, redeems, shops] = await Promise.all([
      GET('/special'), GET('/special-items'), GET('/special-redeems'), GET('/special-shops')
    ]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const selRoles = (c.admin_roles || '').split(',').filter(Boolean);
    const shopName = (id) => { const s = shops.find(x => x.id == id); return s ? (s.emoji || '') + s.name : '其他'; };

    // 身分組多選盒（可重用：全域預設 & 每家店各自綁定）。文字直接放 label，避免被 .field label 樣式吃掉。
    const roleBox = (dataAttr, csvSel) => {
      const sel = (csvSel || '').split(',').filter(Boolean);
      const inner = (H.roles || []).map(r =>
        `<label style="display:inline-flex;align-items:center;gap:5px;margin:0;color:var(--text);font-size:13px;white-space:nowrap;cursor:pointer">
          <input type="checkbox" ${dataAttr} value="${r.id}" ${sel.includes(r.id) ? 'checked' : ''} style="margin:0"> @${UI.esc(r.name)}</label>`).join('');
      return `<div style="max-height:170px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;flex-wrap:wrap;gap:6px 16px">${inner || '<span class="hint">此伺服器沒有身分組</span>'}</div>`;
    };

    el.innerHTML = `
      <div class="card" style="max-width:760px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用特殊兌換商店')}</div>
        <div class="form-row">
          <div class="field"><label>每人每項兌換上限（0＝不限）</label><input name="per_item_limit" type="number" min="0" value="${c.per_item_limit ?? 0}">
            <div class="hint">例如填 5：每個玩家「每一項商品」各最多換 5 份。單一商品可在下方商品設定裡另外覆寫。</div></div>
          <div class="field"><label>上限／累進的重置週期</label>
            <select name="limit_reset">
              <option value="month" ${(c.limit_reset||'month')==='month'?'selected':''}>每月 1 號歸零</option>
              <option value="biweek" ${c.limit_reset==='biweek'?'selected':''}>每兩週的週一歸零</option>
              <option value="week" ${c.limit_reset==='week'?'selected':''}>每週一歸零</option>
              <option value="none" ${c.limit_reset==='none'?'selected':''}>永不重置（一輩子就這些）</option>
            </select></div>
        </div>
        <div class="form-row">
          <div class="field">${H.toggle('price_escalate', c.price_escalate, '累進價格（同一項越換越貴）')}
            <div class="hint">第 1 份原價，第 2 份 ×倍率，第 3 份 ×倍率²…重置後回到原價。</div></div>
          <div class="field"><label>累進倍率</label><input name="escalate_mult" type="number" min="1" max="100" step="0.5" value="${c.escalate_mult ?? 2}">
            <div class="hint">填 2 就是每次翻倍：5,000 → 10,000 → 20,000 → 40,000…</div></div>
        </div>
        <div class="field"><label>兌換通知要發到哪</label>
          <select name="notify_mode">
            <option value="shop" ${(c.notify_mode||'shop')==='shop'?'selected':''}>商店頻道（公開，大家都看得到誰換了什麼）</option>
            <option value="dm" ${c.notify_mode==='dm'?'selected':''}>只私訊管理員（不公開，推薦）</option>
            <option value="log" ${c.notify_mode==='log'?'selected':''}>只發到下方的「預設通知頻道」（建議設成管理員專用頻道）</option>
          </select>
          <div class="hint">玩家自己看到的兌換結果一律只有他本人看得到，這裡只決定「通知管理員」的方式。</div></div>
        <div class="field"><label>預設要標記的管理員身分組（可複選，商店沒自訂時用這組）</label>
          ${roleBox('data-adminrole', c.admin_roles)}</div>
        <div class="field"><label>預設通知頻道（商店/商品沒設頻道時用這個）</label>${H.chanSelect('log_channel', c.log_channel)}</div>
        <div class="field">${H.toggle('channel_scoped', c.channel_scoped, '頻道限定：在有綁分店的頻道，只顯示／只能兌換該分店的商品')}</div>
        <div class="hint" style="margin-bottom:10px">開啟後，玩家在某間分店綁定的頻道打 <code>/特殊商店</code> 只會看到那間店（未分類商品也不列）；<b>沒綁分店的頻道維持顯示全部</b>。分店的頻道在下方每間商店裡設定。</div>
        <div class="hint" style="margin-bottom:10px">玩家 <code>/兌換</code> 後，機器人會把兌換通知貼到頻道並 @ 管理員：<b>優先用該商品所屬「商店」綁定的頻道與身分組</b>，沒設才用這裡的預設。由人工處理，避免私下代幣交易。</div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🏪 商店（可多開，各自發布到指定頻道）</h3>
          <button class="btn small" id="addshop">＋ 新增商店</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>商店</th><th>頻道</th><th>標記身分組</th><th>商品數</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${shops.length ? shops.map(s => `<tr>
              <td>${UI.esc((s.emoji || '') + ' ' + s.name)}${s.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(s.description)}</div>` : ''}</td>
              <td>${s.channel_id ? UI.esc(H.chanName(s.channel_id)) : '<span class="hint">未設定</span>'}</td>
              <td>${(s.notify_roles || '').split(',').filter(Boolean).map(id => UI.esc(H.roleName(id))).join('、') || '<span class="hint">用預設</span>'}</td>
              <td>${items.filter(it => it.shop_id == s.id).length}</td>
              <td>${s.enabled ? '✅' : '⬜'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny" data-pubshop="${s.id}">發布/更新面板</button>
                <button class="btn tiny secondary" data-eshop="${s.id}">編輯</button>
                <button class="btn tiny secondary" data-dshop="${s.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="6" class="hint">尚無商店。先「新增商店」設定頻道，再把商品歸到這間店，然後按「發布面板」。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">「發布面板」會把該店商品清單貼到它的頻道，玩家可從面板的下拉選單直接兌換（也可用 <code>/兌換</code>）。改內容後再按一次會更新同一則訊息。</div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🎁 兌換商品</h3>
          <button class="btn small" id="additem">＋ 新增商品</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>商品</th><th>所屬商店</th><th>價格</th><th>兌換通知頻道</th><th>對應身分組</th><th>庫存</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${items.length ? items.map(it => `<tr>
              <td>${UI.esc((it.emoji || '') + ' ' + it.name)}</td>
              <td>${UI.esc(shopName(it.shop_id))}</td>
              <td>${coin(it.price)}</td>
              <td>${it.channel_id ? UI.esc(H.chanName(it.channel_id)) : '<span class="hint">用預設</span>'}</td>
              <td>${it.role_id ? UI.esc(H.roleName(it.role_id)) : '—'}</td>
              <td>${it.stock < 0 ? '∞' : it.stock}</td>
              <td>${it.enabled ? '✅ 上架' : '⬜ 下架'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-eitem="${it.id}">編輯</button>
                <button class="btn tiny secondary" data-ditem="${it.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="8" class="hint">尚無商品，按「新增商品」建立。</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>📋 兌換紀錄（最近 200 筆）</h3>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>商品</th><th>份數</th><th>花費</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${redeems.length ? redeems.map(r => `<tr>
              <td class="hint">${UI.esc(r.created_at || '')}</td>
              <td>${UI.esc(r.username || r.user_id)}</td>
              <td>${UI.esc(r.item_name)}</td>
              <td>×${r.qty || 1}</td>
              <td>${coin(r.paid > 0 ? r.paid : r.price * (r.qty || 1))}</td>
              <td>${r.status === 'done' ? '✅ 已處理' : '⏳ 待處理'}</td>
              <td>${r.status === 'done' ? '' : `<button class="btn tiny secondary" data-done="${r.id}">標記已處理</button>`}</td>
            </tr>`).join('') : '<tr><td colspan="7" class="hint">尚無兌換紀錄。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      const b = H.collect(el.querySelector('#cfgwrap'));
      b.admin_roles = [...el.querySelectorAll('[data-adminrole]:checked')].map(x => x.value).join(',');
      await PUT('/special', b);
      UI.ok('已儲存設定'); App.go('special');
    };

    const itemForm = (it = {}) => `
      <div class="form-row">
        <div class="field"><label>獎勵名稱</label><input name="name" value="${UI.esc(it.name || '')}" placeholder="例如 客製捏圖"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(it.emoji || '')}" style="text-align:center" placeholder="🎨"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>價格（星幣）</label><input name="price" type="number" min="0" value="${it.price ?? 1000}"></div>
        <div class="field"><label>庫存（留空＝無限）</label><input name="stock" type="number" value="${it.stock < 0 || it.stock == null ? '' : it.stock}" placeholder="∞"></div>
      </div>
      <div class="field"><label>所屬商店</label>
        <select name="shop_id"><option value="0" ${!it.shop_id ? 'selected' : ''}>其他（未分類）</option>
          ${shops.map(s => `<option value="${s.id}" ${it.shop_id == s.id ? 'selected' : ''}>${UI.esc((s.emoji || '') + ' ' + s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>兌換後公告的頻道（通常是該身分組的專屬頻道）</label>${H.chanSelect('channel_id', it.channel_id || '')}</div>
      <div class="field"><label>對應身分組（顯示/標記用，可不選）</label>${H.roleSelect('role_id', it.role_id || '')}</div>
      <div class="field"><label>獎勵圖片（可空）</label>${H.uploadField('image_url', it.image_url || '', { label: '圖片' })}</div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(it.description || '')}" placeholder="兌換內容說明，會顯示給玩家與管理員"></div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${it.sort ?? 0}"></div>
      <div class="field"><label>這項的每人上限（0＝跟隨全域設定）</label><input name="per_user_limit" type="number" min="0" value="${it.per_user_limit ?? 0}"></div>
      <div class="field">${H.toggle('enabled', it.enabled ?? 1, '上架')}</div>`;

    const openItem = (it) => {
      const m = UI.modal({
        title: it ? '編輯商品' : '新增商品', bodyHTML: itemForm(it || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填獎勵名稱'); return false; }
          if (it) await PUT('/special-items/' + it.id, b); else await POST('/special-items', b);
          UI.ok('已儲存'); App.go('special');
        }
      });
      H.bindUploads(m.back);
    };

    el.querySelector('#additem').onclick = () => openItem(null);
    el.querySelectorAll('[data-eitem]').forEach(b =>
      b.onclick = () => openItem(items.find(x => x.id == b.dataset.eitem)));
    el.querySelectorAll('[data-ditem]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個商品？')) return;
      await DEL('/special-items/' + b.dataset.ditem); UI.ok('已刪除'); App.go('special');
    });
    el.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      await PUT('/special-redeems/' + b.dataset.done, { status: 'done' }); UI.ok('已標記'); App.go('special');
    });

    // ---- 商店 ----
    const shopForm = (s = {}) => `
      <div class="form-row">
        <div class="field"><label>商店名稱</label><input name="name" value="${UI.esc(s.name || '')}" placeholder="例如 BeMi 神秘兌換"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(s.emoji || '')}" style="text-align:center" placeholder="💎"></div>
      </div>
      <div class="field"><label>這家店的頻道（發布面板＋兌換通知都用這個）</label>${H.chanSelect('channel_id', s.channel_id || '')}</div>
      <div class="field"><label>這家店兌換時要標記的身分組（可複選）</label>${roleBox('data-shoprole', s.notify_roles)}</div>
      <div class="field"><label>說明（顯示在面板上方）</label><input name="description" value="${UI.esc(s.description || '')}"></div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${s.sort ?? 0}"></div>
      <div class="field">${H.toggle('enabled', s.enabled ?? 1, '啟用')}</div>`;
    const openShop = (s) => UI.modal({
      title: s ? '編輯商店' : '新增商店', bodyHTML: shopForm(s || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.name) { UI.err('請填商店名稱'); return false; }
        b.notify_roles = [...back.querySelectorAll('[data-shoprole]:checked')].map(x => x.value).join(',');
        if (s) await PUT('/special-shops/' + s.id, b); else await POST('/special-shops', b);
        UI.ok('已儲存'); App.go('special');
      }
    });
    el.querySelector('#addshop').onclick = () => openShop(null);
    el.querySelectorAll('[data-eshop]').forEach(b => b.onclick = () => openShop(shops.find(x => x.id == b.dataset.eshop)));
    el.querySelectorAll('[data-dshop]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這間商店？裡面的商品會變回「未分類」，不會被刪。')) return;
      await DEL('/special-shops/' + b.dataset.dshop); UI.ok('已刪除'); App.go('special');
    });
    el.querySelectorAll('[data-pubshop]').forEach(b => b.onclick = async () => {
      try { await POST('/special-shops/' + b.dataset.pubshop + '/publish', {}); UI.ok('已發布/更新面板'); }
      catch (e) { UI.err(e.message); }
    });
  }
});
