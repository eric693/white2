// ===== 媒體庫：所有上傳的圖片與檔案 =====
App.page('media', {
  title: '媒體庫', sub: '已上傳的圖片、影片與檔案', module: 'media',
  async render(el) {
    const load = async (kind = '') => {
      const rows = await GET('/uploads' + (kind ? '?kind=' + kind : ''));
      const size = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
      el.querySelector('#grid').innerHTML = rows.length ? rows.map(u => `
        <div class="card" style="padding:10px">
          ${u.kind === 'image'
            ? `<img src="${UI.esc(u.url)}" style="width:100%;height:120px;object-fit:cover;border-radius:6px">`
            : `<div style="height:120px;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--muted);background:#f2f4f8;border-radius:6px">
                ${u.kind === 'video' ? '影片' : u.kind === 'audio' ? '音訊' : '檔案'}</div>`}
          <div style="font-size:12px;margin-top:6px;word-break:break-all">${UI.esc(u.original)}</div>
          <div class="hint">${size(u.size)}｜${UI.esc(u.uploader || '')}｜${UI.esc(u.created_at.slice(0, 16))}</div>
          <div style="display:flex;gap:4px;margin-top:6px">
            <button class="btn tiny secondary" data-copy="${UI.esc(u.url)}">複製網址</button>
            <button class="btn tiny danger" data-del="${u.id}">刪除</button>
          </div>
        </div>`).join('') : '<div class="card empty">尚無檔案。到各功能的圖片欄位按「上傳」即可。</div>';

      el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
        navigator.clipboard.writeText(location.origin + b.dataset.copy)
          .then(() => UI.ok('已複製網址')).catch(() => UI.err('複製失敗'));
      });
      el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!await UI.confirm('刪除此檔案？已使用到它的功能會失去圖片。')) return;
        await DEL('/uploads/' + b.dataset.del); UI.ok('已刪除'); load(el.querySelector('#kind').value);
      });
    };

    el.innerHTML = `
      <div class="toolbar">
        <label class="btn">上傳檔案<input type="file" id="up" multiple style="display:none"></label>
        <div class="spacer"></div>
        <select id="kind" style="max-width:150px">
          <option value="">全部類型</option><option value="image">圖片</option>
          <option value="video">影片</option><option value="audio">音訊</option><option value="file">文件</option>
        </select>
      </div>
      <div class="hint" style="margin-bottom:10px">單檔上限 25MB。上傳後的網址可直接貼到任何圖片欄位使用。</div>
      <div id="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px"></div>`;

    el.querySelector('#up').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        try {
          const fd = new FormData(); fd.append('file', f);
          await api('/upload', { method: 'POST', body: fd });
          UI.ok('已上傳：' + f.name);
        } catch (err) { UI.err(f.name + '：' + err.message); }
      }
      e.target.value = '';
      load(el.querySelector('#kind').value);
    };
    el.querySelector('#kind').onchange = (e) => load(e.target.value);
    await load();
  }
});
