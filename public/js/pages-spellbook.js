// ===== 咒語簿開通 =====
// 咒語簿是玩家自己的「常用台詞剪貼庫」（網頁 App，可加到手機主畫面）。
// 這一頁只決定「誰能用」——內容是玩家私人的，後台只看得到則數。
App.page('spellbook', {
  help: {
    "intro": "咒語簿是給玩家用的手機小程式：把常用的長台詞存起來，在手機上點一下就複製，切回 Discord 貼上就好。預設沒有任何人能用 —— 你在這一頁開通誰，誰才打得開。",
    "steps": [
      "把上面的「啟用咒語簿」打開，按『儲存設定』。（這個沒開，就算名單裡有人也打不開）",
      "在下面的「開通名單」按『＋ 開通玩家』→ 打玩家名字搜尋、點一下選他 →（要限時就選期限）→ 按『開通』。",
      "那一列按『複製連結』，把連結私訊給那位玩家 —— 這樣就好，不必公告、也不會有人發現。",
      "玩家用手機瀏覽器打開連結 → 按『用 Discord 登入』一次 → 再用瀏覽器的分享鍵『加入主畫面』，之後桌面就有一顆咒語簿圖示，開起來跟 App 一樣。",
      "以後不想讓某個人用了：按他那一列的『取消開通』，他下一秒就打不開。"
    ],
    "notes": [
      "低調模式（預設）：不勾「在 Discord 顯示 /咒語簿 指令」的話，指令根本不會註冊到伺服器，其他人在指令列看不到它，只有你把連結給誰、誰才知道有這東西。想公開再勾起來。",
      "要一次開放給一群人：勾上面的「身分組白名單」，有那個身分組的人自動就能用，不用一個一個加。",
      "連結是每個人專屬的，轉傳給別人也沒用 —— 打開時要用本人的 Discord 帳號登入才進得去。",
      "取消開通只是收回權限，他寫的內容還留著，重新開通就原樣回來；真的要清掉才按『清空內容』（清了救不回來）。",
      "期限選了天數就會自動到期，那一列會標「已過期」，等於自動失效。",
      "這一頁只看得到他有幾個資料夾、幾則內容、被複製過幾次，看不到他寫了什麼。"
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
          <div class="field">${H.toggle('show_command', cfg.show_command, '在 Discord 顯示 /咒語簿 指令（預設不勾＝低調模式，別人的指令列不會出現它）')}
            <div class="hint">不勾也完全能用：你在下面「開通名單」複製連結私訊給誰，誰就能用；其他人不會知道有這個功能。</div></div>
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
        <div class="hint">玩家拿到連結後，在手機瀏覽器「加入主畫面」就會變成一顆 App 圖示。連結私訊給他就好；只有勾了上面的「在 Discord 顯示指令」時，玩家才能自己打 <b>/咒語簿</b> 拿連結。</div>
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
