// ===== 釣魚 / 挖礦掛機 =====
App.page('gather', {
  title: '釣魚挖礦', sub: '冷卻指令、稀有掉落、道具商店、圖鑑與貨幣', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [c, items, tools, players, recipes, quests, transfers, maps, prizes, facs] = await Promise.all([
      GET('/gather'), GET('/gather-items'), GET('/gather-tools'), GET('/gather-players'),
      GET('/gather-recipes'), GET('/quests'), GET('/econ-transfers'), GET('/gather-maps'),
      GET('/lottery-prizes'), GET('/facilities')
    ]);
    const perms = await GET('/gather-cmd-perms');
    const access = await GET('/gather-channel-access');

    const KIND = { fish: '🎣 釣魚', mine: '⛏️ 挖礦', wood: '🪓 伐木', forage: '🧺 採集', hunt: '🏹 狩獵' };
    const RKIND = { craft: '🛠️ 製作', forge: '🔨 鍛造' };
    const PERIOD = { daily: '每日', weekly: '每週', once: '一次性' };
    const GOAL = { gather: '採集次數', rarity: '抽到稀有度', item: '取得指定物品', sell: '賣出金額', craft: '製作次數' };
    const itemName = (id) => { const x = items.find(i => i.id == id); return x ? (x.emoji || '') + x.name : '#' + id; };
    const toolName = (id) => { const x = tools.find(i => i.id == id); return x ? (x.emoji || '') + x.name : '#' + id; };
    const RARITY = ['N', 'R', 'SR', 'SSR'];
    const RARITY_LABEL = { N: '普通', R: '稀有', SR: '史詩', SSR: '傳說' };
    const coin = (n) => `${c.currency_emoji || '🪙'} ${Number(n || 0).toLocaleString('en-US')}`;

    // 同稀有度內的實際中獎機率＝自己的權重 / 同組總權重，讓管理員調權重時看得到結果
    const chanceOf = (it) => {
      const pool = items.filter(x => x.kind === it.kind && x.enabled);
      const total = pool.reduce((a, x) => a + (x.weight || 0), 0);
      return total ? (it.weight / total * 100).toFixed(1) + '%' : '—';
    };

    // 抽籤獎項：把 type/amount/pct 講成一句人話，並算出實際中獎機率
    const PRIZE_TYPE = { coin: '星幣', luck: '幸運符', jackpot: '星幣＋幸運符' };
    const PRIZE_CONTENT = (p) => p.type === 'luck' ? `當日稀有率 +${p.pct}%`
      : p.type === 'jackpot' ? `${p.amount} ${c.currency_name || '星幣'} ＋ 當日稀有率 +${p.pct}%`
      : `${p.amount} ${c.currency_name || '星幣'}`;
    const prizeChance = (p) => {
      if (!p.enabled) return '—';
      const total = prizes.filter(x => x.enabled).reduce((a, x) => a + (x.weight || 0), 0);
      return total ? (p.weight / total * 100).toFixed(1) + '%' : '—';
    };

    // 設施商店：四種設施的顯示名
    const FAC = { field: '🌾 農地', greenhouse: '🏡 溫室', ranch: '🐔 牧場', hatch: '🥚 孵化室' };

    const kindSelect = (name, v) => `<select name="${name}">
      ${Object.entries(KIND).map(([k, label]) =>
        `<option value="${k}" ${v === k ? 'selected' : ''}>${label}</option>`).join('')}</select>`;

    el.innerHTML = `
      <div class="card" style="max-width:720px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用釣魚挖礦系統')}</div>
        <div class="form-row">
          <div class="field"><label>貨幣名稱</label><input name="currency_name" value="${UI.esc(c.currency_name || '星幣')}"></div>
          <div class="field"><label>貨幣圖示</label><input name="currency_emoji" data-bemoji value="${UI.esc(c.currency_emoji || '🪙')}" style="text-align:center"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>釣魚冷卻（秒）</label><input name="fish_cooldown" type="number" min="1" value="${c.fish_cooldown || 300}"></div>
          <div class="field"><label>挖礦冷卻（秒）</label><input name="mine_cooldown" type="number" min="1" value="${c.mine_cooldown || 300}"></div>
        </div>
        <div class="field"><label>伐木／採集／狩獵冷卻（秒）</label>
          <input name="other_cooldown" type="number" min="1" value="${c.other_cooldown || 300}"></div>
        <div class="field">${H.toggle('require_tool', c.require_tool ?? 1, '禁止徒手採集（沒有可用工具就不能釣魚／挖礦／伐木／採集／狩獵）')}
          <div class="hint">工具壞掉、還沒買、或<b>被抵押給物資貸款</b>時都算沒工具，要先修理／購買／贖回。關掉＝像以前一樣可以徒手（沒加成）。</div></div>
        <div class="form-row">
          <div class="field"><label>每日採集點數（0＝不用點數制）<br><span class="hint">✅ <b>目前主要的每日限制</b>：所有地圖共用一池，每張地圖各自設「門票」扣多少點</span></label><input name="daily_points" type="number" min="0" value="${c.daily_points || 0}"></div>
          <div class="field"><label>舊版每日上限（每種各自算，0＝不限）<br><span class="hint">只有「沒有點數制、也沒有地圖」時才生效</span></label><input name="daily_limit" type="number" min="0" value="${c.daily_limit || 0}"></div>
          <div class="field"><label>新玩家初始貨幣</label><input name="start_coins" type="number" min="0" value="${c.start_coins || 0}"></div>
        </div>
        <div class="field"><label>抽到這個稀有度以上時公開報喜</label>
          <select name="announce_rare">
            <option value="">不廣播</option>
            ${RARITY.map(r => `<option value="${r}" ${c.announce_rare === r ? 'selected' : ''}>${r}（${RARITY_LABEL[r]}）以上</option>`).join('')}
          </select></div>
        <div class="field"><label>限定使用頻道（可空＝全伺服器）</label>
          ${multiBox('channels', H.channels || [], c.channels, x => '# ' + x.name)}</div>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">
        <h3>玩家轉帳</h3>
        <div class="field">${H.toggle('transfer_enabled', c.transfer_enabled, '開放玩家之間互轉貨幣')}</div>
        <div class="hint" style="margin-bottom:10px">開放轉帳會帶來洗錢與詐騙風險（小號刷幣集中給大號、「先轉我 500 我給你 SSR」）。
          手續費與每日上限就是用來壓制這些行為的，每一筆轉帳都會留下可稽核的紀錄。</div>
        <div class="form-row">
          <div class="field"><label>手續費 %（最高 50）</label><input name="transfer_fee_pct" type="number" min="0" max="50" value="${c.transfer_fee_pct ?? 5}"></div>
          <div class="field"><label>單筆最低金額</label><input name="transfer_min" type="number" min="1" value="${c.transfer_min ?? 10}"></div>
          <div class="field"><label>每人每日轉出上限（0＝不限）</label><input name="transfer_daily_max" type="number" min="0" value="${c.transfer_daily_max ?? 5000}"></div>
        </div>
        <button class="btn" id="savecfg">儲存設定</button>
      </div>

      <div class="card" id="accesswrap">
        <h3>遊戲頻道開放設定</h3>
        <div class="hint" style="margin-bottom:10px">
          這裡設定的是 <b>Discord 的頻道權限</b>，不是遊戲設定。勾一個身分組按「開放」，
          就會一次給它<b>查看頻道、傳送訊息、讀取歷史、使用應用程式指令</b>四項權限。<br>
          最後一項最關鍵：沒開的話 slash 指令連跳都不會跳出來，玩家會以為遊戲壞掉。
          <code>@everyone</code> 維持關閉即可，只開給該進來的身分組。
        </div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>頻道</th><th>已開放的身分組</th><th>加開身分組</th></tr></thead>
          <tbody>${access.length ? access.map(a => `
            <tr data-acc="${a.id}">
              <td class="wrap"># ${UI.esc(a.name)}</td>
              <td class="wrap">${a.roles.length
                ? a.roles.map(r => `<span class="tag">@${UI.esc(r.name)}
                    <a href="#" data-revoke="${r.id}" title="取消開放" style="margin-left:4px">✕</a></span>`).join(' ')
                : '<span style="color:var(--muted)">尚未開放給任何身分組</span>'}</td>
              <td>${H.roleSelect('__acc_' + a.id, '', { emptyLabel: '— 選身分組 —' })}
                  <button class="btn tiny" data-grant="${a.id}">開放</button></td>
            </tr>`).join('')
            : '<tr><td colspan="3" class="empty">尚未設定「限定使用頻道」，目前全頻道都能玩</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card" id="permwrap">
        <h3>指令權限與顯示範圍</h3>
        <div class="hint" style="margin-bottom:10px">
          <b>只有自己看得到</b>＝結果用 Discord 的私密回覆，只有下指令的人看得到，頻道不會被洗版。<br>
          <b>僅管理員</b>＝一般玩家無法使用（管理員身分組自動通過，不必另外指定）。<br>
          <b>限定身分組</b>留空＝全體可用；管理員一律不受限制。
        </div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>指令</th><th>啟用</th><th>只有自己看得到</th><th>僅管理員</th><th>限定身分組（可空＝全體）</th></tr></thead>
          <tbody>${perms.map(p => `
            <tr data-perm="${UI.esc(p.cmd)}">
              <td><code>/${UI.esc(p.cmd)}</code></td>
              <td><input type="checkbox" data-p-enabled ${p.enabled ? 'checked' : ''}></td>
              <td><input type="checkbox" data-p-private ${p.private ? 'checked' : ''}></td>
              <td><input type="checkbox" data-p-admin ${p.admin_only ? 'checked' : ''}></td>
              <td>${H.roleSelect('__r_' + UI.esc(p.cmd), (p.roles || '').split(',')[0] || '', { emptyLabel: '— 全體 —' })}</td>
            </tr>`).join('')}
          </tbody></table></div>
        <button class="btn" id="saveperm" style="margin-top:10px">儲存指令權限</button>
      </div>

      <div class="card">
        <h3>製作 / 鍛造配方</h3>
        <div class="toolbar"><button class="btn" id="addrec">＋ 新增配方</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>類型</th><th>配方</th><th>材料</th><th>產出</th><th>成功率</th><th>狀態</th><th></th></tr></thead>
          <tbody>${recipes.length ? recipes.map(r => {
            let mats = []; try { mats = JSON.parse(r.materials || '[]'); } catch {}
            return `<tr>
              <td>${RKIND[r.kind] || r.kind}</td>
              <td class="wrap">${UI.esc(r.emoji || '')} <strong>${UI.esc(r.name)}</strong>
                ${r.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(r.description)}</div>` : ''}</td>
              <td class="wrap">${mats.map(m => UI.esc(itemName(m.item_id)) + '×' + m.count).join(' ＋ ') || '—'}
                ${r.cost ? `<div style="color:var(--muted);font-size:12px">＋ ${coin(r.cost)}</div>` : ''}</td>
              <td class="wrap">${({ plot_field: '🌾 農地', plot_greenhouse: '🏡 溫室', plot_ranch: '🐔 牧場', plot_hatch: '🥚 孵化室' })[r.result_type] || UI.esc(r.result_type === 'tool' ? toolName(r.result_id) : itemName(r.result_id))} ×${r.result_count}</td>
              <td>${r.success_rate}%${r.fail_keep ? '<div style="color:var(--muted);font-size:12px">失敗保留材料</div>' : ''}</td>
              <td>${H.enabledTag(r.enabled)}</td>
              <td><button class="btn tiny secondary" data-erec="${r.id}">編輯</button>
                  <button class="btn tiny danger" data-drec="${r.id}">刪除</button></td></tr>`;
          }).join('') : '<tr><td colspan="7" class="empty">尚無配方</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>任務</h3>
        <div class="toolbar"><button class="btn" id="addq">＋ 新增任務</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>週期</th><th>任務</th><th>目標</th><th>獎勵</th><th>狀態</th><th></th></tr></thead>
          <tbody>${quests.length ? quests.map(q => `
            <tr>
              <td>${PERIOD[q.period] || q.period}</td>
              <td class="wrap"><strong>${q.daily_slots > 0 ? '🏆 ' : ''}${UI.esc(q.name)}</strong>
                ${q.daily_slots > 0 ? `<div style="color:var(--accent);font-size:12px">懸賞·每期限 ${q.daily_slots} 人</div>` : ''}
                ${q.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(q.description)}</div>` : ''}</td>
              <td class="wrap">${GOAL[q.goal_type] || q.goal_type} ×${q.goal_count}
                ${q.goal_kind ? `<div style="color:var(--muted);font-size:12px">限 ${KIND[q.goal_kind] || q.goal_kind}</div>` : ''}
                ${q.goal_rarity ? `<div style="color:var(--muted);font-size:12px">限 ${q.goal_rarity}</div>` : ''}</td>
              <td class="wrap">${q.reward_coins ? coin(q.reward_coins) : ''}
                ${q.reward_item ? `<div>${UI.esc(itemName(q.reward_item))} ×${q.reward_item_count}</div>` : ''}
                ${q.reward_role ? `<div style="color:var(--muted);font-size:12px">${UI.esc(H.roleName(q.reward_role))}</div>` : ''}</td>
              <td>${H.enabledTag(q.enabled)}</td>
              <td><button class="btn tiny secondary" data-eq="${q.id}">編輯</button>
                  <button class="btn tiny danger" data-dq="${q.id}">刪除</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">尚無任務</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>轉帳紀錄（最近 200 筆）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>從</th><th>到</th><th>金額</th><th>手續費</th></tr></thead>
          <tbody>${transfers.length ? transfers.map(t => `
            <tr><td>${UI.esc(t.created_at)}</td><td class="wrap">${UI.esc(t.from_name || t.from_id)}</td>
              <td class="wrap">${UI.esc(t.to_name || t.to_id)}</td><td>${coin(t.amount)}</td><td>${coin(t.fee)}</td></tr>`).join('')
            : '<tr><td colspan="5" class="empty">尚無轉帳紀錄</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>🗺️ 採集地圖</h3>
        <div class="hint" style="margin-bottom:8px">玩家用 <code>/地圖</code> 切換。啟用<b>點數制</b>時（上面的「每日採集點數」&gt;0），每次採集扣該地圖的<b>門票點數</b>，高階圖一次扣比較多；此時「每日次數」欄位不生效。</div>
        <div class="toolbar"><button class="btn" id="addmap">＋ 新增地圖</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>地圖</th><th>門票</th><th>每日次數（舊制）</th><th>幸運加成</th><th>預設</th><th>狀態</th><th></th></tr></thead>
          <tbody>${maps.length ? maps.map(m => `
            <tr>
              <td class="wrap">${UI.esc((m.emoji || '') + ' ' + m.name)}${m.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(m.description)}</div>` : ''}</td>
              <td>${m.cost ?? 1} 點</td>
              <td>${m.daily_limit} 次</td>
              <td>+${m.luck_bonus}%</td>
              <td>${m.is_default ? '📍 預設' : ''}</td>
              <td>${H.enabledTag(m.enabled)}</td>
              <td><button class="btn tiny secondary" data-emap="${m.id}">編輯</button>
                  <button class="btn tiny danger" data-dmap="${m.id}">刪除</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">尚無地圖（機器人啟動時會自動建立 3 張預設地圖）</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>🎲 每日抽籤獎池</h3>
        <div class="hint" style="margin-bottom:8px">玩家用 <code>/抽籤</code> 每天抽一次。機率＝該獎項權重 ÷ 全部啟用獎項的權重總和。幸運符只在當天有效，會疊到採集稀有率上。<b>全部停用或刪光時會退回系統預設獎池。</b></div>
        <div class="toolbar"><button class="btn" id="addprize">＋ 新增獎項</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>獎項</th><th>內容</th><th>權重</th><th>機率</th><th>狀態</th><th></th></tr></thead>
          <tbody>${prizes.length ? prizes.map(p => `
            <tr>
              <td class="wrap">${UI.esc((p.emoji || '') + ' ' + p.name)}</td>
              <td class="wrap">${UI.esc(PRIZE_CONTENT(p))}</td>
              <td>${p.weight}</td>
              <td>${prizeChance(p)}</td>
              <td>${H.enabledTag(p.enabled)}</td>
              <td><button class="btn tiny secondary" data-eprize="${p.id}">編輯</button>
                  <button class="btn tiny danger" data-dprize="${p.id}">刪除</button></td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">尚無獎項（機器人啟動時會自動建立預設獎池）</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>🏗️ 設施商店（等級）</h3>
        <div class="hint" style="margin-bottom:8px">玩家用 <code>/設施商店</code> 花星幣買農地／溫室／牧場／孵化室的<b>等級</b>。
          跟工具一樣：<b>買高階會取代低階</b>，總格數以最高階為準（不是一階一階疊加），所以「格數」欄填的是<b>該階的總格數</b>。
          高階還能帶<b>加成</b>：⏩ 縮短作物成熟／動物產出／孵化時間，🛡️ 降低別人來偷你的成功率（牧場專用）。玩家可在 <code>/設施商店</code> 或 <code>/商店</code>＋<code>/購買</code> 買。
          <code>/製作</code> 蓋出來的格子會另外相加，兩條路並存。</div>
        <div class="toolbar"><button class="btn" id="addfac">＋ 新增設施等級</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>設施</th><th>階級</th><th>名稱</th><th>售價</th><th>總格數</th><th>加成</th><th>狀態</th><th></th></tr></thead>
          <tbody>${facs.length ? facs.map(f => `
            <tr>
              <td>${FAC[f.type] || f.type}</td>
              <td>${f.tier} 階</td>
              <td class="wrap">${UI.esc((f.emoji || '') + ' ' + f.name)}${f.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(f.description)}</div>` : ''}</td>
              <td>${coin(f.price)}</td>
              <td>${f.slots} 格</td>
              <td>${[f.speed_pct ? `⏩ -${f.speed_pct}%` : '', f.resist_pct ? `🛡️ -${f.resist_pct}%` : ''].filter(Boolean).join('　') || '—'}</td>
              <td>${H.enabledTag(f.enabled)}</td>
              <td><button class="btn tiny secondary" data-efac="${f.id}">編輯</button>
                  <button class="btn tiny danger" data-dfac="${f.id}">刪除</button></td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty">尚無設施（機器人啟動時會自動建立四種各 3 階）</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>掉落物（圖鑑內容）</h3>
        <div class="toolbar"><button class="btn" id="additem">＋ 新增掉落物</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>種類</th><th>物品</th><th>稀有度</th><th>權重</th><th>機率</th><th>售價</th><th>狀態</th><th></th></tr></thead>
          <tbody>${items.length ? items.map(it => `
            <tr>
              <td>${KIND[it.kind] || it.kind}</td>
              <td class="wrap">${UI.esc(it.emoji || '')} <strong>${UI.esc(it.name)}</strong></td>
              <td><span class="tag">${it.rarity}</span> ${RARITY_LABEL[it.rarity] || ''}</td>
              <td>${it.weight}</td>
              <td>${chanceOf(it)}</td>
              <td>${coin(it.price)}</td>
              <td>${H.enabledTag(it.enabled)}</td>
              <td><button class="btn tiny secondary" data-eitem="${it.id}">編輯</button>
                  <button class="btn tiny danger" data-ditem="${it.id}">刪除</button></td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty">尚無掉落物（機器人第一次執行指令時會自動建立一批預設物品）</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>道具商店（竿子 / 鎬子）</h3>
        <div class="toolbar"><button class="btn" id="addtool">＋ 新增道具</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>種類</th><th>道具</th><th>階級</th><th>售價</th><th>幸運</th><th>冷卻縮短</th><th>狀態</th><th></th></tr></thead>
          <tbody>${tools.length ? tools.map(t => `
            <tr>
              <td>${KIND[t.kind] || t.kind}</td>
              <td class="wrap">${UI.esc(t.emoji || '')} <strong>${UI.esc(t.name)}</strong>
                ${t.description ? `<div style="color:var(--muted);font-size:12px">${UI.esc(t.description)}</div>` : ''}</td>
              <td>T${t.tier}</td>
              <td>${t.price ? coin(t.price) : '免費'}</td>
              <td>+${t.luck}%</td>
              <td>-${t.cooldown_cut}%</td>
              <td>${H.enabledTag(t.enabled)}</td>
              <td><button class="btn tiny secondary" data-etool="${t.id}">編輯</button>
                  <button class="btn tiny danger" data-dtool="${t.id}">刪除</button></td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty">尚無道具</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card">
        <h3>玩家與貨幣</h3>
        <div class="hint" style="margin-bottom:8px">「清空」只會刪掉玩家累積的東西：<b>錢包、背包、道具、圖鑑、牧場動物、孵化室、農地、任務進度、抽籤紀錄、偷取次數、交易與轉帳紀錄</b>。
          你設定好的掉落物、道具、動物、地圖、獎池、商店、配方、任務定義<b>都會保留</b>，玩家下次玩就是全新開始。<b>無法復原。</b></div>
        <div class="toolbar"><button class="btn danger" id="wipeall">🧹 清空全部玩家資料</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>#</th><th>玩家</th><th>持有</th><th>累計賺取</th><th>圖鑑收錄</th><th></th></tr></thead>
          <tbody>${players.length ? players.map((p, n) => `
            <tr>
              <td>${n + 1}</td>
              <td class="wrap"><strong>${UI.esc(p.username || '未知玩家')}</strong>
                <div style="color:var(--muted);font-size:12px">${UI.esc(p.user_id)}</div></td>
              <td>${coin(p.coins)}</td>
              <td>${coin(p.total_earned)}</td>
              <td>${p.collected} 種</td>
              <td><button class="btn tiny secondary" data-coins="${p.user_id}" data-name="${UI.esc(p.username || '')}">增減貨幣</button>
                  <button class="btn tiny danger" data-wipe="${p.user_id}" data-name="${UI.esc(p.username || '')}">清空</button></td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">還沒有玩家資料</td></tr>'}
          </tbody></table></div>
      </div>`;

    // ---- 設定存檔 ----
    const cfgwrap = el.querySelector('#cfgwrap');
    H.bindEmojiPickers(cfgwrap);
    el.querySelector('#savecfg').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const b = H.collect(cfgwrap);
        b.channels = multiVal(cfgwrap, 'channels');
        await PUT('/gather', b);
        UI.ok('已儲存');
        App.go('gather');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    // ---- 掉落物 ----
    const itemForm = (it = {}) => `
      <div class="form-row">
        <div class="field"><label>種類</label>${kindSelect('kind', it.kind || 'fish')}</div>
        <div class="field"><label>稀有度</label>
          <select name="rarity">${RARITY.map(r =>
            `<option value="${r}" ${it.rarity === r ? 'selected' : ''}>${r}（${RARITY_LABEL[r]}）</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>物品名稱</label><input name="name" value="${UI.esc(it.name || '')}" placeholder="例：鯨魚"></div>
        <div class="field"><label>圖示</label><input name="emoji" data-bemoji value="${UI.esc(it.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>抽中權重（同種類相比，越大越常出現）</label>
          <input name="weight" type="number" min="0" value="${it.weight ?? 100}"></div>
        <div class="field"><label>賣出單價</label><input name="price" type="number" min="0" value="${it.price ?? 10}"></div>
      </div>
      <div class="field"><label>說明（可空）</label><input name="description" value="${UI.esc(it.description || '')}"></div>
      <div class="field"><label>圖片（可空，顯示在抽中訊息的縮圖）</label>${H.uploadField('image_url', it.image_url || '', { label: '圖片' })}</div>
      <div class="field">${H.toggle('enabled', it.enabled ?? 1, '啟用（停用後不會被抽到）')}</div>`;

    const openItem = (it) => {
      const m = UI.modal({
        title: it ? '編輯掉落物' : '新增掉落物', bodyHTML: itemForm(it || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填寫物品名稱'); return false; }
          if (it) await PUT('/gather-items/' + it.id, b); else await POST('/gather-items', b);
          UI.ok('已儲存'); App.go('gather');
        }
      });
      H.bindUploads(m.back);
      H.bindEmojiPickers(m.back);
    };

    el.querySelector('#additem').onclick = () => openItem(null);
    el.querySelectorAll('[data-eitem]').forEach(b =>
      b.onclick = () => openItem(items.find(x => x.id == b.dataset.eitem)));
    el.querySelectorAll('[data-ditem]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個掉落物？玩家背包裡的同款物品也會一併清除。')) return;
      await DEL('/gather-items/' + b.dataset.ditem); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 地圖 ----
    const mapForm = (m = {}) => `
      <div class="form-row">
        <div class="field"><label>地圖名稱</label><input name="name" value="${UI.esc(m.name || '')}" placeholder="例如 遠古秘境"></div>
        <div class="field"><label>圖示</label><input name="emoji" value="${UI.esc(m.emoji || '')}" style="text-align:center" placeholder="🏔️"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>每日採集總次數（釣魚+挖礦+伐木+採集+狩獵 全部合計）</label><input name="daily_limit" type="number" min="1" value="${m.daily_limit ?? 10}"></div>
        <div class="field"><label>幸運加成 %（提升稀有率）</label><input name="luck_bonus" type="number" min="0" value="${m.luck_bonus ?? 0}"></div>
      </div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(m.description || '')}" placeholder="顯示給玩家的一句話"></div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${m.sort ?? 0}"></div>
      <div class="field">${H.toggle('is_default', m.is_default ?? 0, '設為新玩家的預設地圖（只會有一張）')}</div>
      <div class="field">${H.toggle('enabled', m.enabled ?? 1, '啟用')}</div>`;
    const openMap = (m) => UI.modal({
      title: m ? '編輯地圖' : '新增地圖', bodyHTML: mapForm(m || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.name) { UI.err('請填地圖名稱'); return false; }
        if (m) await PUT('/gather-maps/' + m.id, b); else await POST('/gather-maps', b);
        UI.ok('已儲存'); App.go('gather');
      }
    });
    el.querySelector('#addmap').onclick = () => openMap(null);
    el.querySelectorAll('[data-emap]').forEach(b => b.onclick = () => openMap(maps.find(x => x.id == b.dataset.emap)));
    el.querySelectorAll('[data-dmap]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這張地圖？正在使用它的玩家會回到預設地圖。')) return;
      await DEL('/gather-maps/' + b.dataset.dmap); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 每日抽籤獎池 ----
    const prizeForm = (p = {}) => `
      <div class="form-row">
        <div class="field"><label>獎項名稱</label><input name="name" value="${UI.esc(p.name || '')}" placeholder="例如 頭獎"></div>
        <div class="field"><label>圖示</label><input name="emoji" data-bemoji value="${UI.esc(p.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="field"><label>獎項類型</label><select name="type">
        ${Object.entries(PRIZE_TYPE).map(([k, label]) =>
          `<option value="${k}" ${(p.type || 'coin') === k ? 'selected' : ''}>${label}</option>`).join('')}
      </select></div>
      <div class="form-row">
        <div class="field"><label>星幣數量（幸運符類型不適用）</label><input name="amount" type="number" min="0" value="${p.amount ?? 0}"></div>
        <div class="field"><label>當日稀有率 +%（純星幣不適用）</label><input name="pct" type="number" min="0" value="${p.pct ?? 0}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>權重（越大越常抽到）</label><input name="weight" type="number" min="0" value="${p.weight ?? 10}"></div>
        <div class="field"><label>排序</label><input name="sort" type="number" value="${p.sort ?? 0}"></div>
      </div>
      <div class="field">${H.toggle('enabled', p.enabled ?? 1, '啟用')}</div>`;
    const openPrize = (p) => {
      const m = UI.modal({
        title: p ? '編輯獎項' : '新增獎項', bodyHTML: prizeForm(p || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填寫獎項名稱'); return false; }
          if (p) await PUT('/lottery-prizes/' + p.id, b); else await POST('/lottery-prizes', b);
          UI.ok('已儲存'); App.go('gather');
        }
      });
      H.bindEmojiPickers(m.back);
    };
    el.querySelector('#addprize').onclick = () => openPrize(null);
    el.querySelectorAll('[data-eprize]').forEach(b =>
      b.onclick = () => openPrize(prizes.find(x => x.id == b.dataset.eprize)));
    el.querySelectorAll('[data-dprize]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個抽籤獎項？')) return;
      await DEL('/lottery-prizes/' + b.dataset.dprize); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 道具 ----
    const toolForm = (t = {}) => `
      <div class="form-row">
        <div class="field"><label>種類</label>${kindSelect('kind', t.kind || 'fish')}</div>
        <div class="field"><label>階級（玩家自動使用擁有的最高階）</label>
          <input name="tier" type="number" min="1" value="${t.tier ?? 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>道具名稱</label><input name="name" value="${UI.esc(t.name || '')}" placeholder="例：傳說釣竿"></div>
        <div class="field"><label>圖示</label><input name="emoji" data-bemoji value="${UI.esc(t.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>售價（0＝免費起始道具）</label><input name="price" type="number" min="0" value="${t.price ?? 100}"></div>
        <div class="field"><label>幸運 +%（拉高 R 以上掉落率）</label><input name="luck" type="number" min="0" value="${t.luck ?? 0}"></div>
        <div class="field"><label>冷卻縮短 %（最高 90）</label><input name="cooldown_cut" type="number" min="0" max="90" value="${t.cooldown_cut ?? 0}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>耐久度（可用幾次，0＝永不損壞）</label><input name="durability" type="number" min="0" value="${t.durability ?? 0}"></div>
        <div class="field"><label>修理費（0＝自動用售價一半）</label><input name="repair_cost" type="number" min="0" value="${t.repair_cost ?? 0}"></div>
      </div>
      <div class="hint" style="margin-bottom:6px">耐久度 >0 的工具每採集一次扣 1，用完會壞掉、要 <code>/修理</code> 花星幣修回滿。免費起始工具建議設 0（不會壞）。</div>
      <div class="field"><label>說明（可空）</label><input name="description" value="${UI.esc(t.description || '')}"></div>
      <div class="field">${H.toggle('enabled', t.enabled ?? 1, '啟用（停用後商店不顯示）')}</div>`;

    const openTool = (t) => {
      const m = UI.modal({
        title: t ? '編輯道具' : '新增道具', bodyHTML: toolForm(t || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填寫道具名稱'); return false; }
          if (t) await PUT('/gather-tools/' + t.id, b); else await POST('/gather-tools', b);
          UI.ok('已儲存'); App.go('gather');
        }
      });
      H.bindEmojiPickers(m.back);
    };

    el.querySelector('#addtool').onclick = () => openTool(null);
    el.querySelectorAll('[data-etool]').forEach(b =>
      b.onclick = () => openTool(tools.find(x => x.id == b.dataset.etool)));
    el.querySelectorAll('[data-dtool]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個道具？已購買的玩家會失去它。')) return;
      await DEL('/gather-tools/' + b.dataset.dtool); UI.ok('已刪除'); App.go('gather');
    });


    // ---- 頻道開放 ----
    el.querySelectorAll('[data-grant]').forEach(b => b.onclick = async () => {
      const tr = b.closest('[data-acc]');
      const role = tr.querySelector('select').value;
      if (!role) return UI.err('請先選一個身分組');
      b.disabled = true;
      try { await POST('/gather-channel-access', { channel_id: b.dataset.grant, role_id: role, allow: true });
        UI.ok('已開放'); App.go('gather'); }
      catch (e) { UI.err(e.message); b.disabled = false; }
    });
    el.querySelectorAll('[data-revoke]').forEach(a => a.onclick = async (ev) => {
      ev.preventDefault();
      if (!await UI.confirm('取消這個身分組在此頻道的開放權限？')) return;
      const tr = a.closest('[data-acc]');
      try { await POST('/gather-channel-access', { channel_id: tr.dataset.acc, role_id: a.dataset.revoke, allow: false });
        UI.ok('已取消'); App.go('gather'); }
      catch (e) { UI.err(e.message); }
    });

    // ---- 指令權限 ----
    el.querySelector('#saveperm').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const rows = [...el.querySelectorAll('[data-perm]')].map(tr => ({
          cmd: tr.dataset.perm,
          enabled: tr.querySelector('[data-p-enabled]').checked ? 1 : 0,
          private: tr.querySelector('[data-p-private]').checked ? 1 : 0,
          admin_only: tr.querySelector('[data-p-admin]').checked ? 1 : 0,
          roles: tr.querySelector('select').value || ''
        }));
        await PUT('/gather-cmd-perms', { rows });
        UI.ok('已儲存指令權限');
      } catch (err) { UI.err(err.message); } finally { e.target.disabled = false; }
    };

    // ---- 配方 ----
    // 材料是 [{item_id,count}] 的 JSON，用一組可增減的列來編輯
    const matRows = (mats) => mats.map((m, i) => `
      <div class="form-row" data-matrow style="align-items:flex-end">
        <div class="field"><label>材料</label>
          <select data-mat-item>${items.map(it =>
            `<option value="${it.id}" ${it.id == m.item_id ? 'selected' : ''}>${UI.esc(KIND[it.kind] || '')} ${UI.esc(it.name)}</option>`).join('')}</select></div>
        <div class="field" style="max-width:110px"><label>數量</label>
          <input type="number" min="1" data-mat-count value="${m.count || 1}"></div>
        <div class="field" style="max-width:70px"><button type="button" class="btn tiny danger" data-mat-del>移除</button></div>
      </div>`).join('');

    const recipeForm = (r = {}) => {
      let mats = []; try { mats = JSON.parse(r.materials || '[]'); } catch {}
      if (!mats.length) mats = [{ item_id: items[0] && items[0].id, count: 1 }];
      return `
      <div class="form-row">
        <div class="field"><label>類型</label>
          <select name="kind">${Object.entries(RKIND).map(([k, l]) =>
            `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>配方名稱（玩家要輸入的字）</label>
          <input name="name" value="${UI.esc(r.name || '')}" placeholder="例：鐵鎬"></div>
        <div class="field" style="max-width:90px"><label>圖示</label>
          <input name="emoji" data-bemoji value="${UI.esc(r.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="field"><label>材料</label><div id="mats">${matRows(mats)}</div>
        <button type="button" class="btn tiny secondary" id="addmat">＋ 加一項材料</button></div>
      <div class="form-row">
        <div class="field"><label>產出類型</label>
          <select name="result_type" id="rtype">
            <option value="item" ${r.result_type !== 'tool' && !String(r.result_type || '').startsWith('plot') ? 'selected' : ''}>掉落物（進背包）</option>
            <option value="tool" ${r.result_type === 'tool' ? 'selected' : ''}>道具（竿子/鎬子等）</option>
            <option value="plot_field" ${r.result_type === 'plot_field' ? 'selected' : ''}>🌾 農地（開一格農地）</option>
            <option value="plot_greenhouse" ${r.result_type === 'plot_greenhouse' ? 'selected' : ''}>🏡 溫室（開一格溫室）</option>
            <option value="plot_ranch" ${r.result_type === 'plot_ranch' ? 'selected' : ''}>🐔 牧場（開一格牧場）</option>
            <option value="plot_hatch" ${r.result_type === 'plot_hatch' ? 'selected' : ''}>🥚 孵化室（開一格孵化）</option>
          </select></div>
        <div class="field" id="ridwrap"><label>產出目標</label>
          <select name="result_id" id="rid">
            ${items.map(it => `<option data-t="item" value="${it.id}" ${r.result_type !== 'tool' && r.result_id == it.id ? 'selected' : ''}>${UI.esc(it.name)}</option>`).join('')}
            ${tools.map(t => `<option data-t="tool" value="${t.id}" ${r.result_type === 'tool' && r.result_id == t.id ? 'selected' : ''}>${UI.esc(t.name)}</option>`).join('')}
          </select></div>
        <div class="field" style="max-width:110px"><label>產出數量</label>
          <input name="result_count" type="number" min="1" value="${r.result_count || 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>額外花費貨幣</label><input name="cost" type="number" min="0" value="${r.cost || 0}"></div>
        <div class="field"><label>成功率 %</label><input name="success_rate" type="number" min="1" max="100" value="${r.success_rate ?? 100}"></div>
      </div>
      <div class="field">${H.toggle('fail_keep', r.fail_keep, '失敗時保留材料（不勾＝失敗材料會消耗，風險較高）')}</div>
      <div class="field"><label>說明（可空）</label><input name="description" value="${UI.esc(r.description || '')}"></div>
      <div class="field">${H.toggle('enabled', r.enabled ?? 1, '啟用此配方')}</div>`;
    };

    const wireRecipe = (back) => {
      H.bindEmojiPickers(back);
      const syncResult = () => {
        const t = back.querySelector('#rtype').value;
        // 農地/溫室/牧場/孵化室不需要「產出目標」，直接隱藏該欄
        const isPlot = t === 'plot_field' || t === 'plot_greenhouse' || t === 'plot_ranch' || t === 'plot_hatch';
        back.querySelector('#ridwrap').style.display = isPlot ? 'none' : '';
        if (isPlot) return;
        back.querySelectorAll('#rid option').forEach(o => { o.hidden = o.dataset.t !== t; });
        const cur = back.querySelector('#rid').selectedOptions[0];
        if (!cur || cur.dataset.t !== t) {
          const first = [...back.querySelectorAll('#rid option')].find(o => o.dataset.t === t);
          if (first) first.selected = true;
        }
      };
      back.querySelector('#rtype').addEventListener('change', syncResult);
      syncResult();
      const bindDel = () => back.querySelectorAll('[data-mat-del]').forEach(b =>
        b.onclick = () => { if (back.querySelectorAll('[data-matrow]').length > 1) b.closest('[data-matrow]').remove(); });
      bindDel();
      back.querySelector('#addmat').onclick = () => {
        back.querySelector('#mats').insertAdjacentHTML('beforeend', matRows([{ item_id: items[0] && items[0].id, count: 1 }]));
        bindDel();
      };
    };
    const recipeValue = (back) => {
      const b = H.collect(back);
      b.materials = JSON.stringify([...back.querySelectorAll('[data-matrow]')].map(r => ({
        item_id: +r.querySelector('[data-mat-item]').value,
        count: Math.max(1, +r.querySelector('[data-mat-count]').value || 1)
      })));
      return b;
    };

    const openRecipe = (r) => {
      const m = UI.modal({
        title: r ? '編輯配方' : '新增配方', bodyHTML: recipeForm(r || {}),
        onOk: async (back) => {
          const b = recipeValue(back);
          if (!b.name) { UI.err('請填寫配方名稱'); return false; }
          if (r) await PUT('/gather-recipes/' + r.id, b); else await POST('/gather-recipes', b);
          UI.ok('已儲存'); App.go('gather');
        }
      });
      wireRecipe(m.back);
    };
    el.querySelector('#addrec').onclick = () => openRecipe(null);
    el.querySelectorAll('[data-erec]').forEach(b =>
      b.onclick = () => openRecipe(recipes.find(x => x.id == b.dataset.erec)));
    el.querySelectorAll('[data-drec]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個配方？')) return;
      await DEL('/gather-recipes/' + b.dataset.drec); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 任務 ----
    const questForm = (q = {}) => `
      <div class="form-row">
        <div class="field"><label>週期</label>
          <select name="period">${Object.entries(PERIOD).map(([k, l]) =>
            `<option value="${k}" ${q.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>任務名稱</label><input name="name" value="${UI.esc(q.name || '')}" placeholder="例：每日勤勞"></div>
      </div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(q.description || '')}"></div>
      <div class="form-row">
        <div class="field"><label>目標類型</label>
          <select name="goal_type">${Object.entries(GOAL).map(([k, l]) =>
            `<option value="${k}" ${q.goal_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>目標數量</label><input name="goal_count" type="number" min="1" value="${q.goal_count || 10}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>限定種類（可不限）</label>
          <select name="goal_kind"><option value="">不限</option>${Object.entries(KIND).map(([k, l]) =>
            `<option value="${k}" ${q.goal_kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>限定稀有度（目標類型選「抽到稀有度」時用）</label>
          <select name="goal_rarity"><option value="">不限</option>${RARITY.map(r =>
            `<option value="${r}" ${q.goal_rarity === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>限定物品（目標類型選「取得指定物品」時用）</label>
        <select name="goal_item"><option value="0">不指定</option>${items.map(it =>
          `<option value="${it.id}" ${q.goal_item == it.id ? 'selected' : ''}>${UI.esc(KIND[it.kind] || '')} ${UI.esc(it.name)}</option>`).join('')}</select></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="form-row">
        <div class="field"><label>獎勵貨幣</label><input name="reward_coins" type="number" min="0" value="${q.reward_coins || 0}"></div>
        <div class="field"><label>獎勵物品數量</label><input name="reward_item_count" type="number" min="1" value="${q.reward_item_count || 1}"></div>
      </div>
      <div class="field"><label>獎勵物品（可不給）</label>
        <select name="reward_item"><option value="0">不給物品</option>${items.map(it =>
          `<option value="${it.id}" ${q.reward_item == it.id ? 'selected' : ''}>${UI.esc(KIND[it.kind] || '')} ${UI.esc(it.name)}</option>`).join('')}</select></div>
      <div class="field"><label>獎勵身分組（可不給）</label>${H.roleSelect('reward_role', q.reward_role)}</div>
      <div class="field"><label>🏆 懸賞名額（每個週期全服限幾人領，先搶先贏；0＝不限）</label>
        <input name="daily_slots" type="number" min="0" value="${q.daily_slots || 0}" placeholder="例：5"></div>
      <div class="field">${H.toggle('enabled', q.enabled ?? 1, '啟用此任務')}</div>`;

    const openQuest = (q) => UI.modal({
      title: q ? '編輯任務' : '新增任務', bodyHTML: questForm(q || {}),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.name) { UI.err('請填寫任務名稱'); return false; }
        if (q) await PUT('/quests/' + q.id, b); else await POST('/quests', b);
        UI.ok('已儲存'); App.go('gather');
      }
    });
    el.querySelector('#addq').onclick = () => openQuest(null);
    el.querySelectorAll('[data-eq]').forEach(b =>
      b.onclick = () => openQuest(quests.find(x => x.id == b.dataset.eq)));
    el.querySelectorAll('[data-dq]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個任務？玩家的進度也會一併清除。')) return;
      await DEL('/quests/' + b.dataset.dq); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 手動增減貨幣 ----
    // ---- 設施商店 ----
    const facForm = (f = {}) => `
      <div class="form-row">
        <div class="field"><label>設施種類</label><select name="type">
          ${Object.entries(FAC).map(([k, label]) =>
            `<option value="${k}" ${(f.type || 'field') === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div class="field"><label>階級（同種設施不可重複）</label><input name="tier" type="number" min="1" value="${f.tier ?? 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>設施名稱</label><input name="name" value="${UI.esc(f.name || '')}" placeholder="例：豐收莊園"></div>
        <div class="field"><label>圖示</label><input name="emoji" data-bemoji value="${UI.esc(f.emoji || '')}" style="text-align:center"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>售價</label><input name="price" type="number" min="0" value="${f.price ?? 500}"></div>
        <div class="field"><label>總格數（買下這階後的格數，不是增量）</label><input name="slots" type="number" min="0" value="${f.slots ?? 2}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>時間縮短 %（作物成熟／動物產出／孵化，最高 90）</label><input name="speed_pct" type="number" min="0" max="90" value="${f.speed_pct ?? 0}"></div>
        <div class="field"><label>防竊 %（只有牧場用得到：直接扣小偷成功率）</label><input name="resist_pct" type="number" min="0" max="100" value="${f.resist_pct ?? 0}"></div>
      </div>
      <div class="field"><label>說明</label><input name="description" value="${UI.esc(f.description || '')}"></div>
      <div class="field"><label>排序</label><input name="sort" type="number" value="${f.sort ?? 0}"></div>
      <div class="field">${H.toggle('enabled', f.enabled ?? 1, '啟用（停用後商店不顯示）')}</div>`;
    const openFac = (f) => {
      const m = UI.modal({
        title: f ? '編輯設施等級' : '新增設施等級', bodyHTML: facForm(f || {}),
        onOk: async (back) => {
          const b = H.collect(back);
          if (!b.name) { UI.err('請填寫設施名稱'); return false; }
          if (f) await PUT('/facilities/' + f.id, b); else await POST('/facilities', b);
          UI.ok('已儲存'); App.go('gather');
        }
      });
      H.bindEmojiPickers(m.back);
    };
    el.querySelector('#addfac').onclick = () => openFac(null);
    el.querySelectorAll('[data-efac]').forEach(b =>
      b.onclick = () => openFac(facs.find(x => x.id == b.dataset.efac)));
    el.querySelectorAll('[data-dfac]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個設施等級？已經買過的玩家不受影響（格數保留）。')) return;
      await DEL('/facilities/' + b.dataset.dfac); UI.ok('已刪除'); App.go('gather');
    });

    // ---- 清空玩家資料（全部／單人）----
    el.querySelector('#wipeall').onclick = async () => {
      if (!await UI.confirm('確定要清空「這台伺服器全部玩家」的遊戲資料嗎？\n\n⚠️ 錢包餘額、背包、道具、圖鑑、牧場動物、孵化中的蛋、農地作物、任務進度全部歸零，無法復原！\n\n（你設定的商品、動物、地圖、獎池等內容都會保留）')) return;
      if (!await UI.confirm('最後確認：真的要讓所有玩家從零開始嗎？')) return;
      const r = await POST('/gather-players/reset', {});
      UI.ok(`已清空，刪除 ${r.cleared} 筆玩家資料`); App.go('gather');
    };
    el.querySelectorAll('[data-wipe]').forEach(b => b.onclick = async () => {
      const nm = b.dataset.name || b.dataset.wipe;
      if (!await UI.confirm(`清空「${nm}」的遊戲資料？\n\n他的星幣、背包、圖鑑、牧場、農地、任務進度都會歸零，無法復原。`)) return;
      const r = await DEL('/gather-players/' + b.dataset.wipe);
      UI.ok(`已清空 ${nm}，刪除 ${r.cleared} 筆`); App.go('gather');
    });

    el.querySelectorAll('[data-coins]').forEach(b => b.onclick = () => {
      UI.modal({
        title: `調整「${b.dataset.name || b.dataset.coins}」的貨幣`,
        bodyHTML: `<div class="field"><label>增減數量（負數＝扣除）</label>
            <input name="delta" type="number" value="100"></div>
          <div class="hint">扣到負數時會停在 0。</div>`,
        onOk: async (back) => {
          const delta = parseInt(back.querySelector('[name=delta]').value, 10);
          if (!delta) { UI.err('請填寫要增減的數量'); return false; }
          const r = await POST(`/gather-players/${b.dataset.coins}/coins`, { delta });
          UI.ok('已調整，餘額 ' + r.coins); App.go('gather');
        }
      });
    });
  }
});
