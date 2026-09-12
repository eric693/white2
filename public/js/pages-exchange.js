// ===== 素材兌換所 =====
App.page('exchange', {
  help: {
    "intro": "每天開出幾個「素材換素材」的兌換項目，讓囤到爛掉的低價素材有出口。花的是素材不是星幣，交出去的由系統回收，不會多印錢。",
    "steps": [
      "先在下面的「兌換項目池」建幾組兌換（例如 水牛奶×100 → 碎石×1）。",
      "設定每天開幾個項目、每人每天最多換幾次。",
      "玩家用 /兌換所（或冒險面板的 ♻️ 素材兌換所）查看今天的清單並兌換。"
    ],
    "notes": [
      "清單每天午夜（台灣時間）自動換一批，照「抽中權重」從池子裡抽。權重愈高愈常出現。",
      "同一天不管誰打開、打開幾次，看到的都是同一組——不會有人一直重開指令換清單。",
      "改完項目想立刻看到效果，按「重抽今天的清單」，不必等到明天。",
      "換到的素材直接進背包（圖鑑也會記一筆）；交出的素材直接消失，不進任何人口袋。",
      "看「被換掉的素材排行」就知道玩家真正囤了什麼、比例合不合理，再回頭調數量。"
    ],
    "terms": [
      ["抽中權重", "每日抽清單時的相對機率。兩個項目分別是 100 與 300，後者被抽到的機會是前者的 3 倍。"],
      ["每日上限", "每個玩家每天這一項最多能換幾次。0＝不限（只受素材數量與每日總次數限制）。"]
    ]
  },
  title: '素材兌換所', sub: '每天一批素材換素材，消耗囤積的低價素材', module: 'exchange',

  async render(el) {
    await H.loadMeta();
    const [c, offers, items, today, logs, stats] = await Promise.all([
      GET('/exchange'), GET('/exchange-offers'), GET('/exchange-items'),
      GET('/exchange-today'), GET('/exchange-logs'), GET('/exchange-stats')
    ]);
    const itemLabel = (emoji, name) => UI.esc(((emoji || '') + ' ' + (name || '（已刪除）')).trim());
    const pairText = (o) => `${itemLabel(o.cost_emoji, o.cost_name)} ×${o.cost_count} → ${itemLabel(o.give_emoji, o.give_name)} ×${o.give_count}`;

    el.innerHTML = `
      <div class="card" style="max-width:680px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用素材兌換所')}</div>
        <div class="form-row">
          <div class="field"><label>每天開幾個兌換項目</label><input name="daily_slots" type="number" min="1" max="25" value="${c.daily_slots ?? 3}">
            <div class="hint">從下面的項目池照權重抽這麼多個。池子裡不夠就有幾個開幾個。</div></div>
          <div class="field"><label>每人每日總兌換次數（0＝不限）</label><input name="daily_per_user" type="number" min="0" value="${c.daily_per_user ?? 0}">
            <div class="hint">所有項目加總。想讓兌換所變成「每天來挑一次」就填 1～3。</div></div>
        </div>
        <div class="field"><label>每日清單公告頻道（不選＝不公告）</label>${H.chanSelect('announce_channel', c.announce_channel)}
          <div class="hint">每天 00:02 把今天開出的清單貼到這個頻道。</div></div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h3 style="margin:0">📅 今天開出的清單</h3>
          <button class="btn small secondary" id="reroll">重抽今天的清單</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>#</th><th>兌換</th><th>每日上限</th></tr></thead>
          <tbody>
            ${today.length ? today.map(o => `<tr>
              <td>${o.slot + 1}</td>
              <td>${o.name ? UI.esc((o.emoji || '') + ' ' + o.name) + '<br>' : ''}<span class="hint">${pairText(o)}</span></td>
              <td>${o.daily_limit > 0 ? o.daily_limit + ' 次／人' : '不限'}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="hint">今天還沒抽（第一個玩家打開 /兌換所 時會抽，或按上面的「重抽」）。</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h3 style="margin:0">🔁 兌換項目池</h3>
          <button class="btn small" id="addoffer">＋ 新增兌換項目</button>
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>項目</th><th>交出</th><th>換到</th><th>權重</th><th>每日上限</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            ${offers.length ? offers.map(o => `<tr>
              <td>${UI.esc(((o.emoji || '') + ' ' + (o.name || '')).trim() || '（自動命名）')}
                ${o.description ? `<br><span class="hint">${UI.esc(o.description)}</span>` : ''}</td>
              <td>${itemLabel(o.cost_emoji, o.cost_name)} ×${o.cost_count}<br><span class="hint">系統價值 ${(o.cost_price || 0) * o.cost_count}</span></td>
              <td>${itemLabel(o.give_emoji, o.give_name)} ×${o.give_count}<br><span class="hint">系統價值 ${(o.give_price || 0) * o.give_count}</span></td>
              <td>${o.weight}</td>
              <td>${o.daily_limit > 0 ? o.daily_limit + ' 次／人' : '不限'}</td>
              <td>${o.enabled ? '✅' : '⬜'}</td>
              <td style="white-space:nowrap">
                <button class="btn tiny secondary" data-eoffer="${o.id}">編輯</button>
                <button class="btn tiny secondary" data-doffer="${o.id}">刪除</button>
              </td></tr>`).join('') : '<tr><td colspan="7" class="hint">還沒有兌換項目。建議先放幾組「大量低價素材 → 少量高階素材」。</td></tr>'}
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:8px">兩邊的「系統價值」是拿物品賣出單價乘起來的參考值——交出的價值明顯低於換到的，等於開了一條印錢管道，調比例時看這兩欄。</div>
      </div>

      <div class="card">
        <h3>📊 被換掉的素材排行</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>素材</th><th>累計消耗</th><th>兌換筆數</th><th>最後一次</th></tr></thead>
          <tbody>
            ${stats.length ? stats.map(s => `<tr>
              <td>${UI.esc(s.cost_name)}</td><td>${Number(s.total).toLocaleString('en-US')}</td>
              <td>${s.rows_n}</td><td>${UI.esc(String(s.last_at || '').slice(0, 16))}</td></tr>`).join('')
              : '<tr><td colspan="4" class="hint">還沒有人兌換過。</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>📜 最近兌換紀錄</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>項目</th><th>交出</th><th>換到</th></tr></thead>
          <tbody>
            ${logs.length ? logs.map(l => `<tr>
              <td>${UI.esc(String(l.created_at || '').slice(0, 16))}</td>
              <td>${UI.esc(l.username || l.user_id)}</td>
              <td>${UI.esc(l.offer_name)}${l.times > 1 ? ` <span class="hint">×${l.times} 次</span>` : ''}</td>
              <td>${UI.esc(l.cost_name)} ×${l.cost_count}</td>
              <td>${UI.esc(l.give_name)} ×${l.give_count}</td></tr>`).join('')
              : '<tr><td colspan="5" class="hint">還沒有兌換紀錄。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/exchange', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('exchange');
    };
    el.querySelector('#reroll').onclick = async () => {
      if (!await UI.confirm('重抽今天的清單？玩家今天已經換掉的次數不會退回。')) return;
      await POST('/exchange-today/reroll'); UI.ok('已重抽'); App.go('exchange');
    };

    // 素材下拉：照賣出單價排序，「便宜的在上面」正好對應「拿來當材料的」
    const itemOpts = (sel) => items.map(it =>
      `<option value="${it.id}" ${String(it.id) === String(sel) ? 'selected' : ''}>${UI.esc((it.emoji || '') + ' ' + it.name)}（單價 ${it.price}）</option>`).join('');

    const offerForm = (o = {}) => `
      <div class="form-row">
        <div class="field"><label>項目名稱（留空＝自動用「素材×N → 素材×N」）</label><input name="name" value="${UI.esc(o.name || '')}" placeholder="例如 碎石回收站"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(o.emoji || '')}" style="text-align:center" placeholder="♻️">${H.emojiPicker('input[name="emoji"]')}</div>
      </div>
      <div class="form-row">
        <div class="field"><label>要交出的素材</label><select name="cost_item_id">${itemOpts(o.cost_item_id)}</select></div>
        <div class="field"><label>數量</label><input name="cost_count" type="number" min="1" value="${o.cost_count ?? 100}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>換到的素材</label><select name="give_item_id">${itemOpts(o.give_item_id)}</select></div>
        <div class="field"><label>數量</label><input name="give_count" type="number" min="1" value="${o.give_count ?? 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>抽中權重</label><input name="weight" type="number" min="1" value="${o.weight ?? 100}">
          <div class="hint">愈高愈常出現在每日清單。</div></div>
        <div class="field"><label>每人每日上限（0＝不限）</label><input name="daily_limit" type="number" min="0" value="${o.daily_limit ?? 0}"></div>
      </div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${o.sort ?? 0}"></div>
      <div class="field"><label>說明（玩家看得到）</label><input name="description" value="${UI.esc(o.description || '')}" placeholder="例如 牛奶喝不完就拿來砸石頭"></div>
      <div class="field">${H.toggle('enabled', o.enabled ?? 1, '放進每日抽選')}</div>`;

    const openOffer = (o) => {
      const m = UI.modal({
        title: o ? '編輯兌換項目' : '新增兌換項目', bodyHTML: offerForm(o || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.cost_item_id || !b.give_item_id) { UI.err('請選擇兩邊的素材'); return false; }
          if (b.cost_item_id === b.give_item_id) { UI.err('交出與換到不能是同一種素材'); return false; }
          if (o) await PUT('/exchange-offers/' + o.id, b); else await POST('/exchange-offers', b);
          UI.ok('已儲存'); App.go('exchange');
        }
      });
      H.bindEmojiPickers(m.back);
    };
    el.querySelector('#addoffer').onclick = () => {
      if (!items.length) return UI.err('這台伺服器還沒有任何物品，請先到「釣魚挖礦」頁建立素材。');
      openOffer(null);
    };
    el.querySelectorAll('[data-eoffer]').forEach(b => b.onclick = () => openOffer(offers.find(x => x.id == b.dataset.eoffer)));
    el.querySelectorAll('[data-doffer]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個兌換項目？今天已經開出的清單也會一起撤掉。')) return;
      await DEL('/exchange-offers/' + b.dataset.doffer); UI.ok('已刪除'); App.go('exchange');
    });
  }
});
