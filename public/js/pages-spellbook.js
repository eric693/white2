// ===== 咒語簿開通 =====
// 咒語簿是玩家自己的「常用台詞剪貼庫」（網頁 App，可加到手機主畫面）。
// 這一頁只決定「誰能用」——內容是玩家私人的，後台只看得到則數。
App.page('spellbook', {
  help: {
    "intro": "咒語簿是給玩家用的手機小 App（/spell 網址）：把常用的台詞分資料夾存起來，點一下複製，切回 Discord 貼上。預設全伺服器關閉，開通名單上的人才打得開。",
    "steps": [
      "先在「功能設定」把咒語簿打開，存檔。",
      "在「開通名單」按『＋ 開通玩家』挑人（可設使用期限），他就能用了。",
      "把那一列的『複製連結』給玩家，或請玩家自己在 Discord 打 /咒語簿 拿連結。",
      "想整批開放給某個身分組，就在設定裡勾『身分組白名單』——有那個身分組的人自動有權限。"
    ],
    "notes": [
      "連結帶簽章而且要本人 Discord 登入，轉傳給別人也打不開。",
      "取消開通後他馬上就打不開了，但內容會留著；重新開通就原樣回來（要清掉請按『清空內容』）。",
      "後台看不到玩家寫了什麼，只有資料夾數／則數／複製次數。",
      "玩家在 iPhone 要用 Safari 開連結 →『加入主畫面』才會變成一顆 App 圖示。"
    ]
  },
  title: '咒語簿開通', sub: '玩家的常用台詞剪貼庫：誰能用由這裡決定', module: 'spellbook',

  async render(el) {
    await H.loadMeta();
    await H.loadNicks();
    const cfg = await GET('/spellbook');
    const rows = await GET('/spellbook/access');

    const never = (r) => !r.expires_at
      ? '永久'
      : new Date(r.expires_at * 1000).toLocaleDateString('zh-TW') + (r.expired ? '（已過期）' : '');

    el.innerHTML = `
      <div class="card">
        <h3>功能設定</h3>
        <div id="cfg">
          <div class="field">${H.toggle('enabled', cfg.enabled, '啟用咒語簿（關閉時所有人都打不開）')}</div>
          <div class="field">${H.toggle('share_enabled', cfg.share_enabled, '允許玩家互相分享資料夾（產生分享碼，可加密碼）')}</div>
          <div class="field"><label>身分組白名單（有其中一個身分組就自動有權限，可不選）</label>
            ${multiBox('role_ids', H.roles || [], (cfg.role_ids || []).join(','), r => '@ ' + r.name)}</div>
          <div class="form-row">
            <div class="field"><label>每人資料夾上限</label><input name="max_folders" type="number" value="${cfg.max_folders || 30}"></div>
            <div class="field"><label>每個資料夾則數上限</label><input name="max_entries" type="number" value="${cfg.max_entries || 200}"></div>
            <div class="field"><label>單則字數上限</label><input name="max_len" type="number" value="${cfg.max_len || 4000}"></div>
          </div>
          <div class="field"><label>App 首頁公告（可空）</label>
            <input name="notice" maxlength="200" value="${UI.esc(cfg.notice || '')}" placeholder="例：有問題找 @小幫手"></div>
        </div>
        <div class="toolbar"><button class="btn" id="save">儲存設定</button></div>
      </div>

      <div class="card">
        <h3>開通名單</h3>
        <div class="toolbar"><button class="btn" id="add">＋ 開通玩家</button></div>
        <div class="table-wrap"><table class="list">
          <thead><tr><th>玩家</th><th>備註</th><th>期限</th><th>資料夾</th><th>則數</th><th>複製次數</th><th>開通者</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map(r => `
            <tr>
              <td>${H.who(r.user_id, r.username)}</td>
              <td class="wrap">${UI.esc(r.note || '')}</td>
              <td>${r.expired ? `<span class="tag danger">${never(r)}</span>` : never(r)}</td>
              <td>${r.folders}</td><td>${r.entries}</td><td>${r.copies}</td>
              <td>${UI.esc(r.granted_by || '')}</td>
              <td>
                <button class="btn tiny secondary" data-link="${UI.esc(r.link)}">複製連結</button>
                <button class="btn tiny secondary" data-wipe="${r.user_id}">清空內容</button>
                <button class="btn tiny danger" data-del="${r.user_id}">取消開通</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty">還沒有人被開通</td></tr>'}
          </tbody></table></div>
        <div class="hint">玩家拿到連結後，在手機瀏覽器「加入主畫面」就會變成一顆 App 圖示；也可以在 Discord 打 <b>/咒語簿</b> 自己拿連結。</div>
      </div>`;

    H.paintNicks(el);

    document.getElementById('save').onclick = async (e) => {
      const box = document.getElementById('cfg');
      const body = H.collect(box);
      body.role_ids = multiVal(box, 'role_ids');
      e.target.disabled = true;
      try { await PUT('/spellbook', body); UI.ok('已儲存'); App.go('spellbook'); }
      catch (err) { UI.err(err.message); }
      finally { e.target.disabled = false; }
    };

    document.getElementById('add').onclick = () => {
      const { back } = UI.modal({
        title: '開通咒語簿', okText: '開通',
        bodyHTML: `
          ${H.memberPicker('user_id', 'username')}
          <div class="form-row">
            <div class="field"><label>Discord 使用者 ID</label><input name="user_id" placeholder="搜尋挑人會自動帶入"></div>
            <div class="field"><label>顯示名稱</label><input name="username"></div>
          </div>
          <div class="field"><label>備註（為什麼開通、給誰的）</label><input name="note" maxlength="200"></div>
          <div class="field"><label>使用期限</label>
            <select name="days">
              <option value="0" selected>永久</option>
              <option value="7">7 天</option><option value="30">30 天</option>
              <option value="90">90 天</option><option value="365">一年</option>
            </select></div>`,
        onOk: async (b) => {
          const body = H.collect(b.querySelector('.modal-body'));
          if (!String(body.user_id || '').trim()) { UI.err('請先挑一位玩家'); return false; }
          const r = await POST('/spellbook/access', body);
          UI.ok('已開通，把連結給玩家就能用了');
          App.go('spellbook');
          navigator.clipboard && navigator.clipboard.writeText(r.link).catch(() => {});
        }
      });
      H.bindMemberPickers(back);
    };

    el.querySelectorAll('[data-link]').forEach(b => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.link); UI.ok('連結已複製，貼給玩家即可'); }
      catch { UI.err('複製失敗，連結：' + b.dataset.link); }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('取消這個人的咒語簿權限？（他寫的內容會留著，重新開通就回來）', '取消開通')) return;
      await DEL('/spellbook/access/' + b.dataset.del);
      UI.ok('已取消開通'); App.go('spellbook');
    });
    el.querySelectorAll('[data-wipe]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('清空這個人咒語簿裡的所有資料夾與內容？這個動作救不回來。', '清空')) return;
      await DEL('/spellbook/data/' + b.dataset.wipe);
      UI.ok('已清空'); App.go('spellbook');
    });
  }
});
