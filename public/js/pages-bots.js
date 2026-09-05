// ===== 機器人帳號（秘書／管家各自的 Token、OAuth 憑證與外觀）=====
// 憑證存在後台而不是只存 .env：改一次不必 SSH 上機器改檔案。
// Token 與 Client Secret 只會顯示遮罩（末 4 碼），原文不會回到瀏覽器。
App.page('bots', {
  help: {
    "intro": "設定兩隻機器人各自的 Bot Token、OAuth 憑證，以及各自的名稱、頭像與上線狀態。",
    "steps": [
      "到 Discord Developer Portal 各建一個 Application，把 Bot Token 與 OAuth2 的 Client ID／Secret 貼進來。",
      "存好之後用每一欄下方的邀請連結，把對應的機器人邀進伺服器。",
      "改完 Token 要重新啟動那一隻機器人的行程才會生效（名稱、頭像、狀態則是存檔就套用）。"
    ],
    "notes": [
      "Token 與 Client Secret 存檔後只會顯示末 4 碼，不會再顯示原文；欄位留空＝不變更。",
      "沒在這裡設定時，會退回使用 .env 的 DISCORD_TOKEN_SECRETARY／DISCORD_TOKEN_BUTLER。",
      "兩隻機器人共用同一個資料庫與後台，但各自只註冊自己那一半的指令。"
    ]
  },
  title: '機器人帳號', sub: '秘書／管家各自的 Token、OAuth 憑證與外觀', module: 'appearance',

  async render(el) {
    await H.loadMeta();
    const d = await GET('/bot-accounts');
    const META = {
      secretary: { label: '📝 璃白Yu光秘書', desc: '功能型：音樂、抽獎、投票、客服單、論壇、歡迎、等級…' },
      butler: { label: '🎮 璃白Yu光管家', desc: '遊戲型：冒險、農牧、家園、股市、稅務、拍賣…' }
    };
    const STATUS = [['online', '線上'], ['idle', '閒置'], ['dnd', '請勿打擾'], ['invisible', '隱形']];
    const ACT = [['Playing', '正在玩'], ['Listening', '正在聽'], ['Watching', '正在看'], ['Competing', '正在參加']];

    const card = (role) => {
      const r = d[role];
      const isMe = d.current_role === role || d.current_role === 'both';
      const tokenHint = r.token_set
        ? `目前使用後台設定的 Token（${UI.esc(r.token_masked)}）`
        : (r.token_from_env ? '目前使用 <code>.env</code> 裡的 Token（後台沒設定）' : '⚠️ 還沒有設定 Token，這隻機器人不會上線');
      return `
      <div class="card" data-role="${role}">
        <div class="toolbar"><h3 style="margin:0">${META[role].label}</h3>
          <div class="spacer"></div>
          ${isMe ? '<span class="tag ok">這個行程正在扮演它</span>' : '<span class="tag">由另一個行程執行</span>'}</div>
        <div class="hint" style="margin-bottom:12px">${META[role].desc}</div>

        <h4>憑證</h4>
        <div class="field"><label>Bot Token</label>
          <input name="token" type="password" placeholder="${r.token_set ? '已設定，留空＝不變更' : '貼上 Bot Token'}" autocomplete="new-password">
          <div class="hint">${tokenHint}　·　<b>改完要重啟該機器人的行程</b>才會生效。
            ${r.token_set ? '<label class="switch" style="margin-top:6px"><input type="checkbox" name="clear_token"> 清除後台設定的 Token（改回用 .env）</label>' : ''}</div></div>
        <div class="form-row">
          <div class="field"><label>Client ID（OAuth2）</label>
            <input name="client_id" value="${UI.esc(r.client_id)}" placeholder="例如 1234567890123456789"></div>
          <div class="field"><label>Client Secret</label>
            <input name="client_secret" type="password" placeholder="${r.client_secret_set ? '已設定，留空＝不變更' : '貼上 Client Secret'}" autocomplete="new-password">
            <div class="hint">${r.client_secret_set ? `已設定（${UI.esc(r.client_secret_masked)}）` : '玩家遊戲 App 的 Discord 登入會用到（管家）'}</div></div>
        </div>
        ${r.invite
          ? `<div class="field"><label>邀請連結</label><input value="${UI.esc(r.invite)}" readonly onclick="this.select()">
               <div class="hint">把這條連結給對方，就能把「${UI.esc(META[role].label)}」邀進伺服器。</div></div>`
          : '<div class="hint">填好 Client ID 並儲存後，這裡會出現這隻機器人的邀請連結。</div>'}

        <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
        <h4>外觀（這一隻專用）</h4>
        <div class="field"><label>顯示名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="璃白Yu光${role === 'secretary' ? '秘書' : '管家'}">
          <div class="hint">Discord 限制每小時最多變更 2 次。留空＝沿用「外觀自訂」頁的共用設定。</div></div>
        <div class="field"><label>頭像</label>${H.uploadField(`avatar_${role}`, r.avatar || '', { label: '頭像' })}
          ${H.cropButton(`avatar_${role}`, 1, '裁切頭像（選要露出的方形範圍）')}</div>
        <div class="form-row">
          <div class="field"><label>上線狀態</label>
            <select name="status">${STATUS.map(([v, t]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label>活動類型</label>
            <select name="activity_type">${ACT.map(([v, t]) => `<option value="${v}" ${r.activity_type === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>活動狀態文字</label>
          <input name="activity_text" value="${UI.esc(r.activity_text || '')}" placeholder="${role === 'secretary' ? '例如：陪你聊天中' : '例如：經營璃白小鎮'}">
          <div class="hint">會顯示成「正在玩 ⋯」。留空則不顯示活動。</div></div>
      </div>`;
    };

    el.innerHTML = `
      <div class="card">
        <h3>兩隻機器人怎麼跑</h3>
        <div class="hint">
          同一份程式碼、同一個資料庫與後台，用 <code>BOT_ROLE</code> 決定每個行程扮演哪一隻，
          各自只註冊自己那一半的指令（秘書 27 個、管家 76 個）。<br>
          啟動方式：<code>npm run start:secretary</code>（順便跑後台網站）與
          <code>npm run start:butler</code>（<code>WEB=0</code>，只跑機器人；兩個行程都開網站會搶同一個埠）。<br>
          <b>這個後台目前的行程扮演：</b>${UI.esc(d.current_role === 'both' ? '單機器人模式（both）' : (META[d.current_role] || {}).label || d.current_role)}
        </div>
      </div>
      ${card('secretary')}
      ${card('butler')}
      <div class="card"><button class="btn" id="save">儲存機器人帳號設定</button>
        <div class="hint" style="margin-top:8px">名稱、頭像與狀態存檔就套用；<b>Token 與 Client ID／Secret 要重啟對應的行程</b>才會生效。</div></div>`;

    H.bindUploads(el);
    H.bindCropButtons(el);      // 少了這行，「裁切頭像」按鈕會完全沒反應
    H.bindEmojiPickers?.(el);

    el.querySelector('#save').onclick = async () => {
      const body = {};
      for (const role of ['secretary', 'butler']) {
        const box = el.querySelector(`[data-role="${role}"]`);
        const v = (n) => (box.querySelector(`[name="${n}"]`) || {}).value ?? '';
        body[role] = {
          token: v('token'),
          clear_token: !!box.querySelector('[name=clear_token]')?.checked,
          client_id: v('client_id').trim(),
          client_secret: v('client_secret'),
          name: v('name').trim(),
          // 頭像欄位由 uploadField 產生，name 帶著角色後綴
          avatar: (box.querySelector(`[name="avatar_${role}"]`) || {}).value || '',
          status: v('status'),
          activity_type: v('activity_type'),
          activity_text: v('activity_text')
        };
      }
      try {
        const r = await PUT('/bot-accounts', body);
        const needRestart = (r.changed || []).some(x => x.includes('token') || x.includes('secret'));
        UI.ok(needRestart ? '已儲存 —— 憑證有變更，記得重啟對應的機器人行程' : '已儲存');
        App.go('bots');
      } catch (e) { UI.err(e.message); }
    };
  }
});
