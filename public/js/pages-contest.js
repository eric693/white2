// ===== 大賽（週賽／月賽）後台 =====
// 每日任務在「釣魚挖礦」頁；這一頁專門管大賽：比一段期間內某個指標的成長量，冠軍可拿成就。
App.page('contest', {
  title: '大賽', sub: '一週一場「誰賺最多」「誰挖最多」…比成長量，前三名有獎金，冠軍拿成就', module: 'gather',

  async render(el) {
    await H.loadMeta();
    const [meta, rows] = await Promise.all([GET('/contest-meta'), GET('/contests')]);
    const coin = (n) => `🪙 ${Number(n || 0).toLocaleString('en-US')}`;
    const when = (ms) => ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    const STATUS = {
      scheduled: '<span class="tag">排程中</span>', live: '<span class="tag ok">進行中</span>',
      ended: '<span class="tag primary">已結束</span>', cancelled: '<span class="tag">已取消</span>'
    };
    const metricLabel = (k) => (meta.metrics.find(m => m.key === k) || {}).label || k;
    const titleName = (id) => { const t = meta.titles.find(x => x.id == id); return t ? (t.emoji || '') + t.name : ''; };
    const toLocalInput = (ms) => {
      if (!ms) return '';
      const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 16);
    };

    el.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">🏆 大賽場次</h3>
          <div style="display:flex;gap:6px">
            <button class="btn small secondary" id="quick">⚡ 一鍵開「本週誰賺最多」</button>
            <button class="btn small" id="add">＋ 開一場大賽</button>
          </div>
        </div>
        <div class="hint" style="margin-top:6px">
          比的是<strong>期間內的成長量</strong>（開賽當下先記下每個人的起跑點），所以新玩家也有機會贏，
          不是每次都同一批老玩家躺著拿。玩家在 <code>/任務</code> 面板點「🏆 大賽排行榜」就看得到。
        </div>
        <div class="table-wrap" style="margin-top:10px"><table class="list">
          <thead><tr><th>名稱</th><th>比什麼</th><th>時間</th><th>獎金</th><th>冠軍成就</th><th>狀態</th><th>目前領先</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map(r => `<tr>
            <td>${UI.esc((r.emoji || '🏆') + ' ' + r.name)}${r.repeat_days ? `<div class="hint" style="font-size:12px">每 ${r.repeat_days} 天自動開下一屆</div>` : ''}</td>
            <td>${UI.esc(metricLabel(r.metric))}</td>
            <td style="white-space:nowrap;font-size:13px">${when(r.start_ts)}<br>～ ${when(r.end_ts)}</td>
            <td style="font-size:13px">🥇${coin(r.reward1)}<br>🥈${coin(r.reward2)}　🥉${coin(r.reward3)}</td>
            <td>${UI.esc(titleName(r.title_id) || '—')}</td>
            <td>${STATUS[r.status] || r.status}</td>
            <td style="font-size:13px">${(r.top || []).length
        ? r.top.slice(0, 3).map((t, i) => `${['🥇', '🥈', '🥉'][i]} ${UI.esc(t.username)} ${Number(t.score).toLocaleString('en-US')}`).join('<br>')
        : '<span class="hint">還沒有人得分</span>'}</td>
            <td>${['ended', 'cancelled'].includes(r.status) ? ''
        : `<button class="btn tiny secondary" data-edit="${r.id}">編輯</button>
                 ${r.status === 'live' ? `<button class="btn tiny secondary" data-settle="${r.id}">立刻結算</button>` : ''}
                 <button class="btn tiny danger" data-del="${r.id}">取消</button>`}</td>
          </tr>`).join('') : '<tr><td colspan="8" class="hint">還沒開過大賽。點右上角「一鍵開本週誰賺最多」就能馬上跑一場。</td></tr>'}
          </tbody></table></div>
      </div>`;

    const form = (r = {}) => `
      <div class="form-row">
        <div class="field"><label>大賽名稱</label><input name="name" value="${UI.esc(r.name || '')}" placeholder="本週賺錢王"></div>
        <div class="field" style="max-width:110px"><label>圖示</label><input name="emoji" value="${UI.esc(r.emoji || '🏆')}" style="text-align:center"></div>
      </div>
      <div class="field"><label>說明（公告會顯示）</label><input name="description" value="${UI.esc(r.description || '')}" placeholder="這週誰最會賺，冠軍拿走全部榮耀"></div>
      <div class="form-row">
        <div class="field"><label>比什麼（比期間內的成長量）</label><select name="metric">
          ${meta.metrics.map(m => `<option value="${m.key}" ${m.key === r.metric ? 'selected' : ''}>${UI.esc(m.label)}</option>`).join('')}
        </select></div>
        <div class="field"><label>至少要有多少成長才算參賽</label><input name="min_score" type="number" min="0" value="${r.min_score ?? 1}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>開始時間（留空＝馬上）</label><input name="start_at" type="datetime-local" value="${toLocalInput(r.start_ts)}"></div>
        <div class="field"><label>持續（天）</label><input name="duration_days" type="number" min="0.04" step="0.5" value="${r.end_ts && r.start_ts ? ((r.end_ts - r.start_ts) / 86400000).toFixed(2) : 7}"></div>
        <div class="field"><label>自動開下一屆（天，0＝不自動）</label><input name="repeat_days" type="number" min="0" value="${r.repeat_days ?? 7}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>🥇 冠軍獎金</label><input name="reward1" type="number" min="0" value="${r.reward1 ?? 100000}"></div>
        <div class="field"><label>🥈 亞軍</label><input name="reward2" type="number" min="0" value="${r.reward2 ?? 50000}"></div>
        <div class="field"><label>🥉 季軍</label><input name="reward3" type="number" min="0" value="${r.reward3 ?? 20000}"></div>
      </div>
      <div class="field"><label>冠軍額外拿到的成就</label><select name="title_id">
        <option value="0">— 不給 —</option>
        ${meta.titles.map(t => `<option value="${t.id}" ${t.id == r.title_id ? 'selected' : ''}>${UI.esc((t.emoji || '') + t.name)}</option>`).join('')}
      </select><div class="hint">建議去「家園與成就」開一個專屬成就（例如《本週賺錢王》），拿來當獎盃。</div></div>
      <div class="field"><label>公告頻道</label>${H.chanSelect('channel', r.channel || '')}</div>`;

    const open = (r = {}) => UI.modal({
      title: r.id ? '編輯大賽' : '開一場大賽', bodyHTML: form(r),
      onOk: async (back) => {
        const b = H.collect(back);
        if (!b.name) { UI.err('請填大賽名稱'); return false; }
        try {
          if (r.id) { const out = await PUT('/contests/' + r.id, b); if (out.locked) UI.ok('進行中的大賽：比賽項目與起跑時間維持原樣'); }
          else await POST('/contests', b);
        } catch (e) { UI.err(e.message); return false; }
        UI.ok('已儲存'); App.go('contest');
      }
    });

    el.querySelector('#add').onclick = () => open();
    el.querySelector('#quick').onclick = async () => {
      if (!await UI.confirm('馬上開一場為期 7 天的「本週賺錢王」（比累計賺得的成長量，之後每週自動開下一屆）？')) return;
      await POST('/contests', {
        name: '本週賺錢王', emoji: '💰', description: '這一週誰賺得最多？比的是這段期間新賺到的錢。',
        metric: 'total_earned', duration_days: 7, repeat_days: 7,
        reward1: 100000, reward2: 50000, reward3: 20000, min_score: 1
      });
      UI.ok('已開賽，一分鐘內會開始並公告'); App.go('contest');
    };
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => open(rows.find(x => x.id == b.dataset.edit)));
    el.querySelectorAll('[data-settle]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('立刻結算這場大賽？會馬上發獎金與冠軍成就並公告。')) return;
      await POST('/contests/' + b.dataset.settle + '/settle', {});
      UI.ok('已排入結算（一分鐘內完成）'); App.go('contest');
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!await UI.confirm('取消這場大賽？分數會一併清除，不會發獎。')) return;
      await DEL('/contests/' + b.dataset.del);
      UI.ok('已取消'); App.go('contest');
    });
  }
});
