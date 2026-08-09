// UI 共用工具：跳出提示、彈窗、HTML 跳脫
const UI = {
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  toast(msg, type = '') {
    const box = document.getElementById('toast');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },
  ok(msg) { UI.toast(msg, 'ok'); },
  err(msg) { UI.toast(msg, 'err'); },

  // 開啟彈窗。fields 由呼叫端組 HTML；回傳 { close }
  modal({ title, bodyHTML, okText = '儲存', onOk, okClass = 'btn' }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <div class="modal-head">${UI.esc(title)}</div>
        <div class="modal-body">${bodyHTML}</div>
        <div class="modal-foot">
          <button class="btn secondary" data-cancel>取消</button>
          <button class="${okClass}" data-ok>${UI.esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('[data-cancel]').onclick = close;
    back.onclick = e => { if (e.target === back) close(); };
    const okBtn = back.querySelector('[data-ok]');
    okBtn.onclick = async () => {
      if (!onOk) return close();
      okBtn.disabled = true;
      try { const r = await onOk(back); if (r !== false) close(); }
      catch (e) { UI.err(e.message); }
      finally { okBtn.disabled = false; }
    };
    return { back, close };
  },

  async confirm(msg, okText = '確定', okClass = 'btn danger') {
    return new Promise(resolve => {
      UI.modal({
        title: '請確認', bodyHTML: `<div>${UI.esc(msg)}</div>`, okText, okClass,
        onOk: () => { resolve(true); }
      }).back.querySelector('[data-cancel]').addEventListener('click', () => resolve(false));
    });
  },

  val(back, name) {
    const el = back.querySelector(`[name="${name}"]`);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked ? 1 : 0;
    return el.value;
  }
};
