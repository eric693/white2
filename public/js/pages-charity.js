// ===== 慈善基金會：捐款抵稅、餘額公開、自動撥進普發池 =====
App.page('charity', {
  help: {
    "intro": "公開帳戶：玩家捐款可折抵稅金，收到的稅也會進來，再由你普發回饋給玩家。",
    "steps": [
      "開啟後設定最低捐款金額與折抵比例（捐款金額 × 折抵％ 直接扣稅額）。",
      "要發錢時用「手動普發」：先設條件與金額，按試算看會發給幾人、共多少，再執行。",
      "財源選「基金會」是花池子裡的錢；選「直接增發」是憑空生錢，會讓總量變多，請謹慎。"
    ],
    "notes": [
      "普發單人金額上限 100 億、發完不能讓對方超過 1 兆，這是防止把經濟灌爆的防呆。",
      "捐款排行只公開前三名，避免變成比誰有錢。"
    ]
  },
  title: '基金會', sub: '玩家 /捐款 進公開帳戶，可折抵稅額，餘額自動變成普發救濟金', module: 'charity',

  async render(el) {
    await H.loadMeta();
    const c = await GET('/charity');
    const roles = await GET('/charity-roles').catch(() => []);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;

    el.innerHTML = `
      <div class="card" style="max-width:820px">
        <h3>帳目</h3>
        <div class="form-row">
          <div class="field"><label>目前餘額</label><div style="font-size:22px;font-weight:700">${coin(c.pool)}</div></div>
          <div class="field"><label>累計募得</label><div style="font-size:22px">${coin(c.total_in)}</div></div>
          <div class="field"><label>已撥出當救濟金</label><div style="font-size:22px">${coin(c.total_out)}</div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="max-width:220px"><label>手動增減餘額（可填負數）</label><input id="delta" type="number" placeholder="例如 50000"></div>
          <button class="btn small secondary" id="adjust">套用</button>
        </div>
        <div class="hint">活動加碼或修正誤差用。正數＝注資（也會算進累計募得），負數＝抽走。</div>
      </div>

      <div class="card" style="max-width:820px" id="cfgwrap">
        <h3>設定</h3>
        <div class="field">${H.toggle('enabled', c.enabled, '啟用慈善基金會（關閉＝玩家不能捐款）')}</div>
        <div class="form-row">
          <div class="field"><label>基金會名稱</label><input name="name" value="${UI.esc(c.name || '慈善基金會')}"></div>
          <div class="field"><label>單筆最低捐款</label><input name="min_donate" type="number" min="0" value="${c.min_donate ?? 1000}"></div>
        </div>
        <div class="field"><label>捐款公告頻道（留空＝不公告）</label>${H.chanSelect('channel', c.channel || '')}
          <div class="hint">每有人捐款就公布「誰捐了多少、基金會剩多少」，帳目公開才有捐款動機。</div></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h3>🧾 捐款抵稅</h3>
        <div class="form-row">
          <div class="field"><label>折抵比例 %</label><input name="deduct_pct" type="number" min="0" max="100" step="0.5" value="${c.deduct_pct ?? 10}">
            <div class="hint">10％＝捐 100,000 折抵 10,000 稅金。折抵只算<b>上次結算之後</b>的捐款，結算後重新起算。</div></div>
          <div class="field"><label>每人每期折抵上限（0＝不限）</label><input name="deduct_max" type="number" min="0" value="${c.deduct_max ?? 0}"></div>
          <div class="field"><label>最多能抵掉稅金的 %</label><input name="deduct_max_pct" type="number" min="0" max="100" value="${c.deduct_max_pct ?? 100}">
            <div class="hint">100＝可以完全免稅；設 50＝最多只能少繳一半。</div></div>
        </div>
        <div class="field">${H.toggle('to_relief', c.to_relief, '基金會餘額自動當普發（救濟金）財源')}
          <div class="hint">開啟＝結算時普發不夠的部分從基金會撥出，捐款直接變成別人的救濟金（在稅金頁設定普發條件）。</div></div>
        <div style="margin-top:16px"><button class="btn" id="savecfg">儲存設定</button></div>
      </div>

      <div class="card">
        <h3>捐款榜（歷史累計）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>累計捐款</th><th>筆數</th></tr></thead>
          <tbody>${(c.top || []).length ? c.top.map((t, i) => `<tr>
            <td>${i + 1}. ${H.who(t.user_id, t.username)}</td><td>${coin(t.amount)}</td><td>${t.times}</td></tr>`).join('')
        : '<tr><td colspan="3" class="hint">還沒有人捐款。</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <h3>最近捐款</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>時間</th><th>玩家</th><th>金額</th><th>當時可折抵</th></tr></thead>
          <tbody>${(c.recent || []).length ? c.recent.map(r => `<tr>
            <td>${UI.esc(r.created_at)}</td><td>${H.who(r.user_id, r.username)}</td><td>${coin(r.amount)}</td><td>${coin(r.credit)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="hint">還沒有捐款紀錄。</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card" id="reliefwrap">
        <h3>💸 手動普發（活動用）</h3>
        <div class="hint" style="margin-bottom:10px">
          跟稅金頁的自動普發不同：那個綁在結算流程、只發給餘額低於門檻的人。
          這裡是活動用的一鍵普發（例如「全服普發一萬」），可以先<strong>試算</strong>再執行。
        </div>
        <div class="form-row">
          <div class="field"><label>每人發多少</label><input name="amount" type="number" min="1" value="10000"></div>
          <div class="field"><label>發給誰</label><select name="mode">
            <option value="all">全部玩家</option>
            <option value="below">只發給餘額低於門檻的人</option></select></div>
          <div class="field"><label>門檻（上面選「低於門檻」才用）</label><input name="below" type="number" value="0"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>只發給最近幾天有活動的人（0＝不限）</label><input name="active_days" type="number" min="0" value="14"></div>
          <div class="field"><label>財源</label><select name="source">
            <option value="pool">基金會餘額（推薦）</option>
            <option value="free">直接增發（憑空印錢，會通膨）</option></select></div>
          <div class="field"><label>公告頻道（留空＝用捐款公告頻道）</label>${H.chanSelect('channel', '')}</div>
        </div>
        <div class="form-row">
          <div class="field">${H.toggle('exclude_exempt', 1, '排除免稅名單（管理員／活動帳號）')}</div>
          <div class="field">${H.toggle('exclude_debt', 0, '排除餘額為負的人（欠稅大戶）')}</div>
          <div class="field"><label>公告理由（可留空）</label><input name="reason" placeholder="週年慶普發"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn secondary" id="preview">🔍 試算</button>
          <button class="btn" id="dorelief" disabled>💸 執行普發</button>
        </div>
        <div id="previewout" class="hint" style="margin-top:10px">先按「試算」看看會發給幾個人、總共多少。</div>
      </div>

      <div class="card">
        <h3>撥款紀錄（給普發）</h3>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>期間</th><th>撥出金額</th><th>受益人數</th><th>時間</th></tr></thead>
          <tbody>${(c.payouts || []).length ? c.payouts.map(p => `<tr>
            <td>${UI.esc(p.period)}</td><td>${coin(p.amount)}</td><td>${p.people}</td><td>${UI.esc(p.created_at)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="hint">還沒有撥款。</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card" id="rolewrap">
        <h3>🎖️ 捐款達標自動發身分組</h3>
        <div class="hint" style="margin-bottom:10px">
          玩家<b>累計捐款</b>（不是本期，是歷來總額）達到門檻時，機器人自動給他指定的 Discord 身分組。
          例如設「累計 100,000 → @贊助者」，之後拍賣會的「參加資格」就能只開放給 @贊助者。<br>
          ⚠️ 身分組要先在 <b>Discord 伺服器設定 → 身分組</b> 建立，這裡才選得到；
          而且<b>機器人的身分組必須排在它上面</b>，否則 Discord 不允許機器人發放（發不出去會記在系統錯誤紀錄）。<br>
          只發不收：達標拿到就永久保留，刪掉規則也不會把已發出去的收回。
        </div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>累計捐款門檻</th><th>發放身分組</th><th>備註</th><th>狀態</th><th></th></tr></thead>
          <tbody>${(roles || []).length ? roles.map(r => `<tr data-rid="${r.id}">
            <td><input name="threshold" type="number" min="0" value="${r.threshold}" style="width:130px"></td>
            <td>${H.roleSelect('role_id', r.role_id, { emptyLabel: '— 請選擇 —' })}</td>
            <td><input name="note" value="${UI.esc(r.note || '')}" placeholder="選填"></td>
            <td>${H.toggle('enabled', r.enabled, '啟用')}</td>
            <td><button class="btn small" data-rsave="${r.id}">儲存</button>
                <button class="btn small danger" data-rdel="${r.id}">刪除</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="hint">還沒有設定任何門檻。</td></tr>'}</tbody>
        </table></div>
        <div class="form-row" style="margin-top:12px">
          <div class="field"><label>新增門檻（累計捐款）</label><input name="nthreshold" type="number" min="0" value="100000"></div>
          <div class="field"><label>發放身分組</label>${H.roleSelect('nrole', '', { emptyLabel: '— 請選擇 —' })}</div>
          <div class="field"><label>備註（選填）</label><input name="nnote" placeholder="例如：贊助者"></div>
        </div>
        <button class="btn" id="raddbtn">新增門檻</button>
        <button class="btn secondary" id="rsyncbtn" style="margin-left:8px">🔄 回補既有捐款者</button>
        <div class="hint" style="margin-top:8px">
          規則是後來才加的話，先前已經捐到達標的人不會自己拿到 —— 按「回補」幫他們補發一次。
        </div>
      </div>`;

    // ---- 捐款身分組獎勵 ----
    const rowOf = (id) => el.querySelector(`[data-rid="${id}"]`);
    el.querySelectorAll('[data-rsave]').forEach(b => b.onclick = async () => {
      const tr = rowOf(b.dataset.rsave);
      const body = H.collect(tr);
      if (!body.role_id) return UI.err('請先選一個身分組');
      try { await PUT('/charity-roles/' + b.dataset.rsave, body); UI.ok('已儲存'); App.go('charity'); }
      catch (e) { UI.err(e.message); }
    });
    el.querySelectorAll('[data-rdel]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這個門檻？已經發出去的身分組不會被收回。')) return;
      try { await DEL('/charity-roles/' + b.dataset.rdel); UI.ok('已刪除'); App.go('charity'); }
      catch (e) { UI.err(e.message); }
    });
    el.querySelector('#raddbtn').onclick = async () => {
      const w = el.querySelector('#rolewrap');
      const role_id = w.querySelector('[name=nrole]').value;
      if (!role_id) return UI.err('請先選一個身分組');
      try {
        await POST('/charity-roles', {
          threshold: w.querySelector('[name=nthreshold]').value,
          role_id, note: w.querySelector('[name=nnote]').value
        });
        UI.ok('已新增'); App.go('charity');
      } catch (e) { UI.err(e.message); }
    };
    el.querySelector('#rsyncbtn').onclick = async () => {
      if (!await UI.confirm('依現在的門檻，把身分組補發給所有已達標的捐款者？')) return;
      try {
        const r = await POST('/charity-roles/sync', {});
        UI.ok(r.changed ? `已補發 ${r.people} 人共 ${r.changed} 個身分組` : '沒有人需要補發（都已經有了）');
      } catch (e) { UI.err(e.message); }
    };

    el.querySelector('#savecfg').onclick = async () => {
      await PUT('/charity', H.collect(el.querySelector('#cfgwrap')));
      UI.ok('已儲存設定'); App.go('charity');
    };
    // ---- 手動普發：先試算再執行，避免手滑把基金會發空 ----
    const rw = el.querySelector('#reliefwrap');
    const doBtn = el.querySelector('#dorelief');
    const out = el.querySelector('#previewout');
    let lastBody = null;
    el.querySelector('#preview').onclick = async () => {
      const b = H.collect(rw);
      if (!(+b.amount > 0)) return UI.err('請填每人要發多少');
      const r = await POST('/charity-relief-preview', b);
      lastBody = b;
      doBtn.disabled = r.people === 0 || !r.enough;
      out.innerHTML = r.people === 0
        ? '沒有符合條件的玩家。'
        : `會發給 <b>${r.people}</b> 人，每人 ${coin(b.amount)}，總共 <b>${coin(r.total)}</b>。`
        + (b.source === 'free'
          ? '<br>財源＝直接增發（不動基金會餘額）。'
          : `<br>基金會餘額 ${coin(r.pool)} → ${r.enough ? `發完剩 ${coin(r.pool - r.total)}` : '<b style="color:#ed4245">不夠，請降低金額或改用直接增發</b>'}`)
        + `<br><span style="opacity:.7">例：${r.sample.map(x => UI.esc(x.username || x.user_id)).join('、')}${r.people > r.sample.length ? ' …' : ''}</span>`;
    };
    doBtn.onclick = async () => {
      if (!lastBody) return UI.err('請先試算');
      if (!await UI.confirm('確定執行普發？錢會立刻進入玩家錢包，不能復原。')) return;
      try {
        const r = await POST('/charity-relief', lastBody);
        UI.ok(`已普發給 ${r.people} 人，共 ${r.total.toLocaleString('en-US')}`);
        App.go('charity');
      } catch (e) { UI.err(e.message); }
    };

    el.querySelector('#adjust').onclick = async () => {
      const delta = +el.querySelector('#delta').value || 0;
      if (!delta) return UI.err('請填要增減的金額');
      if (!await UI.confirm(`確定要把基金會餘額 ${delta > 0 ? '增加' : '減少'} ${Math.abs(delta).toLocaleString('en-US')}？`)) return;
      await POST('/charity-adjust', { delta });
      UI.ok('已調整'); App.go('charity');
    };
  }
});
