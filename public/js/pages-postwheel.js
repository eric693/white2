// ===== 貼文轉盤（從貼文留言者中抽人）=====
// 轉盤設定都在 /貼文轉盤 指令的選項裡，後台只負責「查得到、補得了」：
// 每次抽選存一筆，可回查中獎名單、可排除已中獎的人補抽。
App.page('postwheel', {
  help: {
    "intro": "管理員在活動貼文底下打 /貼文轉盤，機器人就從「留言過的人」裡直接抽人。這頁看得到每次抽選的紀錄，也可以補抽。",
    "steps": [
      "抽獎在 Discord 進行：到活動貼文的頻道打 /貼文轉盤，貼文欄位留空就會自動抓該頻道最近那則貼文。",
      "抽完的結果會自動記到這頁，點「名單」看中獎者，點「補抽」再抽一次。",
      "補抽預設會排除這則貼文先前中過獎的人，結果直接發回原本的頻道。"
    ],
    "notes": [
      "資格認定：貼文底下討論串的發言、同頻道回覆該貼文的訊息，指令另有選項可把「按表情的人」也算進去。機器人自己的留言不算。",
      "預設一人一票，洗留言不會提高中獎機率；要「留越多則機率越高」請在指令勾選「每則留言算一次資格」。",
      "貼文欄位填錯格式會看到「看不懂這則貼文」——請貼訊息連結（訊息上的「⋯」→ 複製訊息連結）或訊息 ID，或乾脆留空。",
      "補抽需要原貼文還在、且機器人讀得到該頻道的歷史訊息；貼文被刪掉就補抽不了。"
    ]
  },
  title: '貼文轉盤', sub: '從貼文留言者中抽人的紀錄與補抽', module: 'postwheel',

  async render(el) {
    await H.loadMeta();
    const rows = await GET('/postwheel-draws');
    const who = (w) => (H.who ? H.who(w.id, w.tag) : `${UI.esc(w.tag || '')}（${w.id}）`);
    const srcTag = (s) => s === 'reroll' ? '<span class="tag">補抽</span>' : '<span class="tag">指令</span>';

    el.innerHTML = `
      <div class="hint" style="margin-bottom:10px">
        抽獎在 Discord 進行：到活動貼文的頻道打 <code>/貼文轉盤</code>（貼文欄位可留空，會自動抓最近那則）。
        抽完的每一次都會記在這裡。
      </div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>時間</th><th>貼文</th><th>留言者</th><th>中獎</th><th>操作者</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${UI.esc((r.created_at || '').replace('T', ' '))}<br>${srcTag(r.source)}</td>
            <td class="wrap">${r.message_url ? `<a href="${UI.esc(r.message_url)}" target="_blank" rel="noopener">前往貼文</a>` : '（無連結）'}
              <br><span style="color:var(--muted)">${H.chanName(r.channel_id)}${r.post_author ? '｜作者 ' + UI.esc(r.post_author) : ''}</span></td>
            <td>${r.people} 人${r.per_message ? `<br><span style="color:var(--muted)">共 ${r.comments} 則</span>` : ''}</td>
            <td>${r.win_count} 位${r.allow_repeat ? '<br><span class="tag">可重複</span>' : ''}</td>
            <td class="wrap">${UI.esc(r.operator_name || '')}</td>
            <td><button class="btn tiny secondary" data-list="${r.id}">名單</button>
                <button class="btn tiny secondary" data-re="${r.id}">補抽</button>
                <button class="btn tiny danger" data-del="${r.id}">刪除</button></td>
          </tr>`).join('')
          : '<tr><td colspan="6" class="empty">還沒有任何抽選紀錄——到 Discord 的活動貼文底下打 /貼文轉盤 就會出現在這裡</td></tr>'}
        </tbody></table></div>`;

    el.querySelectorAll('[data-list]').forEach(b => b.onclick = () => {
      const r = rows.find(x => x.id == b.dataset.list);
      UI.modal({
        title: '中獎名單', okText: '關閉', onOk: () => {},
        bodyHTML: (r.winners || []).length
          ? `<ol style="padding-left:20px;line-height:2">${r.winners.map(w => `<li>${who(w)}</li>`).join('')}</ol>
             <div class="hint">候選留言者 ${r.people} 人${r.include_reactions ? '（含按表情的人）' : ''}，
               ${r.per_message ? '每則留言各算一次資格' : '同一人不論留幾則都只算 1 票'}。</div>`
          : '<div class="empty">這筆沒有中獎名單</div>'
      });
      if (H.paintNicks) H.paintNicks();
    });

    el.querySelectorAll('[data-re]').forEach(b => b.onclick = () => UI.modal({
      title: '補抽', okText: '補抽',
      bodyHTML: `<div class="field"><label>補抽幾位</label><input name="count" type="number" value="1" min="1" max="50"></div>
        <div class="field">${H.toggle('exclude_previous', 1, '排除這則貼文先前已中獎的人')}</div>
        <div class="hint">會重新讀一次那則貼文的留言者（期間新增的留言也算），結果直接發回原本的頻道。</div>`,
      onOk: async (back) => {
        const body = H.collect(back);
        const out = await POST('/postwheel-draws/' + b.dataset.re + '/reroll', body);
        UI.ok(`已補抽 ${(out.winners || []).length} 位，結果已發到原頻道`);
        App.go('postwheel');
      }
    }));

    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('刪除這筆抽選紀錄？（只刪後台紀錄，Discord 上的訊息不會動）')) return;
      await DEL('/postwheel-draws/' + b.dataset.del); UI.ok('已刪除'); App.go('postwheel');
    });
  }
});
