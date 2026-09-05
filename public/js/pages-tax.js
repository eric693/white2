// ===== 稅金：所得稅／同居稅／寵物稅／房屋稅，四者獨立，定期自動結算 =====
// 2026-09 改版：農地稅、養殖稅、證券稅、消費稅全部停徵（欄位保留給舊資料）。
App.page('tax', {
  help: {
    "intro": "四種稅各自獨立：所得稅看實際獲利、同居稅看角色數量、寵物稅看寵物隻數、房屋稅看房屋等級。",
    "steps": [
      "先選結算週期與時間，再逐項開關要課哪些稅。",
      "所得稅只課「這一期實際賺到的錢」：收入類進帳＋股票賣出後的淨損益。轉帳、存提款、信貸本金、退款與股票未實現漲跌都不算。",
      "同居稅與寵物稅是倍增累進：第 1 個＝基礎、第 2 個 ×2、第 3 個 ×4…數量上限已取消，改用稅金節制。",
      "按「試算」可以先看這期會課到誰、各課多少，確認沒問題再等排程自動跑。"
    ],
    "notes": [
      "「立即結算／試算」是交給管家那隻機器人跑的（後台網站掛在秘書身上），按下去最多等 30 秒；管家沒上線會提示工作已排隊，上線後自動補做。",
      "開著「不課成負債」時，最多只課到餘額歸零，差額變成欠稅記在玩家身上，下一期一起補收，玩家也可以用 /稅單 主動補繳。",
      "強制清算只會賣股票，而且只賣到剛好還清為止，不會動玩家的農場、魚缸與背包。",
      "課到的稅會進慈善基金會，再透過普發回到玩家身上。"
    ],
    "terms": [
      [
        "稅基",
        "課稅的計算基礎。2026-09 起固定是「本期實際獲利」，不再對餘額或既有資產課稅。"
      ],
      [
        "欠稅",
        "餘額不夠繳、延到下期補收的金額。"
      ]
    ]
  },
  title: '稅金', sub: '所得稅（實際獲利）／同居稅／寵物稅／房屋稅，四者獨立計算', module: 'tax',

  async render(el) {
    await H.loadMeta();
    const [c, periods] = await Promise.all([GET('/tax'), GET('/tax-periods')]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const DOW = ['日', '一', '二', '三', '四', '五', '六'];

    const bracketRow = (b = { over: 0, pct: 5 }) => `
      <tr>
        <td><input class="bk-over" type="number" min="0" value="${b.over ?? 0}" style="width:100%"></td>
        <td><input class="bk-pct" type="number" min="0" max="100" step="0.5" value="${b.pct ?? 0}" style="width:100%"></td>
        <td><button class="btn tiny secondary bk-del">刪除</button></td>
      </tr>`;

    el.innerHTML = `
      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>基本設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用稅金系統（關閉＝完全不課稅）')}</div>
        <div class="form-row">
          <div class="field"><label>課稅頻率</label>
            <select name="period">
              <option value="week" ${c.period === 'week' ? 'selected' : ''}>每週</option>
              <option value="day" ${c.period === 'day' ? 'selected' : ''}>每日</option>
              <option value="month" ${c.period === 'month' ? 'selected' : ''}>每月</option>
            </select></div>
          <div class="field"><label>每週幾課（頻率＝每週時有效）</label>
            <select name="dow">${DOW.map((d, i) => `<option value="${i}" ${(c.dow ?? 1) === i ? 'selected' : ''}>星期${d}</option>`).join('')}</select></div>
          <div class="field"><label>每月幾號（頻率＝每月時有效）</label><input name="dom" type="number" min="1" max="28" value="${c.dom ?? 1}"></div>
          <div class="field"><label>結算時間（台北）</label><input name="run_time" value="${c.run_time || '09:00'}" placeholder="09:00"></div>
        </div>
        <div class="field"><label>稅收公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">會公布本期總稅收與納稅大戶排行。</div></div>
        <div class="form-row">
          <div class="field">${H.toggle('dm_bill', c.dm_bill, '私訊每個人自己的稅單')}</div>
          <div class="field"><label>稅額低於多少就免徵</label><input name="min_total" type="number" min="0" value="${c.min_total ?? 1}">
            <div class="hint">避免對只有幾十塊的新手洗版。</div></div>
        </div>
        <div class="field">${H.toggle('no_debt', c.no_debt ?? 1, '課完稅不讓餘額變負數（錢不夠只課到 0，差額算未繳）')}
          <div class="hint">建議開啟：被課成負債的玩家常會直接不玩。關掉＝錢不夠就欠稅、餘額變負數。</div></div>
        <div class="field"><label>免稅名單：玩家 ID（一行一個，或用逗號分隔）</label>
          <textarea name="exempt_users" rows="3" placeholder="1408375041954943030">${UI.esc(c.exempt_users || '')}</textarea>
          <div class="hint">名單內的人完全不課稅、也不會出現在納稅大戶排行。管理員／活動帳號放這裡。</div></div>
        <div class="field"><label>免稅身分組（一行一個 role_id，或用逗號分隔）</label>
          <textarea name="exempt_roles" rows="2" placeholder="身分組 ID">${UI.esc(c.exempt_roles || '')}</textarea></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>💰 所得稅（只課「本期實際獲利」）</h3>
        <div class="field">${H.toggle('income_enabled', c.income_enabled, '開徵所得稅')}</div>
        <div class="hint" style="margin-bottom:10px">
          <b>課稅基準已固定為「本期實際獲利」</b>，不再能選餘額或總資產——
          對既有資產課稅會變成玩家沒賺到錢也要繳。<br>
          ✅ <b>計入</b>：賣東西、任務、簽到、成就、大賽、魚缸收成等收入，
          ＋ 股票<b>賣出後</b>的淨損益（買賣手續費已含在內）。<br>
          🚫 <b>不計入</b>：轉帳、銀行存提款、信貸本金與還款、各種退款、交易返還、
          股票未實現漲跌，以及玩家原本就有的資產與餘額。
        </div>
        <div class="form-row">
          <div class="field"><label>免稅額</label><input name="income_free" type="number" min="0" value="${c.income_free ?? 100000}">
            <div class="hint">本期獲利低於這個數字完全不課，超過的部分才進級距。</div></div>
          <div class="field"><label>單次稅額上限（占餘額 %）</label><input name="income_max_pct" type="number" min="0" max="100" value="${c.income_max_pct ?? 50}">
            <div class="hint">四稅合計不會超過餘額的這個比例，避免一次被抄家。超過時先砍所得稅。</div></div>
        </div>
        <div class="field">${H.toggle('income_flat', c.income_flat ?? 1, '整筆跳級（餘額落在哪一級，就用那一級的 % 課整個餘額）')}
          <div class="hint">關閉＝分段累進（像真實所得稅，只對超過的那一段課）。</div></div>
        <div class="table-wrap"><table class="list" id="bktable">
          <thead><tr><th>超過這個金額的部分</th><th>課 %</th><th style="width:80px"></th></tr></thead>
          <tbody>${(c.brackets || []).map(bracketRow).join('')}</tbody>
        </table></div>
        <button class="btn small secondary" id="addbk" style="margin-top:8px">＋ 新增級距</button>
        <div class="hint" style="margin-top:6px"><b>整筆跳級</b>（預設）：餘額 60 萬、級距「超過 40 萬課 3%」→ 直接課 60 萬的 3% ＝ 18,000。<br>
          <b>分段累進</b>（關掉開關）：只對第 40 萬以上的 20 萬課 3% ＝ 6,000。<br>
          預設級距已改成<b>級距小、稅率低</b>（1／2／3／5／7／10／13／17／20%，共 9 級）：跳一級不會突然爆增，級距之間的差別也比較有感。要恢復預設就把下面的級距全部刪掉再儲存。</div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <details>
          <summary><b>🗄️ 農地稅／養殖稅（2026-09 已停徵）</b></summary>
          <div class="hint" style="margin:8px 0">
            這兩種都是「依既有資產課稅」——玩家沒賺到錢也要繳，錢包被慢慢刮掉，
            與新制「只課實際獲利」直接衝突，所以已經停徵，設定值不再影響結算。
            欄位保留只是為了讓舊資料看得懂；真的要開回來就把開關打開。
          </div>
          <div class="field">${H.toggle('land_enabled', c.land_enabled, '開徵農地稅（已停用）')}</div>
          <div class="form-row">
            <div class="field"><label>每格農地</label><input name="land_field" type="number" min="0" value="${c.land_field ?? 50}"></div>
            <div class="field"><label>每格溫室</label><input name="land_greenhouse" type="number" min="0" value="${c.land_greenhouse ?? 120}"></div>
            <div class="field"><label>前幾格免稅</label><input name="land_free" type="number" min="0" value="${c.land_free ?? 2}"></div>
          </div>
          <div class="field">${H.toggle('breed_enabled', c.breed_enabled, '開徵養殖稅（已停用）')}</div>
          <div class="form-row">
            <div class="field"><label>每隻牧場動物</label><input name="breed_animal" type="number" min="0" value="${c.breed_animal ?? 80}"></div>
            <div class="field"><label>每條 SSR 魚</label><input name="breed_fish" type="number" min="0" value="${c.breed_fish ?? 200}"></div>
            <div class="field"><label>前幾隻／條免稅</label><input name="breed_free" type="number" min="0" value="${c.breed_free ?? 1}"></div>
          </div>
          <div class="field"><label>設施每高一階，土地稅 +N%</label><input name="land_tier_pct" type="number" min="0" value="${c.land_tier_pct ?? 20}"></div>
        </details>
      </div>

      <div class="card" style="max-width:820px">
        <h3>🏡 房屋稅</h3>
        <div class="field">${H.toggle('house_enabled', c.house_enabled ?? 1, '課房屋稅（房子越大稅越重）')}</div>
        <div class="form-row">
          <div class="field"><label>每一階的基礎稅額</label><input name="house_base" type="number" min="0" value="${c.house_base ?? 300}"></div>
          <div class="field"><label>成長指數（1＝線性，越大越懲罰高階）</label><input name="house_curve" type="number" min="1" max="4" step="0.1" value="${c.house_curve ?? 1.6}"></div>
          <div class="field"><label>前幾階免稅</label><input name="house_free" type="number" min="0" value="${c.house_free ?? 3}"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>每件「已擺出」的家具加課</label><input name="house_furniture" type="number" min="0" value="${c.house_furniture ?? 50}"></div>
          <div class="field"><label>每隻寵物加課（已停用）</label><input name="house_pet" type="number" min="0" value="${c.house_pet ?? 0}">
            <div class="hint">寵物已經另有<b>寵物稅</b>，這裡再加課會變成同一隻課兩次，所以改版時歸零了。</div></div>
        </div>
        <div class="field"><label>各級房屋稅（選填，JSON）</label>
          <input name="house_lv_table" value="${UI.esc(c.house_lv_table || '')}" placeholder='{"10":20000,"15":80000}'>
          <div class="hint">想直接指定「幾階收多少」時填這裡，例如 <code>{"10":20000}</code>＝Lv.10 固定收 20,000。
            沒填到的階級、或整欄留空，就用上面的曲線公式。填錯格式不會覆蓋原本的設定。</div></div>
        <div class="hint">公式：基礎 ×（房屋階級 − 免稅階）^ 指數 ＋ 家具×單價。
          2026-09 起整體調高（基礎 300 → 900）：家園加成是永久的，稅太輕蓋房子就變成純賺。<br>
          目前設定下，Lv.15 的房子光階級就要 ${Math.round((c.house_base ?? 900) * Math.pow(15 - (c.house_free ?? 3), c.house_curve ?? 1.6)).toLocaleString('en-US')} 星幣／期。</div>
      </div>

      <div class="card" style="max-width:820px">
        <h3>💞 同居稅（倍增累進）</h3>
        <div class="field">${H.toggle('partner_enabled', c.partner_enabled ?? 1, '課同居稅（角色搬進家裡就要養）')}</div>
        <div class="form-row">
          <div class="field"><label>第 1 位的基礎稅額</label><input name="partner_base" type="number" min="0" value="${c.partner_base ?? 5000}"></div>
          <div class="field"><label>每多一位乘幾倍</label><input name="partner_step" type="number" min="2" max="10" value="${c.partner_step ?? 2}"></div>
        </div>
        <div class="hint">
          第 1 位＝基礎、第 2 位 ×${c.partner_step ?? 2}、第 3 位 ×${Math.pow(c.partner_step ?? 2, 2)}…依此類推。
          目前設定下養 3 位每期共 <b>${(() => { const st = c.partner_step ?? 2, b0 = c.partner_base ?? 5000;
            return Math.floor(b0 * (Math.pow(st, 3) - 1) / (st - 1)).toLocaleString('en-US'); })()}</b> 星幣。<br>
          <b>同居人數已經沒有上限</b>，改由這條稅自然節制——養得起就儘管養。
          （好感度加課 partner_per_lv 是舊制，已不再計入。）</div>

        <h3 style="margin-top:18px">🐾 寵物稅（倍增累進）</h3>
        <div class="field">${H.toggle('pet_enabled', c.pet_enabled ?? 1, '課寵物稅')}</div>
        <div class="form-row">
          <div class="field"><label>第 1 隻的基礎稅額</label><input name="pet_base" type="number" min="0" value="${c.pet_base ?? 3000}"></div>
          <div class="field"><label>每多一隻乘幾倍</label><input name="pet_step" type="number" min="2" max="10" value="${c.pet_step ?? 2}"></div>
        </div>
        <div class="hint">
          算法跟同居稅一樣。目前設定下養 3 隻每期共 <b>${(() => { const st = c.pet_step ?? 2, b0 = c.pet_base ?? 3000;
            return Math.floor(b0 * (Math.pow(st, 3) - 1) / (st - 1)).toLocaleString('en-US'); })()}</b> 星幣。<br>
          <b>寵物隻數也沒有上限</b>，已領養的寵物永久保留、可自由替換，不必重買也不會重置養成資料。</div>
      </div>



        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🗄️ 消費稅（2026-09 已停徵）</h3>
        <div class="hint" style="margin-bottom:10px"><b>已停徵，設定值不影響結算。</b>
          新制只課「實際賺到的錢」，把錢花掉本來就不是收入，再課一次等於重複課稅。欄位保留給舊資料。</div>
        <div class="field">${H.toggle('spend_enabled', c.spend_enabled, '開徵消費稅（已停用）')}</div>
        <div class="form-row">
          <div class="field"><label>稅率 %（本期兌換金額）</label><input name="spend_pct" type="number" min="0" max="100" step="0.5" value="${c.spend_pct ?? 20}">
            <div class="hint">例如 20%：這期兌換花了 20,000 → 課 4,000。</div></div>
          <div class="field"><label>兌換金額免稅額</label><input name="spend_free" type="number" min="0" value="${c.spend_free ?? 0}">
            <div class="hint">這期兌換總額低於這個數字的部分不課。</div></div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>⚖️ 欠稅強制清算</h3>
        <div class="hint" style="margin-bottom:10px">餘額是負數的人，系統自動變賣資產抵債，<b>只賣到剛好還清為止</b>。<b>預設只賣股票</b>——農場／魚缸被系統收掉玩家會直接不想玩。股票照現價扣手續費（現價是負數的不賣）、背包照 <code>/賣出</code> 的即時價、動物與魚回收半價。免稅名單的人不會被清算。<br>另外課稅本身已<b>不會</b>把人課成負數（見下方「課完稅不讓餘額變負數」），所以這裡通常只會處理負價股造成的負債。</div>
        <div class="field">${H.toggle('liquidate_enabled', c.liquidate_enabled, '啟用強制清算')}</div>
        <div class="field"><label>變賣順序</label>
          <select name="liquidate_order">
            <option value="stock" ${(c.liquidate_order||'stock')==='stock'?'selected':''}>只賣股票（推薦：不動農場／魚缸／背包）</option>
            <option value="stock,bag" ${c.liquidate_order==='stock,bag'?'selected':''}>股票 → 背包物品</option>
            <option value="bag,stock" ${c.liquidate_order==='bag,stock'?'selected':''}>背包物品 → 股票</option>
            <option value="stock,bag,fish,animal" ${c.liquidate_order==='stock,bag,fish,animal'?'selected':''}>股票 → 背包 → 魚 → 動物（最嚴格，玩家會很痛）</option>
          </select></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🤝 普發（救濟金）</h3>
        <div class="hint" style="margin-bottom:10px">課完稅之後立刻執行：把窮的／欠稅的人拉回來，縮小貧富差距。管理員免稅名單內的人不會領。</div>
        <div class="field">${H.toggle('relief_enabled', c.relief_enabled, '啟用普發')}</div>
        <div class="form-row">
          <div class="field"><label>發放對象：餘額低於</label><input name="relief_below" type="number" value="${c.relief_below ?? 0}">
            <div class="hint">填 0＝只發給餘額是負數的人；填 50000＝餘額不到 5 萬的都發。</div></div>
          <div class="field"><label>發放方式</label>
            <select name="relief_mode">
              <option value="floor" ${(c.relief_mode || 'floor') === 'floor' ? 'selected' : ''}>補到保底金額（負債的人先填平）</option>
              <option value="fixed" ${c.relief_mode === 'fixed' ? 'selected' : ''}>每人發固定金額</option>
            </select></div>
        </div>
        <div class="form-row">
          <div class="field"><label>保底金額（補到多少）</label><input name="relief_floor" type="number" value="${c.relief_floor ?? 0}">
            <div class="hint">「補到保底」模式用：餘額 −5,000、保底 10,000 → 發 15,000。</div></div>
          <div class="field"><label>固定金額（每人發多少）</label><input name="relief_amount" type="number" min="0" value="${c.relief_amount ?? 10000}">
            <div class="hint">「固定金額」模式用。</div></div>
        </div>
        <div class="form-row">
          <div class="field"><label>每人單期上限（0＝不限）</label><input name="relief_max" type="number" min="0" value="${c.relief_max ?? 0}"></div>
          <div class="field">${H.toggle('relief_from_tax', c.relief_from_tax ?? 1, '財源限本期稅收（不夠就等比例縮減）')}
            <div class="hint">關掉＝憑空發錢，會讓星幣總量變多。</div></div>
        </div>
        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>📈 證券稅（依「持股市值」課，股票也要繳稅）</h3>
        <div class="hint" style="margin-bottom:10px"><b>⚠️ 證券稅已於 2026-09 停徵，設定值不影響結算。</b>
          股票改成只收<b>買賣手續費各 1.5%</b>，並採<b>實現獲利制</b>——賣出後的淨獲利才計入所得稅，
          未實現的漲跌不課。再按持股市值課一次證券稅會與這條規則直接衝突。</div>
        <div class="field">${H.toggle('stock_enabled', c.stock_enabled, '開徵證券稅（已停用）')}</div>
        <div class="form-row">
          <div class="field"><label>稅率 %（持股市值）</label><input name="stock_pct" type="number" min="0" max="100" step="0.5" value="${c.stock_pct ?? 5}">
            <div class="hint">市值＝所有持股的「股數 × 現價」，現價是負數的股票不計入、也不會退稅。</div></div>
          <div class="field"><label>市值免稅額</label><input name="stock_free" type="number" min="0" value="${c.stock_free ?? 0}">
            <div class="hint">市值低於這個數字的部分不課。</div></div>
        </div>

        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="savecfg">儲存設定</button>
          <button class="btn secondary" id="dryrun">試算（不扣款）</button>
          <button class="btn secondary" id="runnow">立即課徵一期</button>
        </div>
        <div class="hint" style="margin-top:6px">試算與立即課徵都是用<b>目前儲存的設定</b>，改完記得先儲存。</div>
      </div>

      <div class="card">
        <h3>稅收紀錄</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>期間</th><th>人數</th><th>實收</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th></th></tr></thead>
          <tbody>
            ${periods.length ? periods.map(p => `<tr>
              <td>${UI.esc(p.period)}</td><td>${p.people}</td><td>${coin(p.paid)}</td>
              <td>${coin(p.income)}</td><td>${coin(p.land)}</td><td>${coin(p.breed)}</td>
              <td><button class="btn tiny secondary" data-period="${UI.esc(p.period)}">明細</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="hint">還沒課過稅。</td></tr>'}
          </tbody>
        </table></div>
      </div>`;

    const collectCfg = () => {
      const body = H.collect(el.querySelector('#cfgwrap'));
      body.brackets = [...el.querySelectorAll('#bktable tbody tr')].map(tr => ({
        over: +tr.querySelector('.bk-over').value || 0,
        pct: +tr.querySelector('.bk-pct').value || 0
      })).filter(b => b.pct > 0);
      return body;
    };

    const bindDel = () => el.querySelectorAll('.bk-del').forEach(b => b.onclick = () => b.closest('tr').remove());
    bindDel();
    el.querySelector('#addbk').onclick = () => {
      el.querySelector('#bktable tbody').insertAdjacentHTML('beforeend', bracketRow());
      bindDel();
    };

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/tax', collectCfg());
      UI.ok('已儲存設定'); App.go('tax');
    };

    const showResult = (r) => {
      const rows = r.top.map(t => `<tr><td>${H.who(t.user_id, t.username)}</td><td>${coin(t.balance)}</td>
        <td>${coin(t.income)}</td><td>${coin(t.land)}</td><td>${coin(t.breed)}</td><td><b>${coin(t.total)}</b></td></tr>`).join('');
      UI.modal({
        title: r.dryRun ? `試算結果（未扣款）` : `已課徵 ${r.period}`,
        bodyHTML: `<p>共 <b>${r.people}</b> 人要繳，總額 <b>${coin(r.sum)}</b>${r.dryRun ? '（僅試算）' : ''}</p>
          <div class="table-wrap"><table class="list">
            <thead><tr><th>玩家</th><th>餘額</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th>合計</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="hint">沒有人要繳稅。</td></tr>'}</tbody></table></div>`,
        okText: '關閉'
      });
    };

    el.querySelector('#dryrun').onclick = async () => showResult(await POST('/tax-run', { dry: '1' }));
    el.querySelector('#runnow').onclick = async () => {
      if (!await UI.confirm('立即課徵一期？會真的從玩家錢包扣款並公告，無法復原。')) return;
      const r = await POST('/tax-run', {});
      UI.ok('已完成課徵'); showResult(r); App.go('tax');
    };

    el.querySelectorAll('[data-period]').forEach(b => b.onclick = async () => {
      const rows = await GET('/tax-records?period=' + encodeURIComponent(b.dataset.period));
      UI.modal({
        title: `${b.dataset.period} 稅單明細`,
        bodyHTML: `<div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>當時餘額</th><th>所得稅</th><th>農地稅</th><th>養殖稅</th><th>證券稅</th><th>消費稅</th><th>慈善折抵</th><th>應繳</th><th>實繳</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${H.who(r.user_id, r.username)}</td><td>${coin(r.balance)}</td>
            <td>${coin(r.income_tax)}</td><td>${coin(r.land_tax)}</td><td>${coin(r.breed_tax)}</td><td>${coin(r.stock_tax)}</td><td>${coin(r.spend_tax)}</td>
            <td>${r.charity_credit ? `−${coin(r.charity_credit)}` : '—'}</td>
            <td>${coin(r.total)}</td><td>${r.total > r.paid ? `<span style="color:#e67e22">${coin(r.paid)}（未繳 ${coin(r.total - r.paid)}）</span>` : coin(r.paid)}</td>
          </tr>`).join('')}</tbody></table></div>`,
        okText: '關閉'
      });
    });
  }
});
