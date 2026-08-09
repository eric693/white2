// 共用小工具：Discord 頻道/身分組下拉、開關、表單值
const H = {
  channels: null,
  roles: null,
  forums: null,
  emojis: null,
  stickers: null,
  _metaAt: 0,

  // 頻道/身分組/論壇/自訂表情：快取 30 秒，過期自動重抓（新增的最多 30 秒就會出現，不必手動重整）
  async loadMeta(force) {
    if (!force && H.channels && H.roles && H.forums && H.emojis && H.stickers && (Date.now() - H._metaAt < 30000)) return;
    [H.channels, H.roles, H.forums, H.emojis, H.stickers] = await Promise.all([
      GET('/discord/channels').catch(() => H.channels || []),
      GET('/discord/roles').catch(() => H.roles || []),
      GET('/discord/forums').catch(() => H.forums || []),
      GET('/discord/guild-emojis').catch(() => H.emojis || []),
      GET('/discord/guild-stickers').catch(() => H.stickers || [])
    ]);
    H._metaAt = Date.now();
  },

  // 頻道下拉 <select>：文字頻道 + 論壇頻道（論壇會自動開一篇貼文）
  chanSelect(name, selected, { allowEmpty = true } = {}) {
    const textOpts = (H.channels || []).map(c =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}># ${UI.esc(c.name)}</option>`).join('');
    const forums = (H.forums || []);
    const forumOpts = forums.map(c =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>📋 ${UI.esc(c.name)}</option>`).join('');
    const opts = (allowEmpty ? '<option value="">— 請選擇頻道 —</option>' : '')
      + textOpts
      + (forums.length ? `<optgroup label="論壇頻道（會自動開一篇貼文）">${forumOpts}</optgroup>` : '');
    return `<select name="${name}">${opts}</select>`;
  },

  // 身分組下拉
  roleSelect(name, selected, { allowEmpty = true, emptyLabel = '— 不指定 —' } = {}) {
    const opts = (allowEmpty ? `<option value="">${emptyLabel}</option>` : '')
      + (H.roles || []).map(r =>
        `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>@ ${UI.esc(r.name)}</option>`).join('');
    return `<select name="${name}">${opts}</select>`;
  },

  chanName(id) {
    const c = (H.channels || []).find(x => x.id === id);
    if (c) return '# ' + c.name;
    const f = (H.forums || []).find(x => x.id === id);
    return f ? '📋 ' + f.name : (id || '—');
  },
  roleName(id) { const r = (H.roles || []).find(x => x.id === id); return r ? '@ ' + r.name : (id || '—'); },

  // 開關（checkbox）
  toggle(name, checked, label) {
    return `<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${UI.esc(label)}</label>`;
  },

  // 從容器讀取所有具 name 的表單欄位為物件
  collect(root) {
    const out = {};
    root.querySelectorAll('[name]').forEach(el => {
      if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
      else out[el.name] = el.value;
    });
    return out;
  },

  enabledTag(v) { return v ? '<span class="tag ok">啟用</span>' : '<span class="tag">停用</span>'; },

  // ---- 提及插入器：可搜尋，把 <#頻道> / <@&身分組> 插進指定文字框。opts.noUser 隱藏「@新成員」（公告用）----
  mentionPicker(targetName, opts = {}) {
    const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const chans = [
      ...(H.channels || []).map(c => ({ code: `<#${c.id}>`, label: '# ' + c.name })),
      ...(H.forums || []).map(c => ({ code: `<#${c.id}>`, label: '# ' + c.name + '（論壇）' }))
    ];
    const roles = (H.roles || []).map(r => ({ code: `<@&${r.id}>`, label: '@ ' + r.name }));
    const emojis = (H.emojis || []).map(e => ({ code: e.code, label: e.name, img: e.url }));
    const combo = (ph, items) => `
      <div data-mcombo style="position:relative;flex:1;min-width:160px">
        <input data-mcombo-input type="text" placeholder="${ph}" autocomplete="off" style="width:100%;box-sizing:border-box">
        <div data-mcombo-list style="display:none;position:absolute;z-index:30;left:0;right:0;top:100%;max-height:230px;overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.18);margin-top:2px">
          ${items.map(it => `<div data-mcombo-item data-code="${escAttr(it.code)}" style="padding:8px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;display:flex;align-items:center;gap:8px">${it.img ? `<img src="${it.img}" loading="lazy" style="width:22px;height:22px;object-fit:contain;flex:none">` : ''}<span style="overflow:hidden;text-overflow:ellipsis">${UI.esc(it.label)}</span></div>`).join('') || '<div style="padding:8px 10px;color:var(--muted)">（無）</div>'}
        </div>
      </div>`;
    return `<div data-mention="${targetName}">
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:flex-start">
        ${opts.emojiOnly ? '' : combo('搜尋頻道插入…', chans)}
        ${opts.emojiOnly ? '' : combo('搜尋身分組插入…', roles)}
        ${emojis.length ? combo('搜尋自訂表情插入…', emojis) : ''}
        <button type="button" class="btn tiny secondary" data-emgrid>😀 選表情符號</button>
        ${(opts.emojiOnly || opts.noUser) ? '' : '<button type="button" class="btn tiny secondary" data-muser>插入 @新成員</button>'}
      </div>
      <div data-emgrid-box style="display:none;margin-top:6px">
        <input data-emgrid-search type="text" placeholder="搜尋表情…（可打中文或英文）" autocomplete="off" style="width:100%;box-sizing:border-box;margin-bottom:6px">
        <div class="emoji-panel">
          ${emojis.length ? `<div class="emoji-panel-title">伺服器表情（${emojis.length}）</div>
          <div class="emoji-panel-grid">${emojis.map(e =>
            `<span data-em data-code="${escAttr(e.code)}" data-key="${escAttr(e.label)}" title="${UI.esc(e.label)}"><img src="${e.img}" loading="lazy" alt=":${UI.esc(e.label)}:"></span>`).join('')}</div>` : ''}
          <div class="emoji-panel-title">一般表情</div>
          <div class="emoji-panel-grid">${H.EMOJI_SET.map(e =>
            `<span data-em data-code="${escAttr(e)}" data-key="${escAttr(H.EMOJI_KW[e] || '')}">${e}</span>`).join('')}</div>
          <div class="emoji-panel-empty" style="display:none">找不到符合的表情</div>
        </div>
      </div>
    </div>`;
  },
  // 各種訊息欄位的插入器：表情＋頻道＋身分組都能插，並附即時預覽。
  // （早期只有表情，所以叫 emojiInsert；名字保留，避免各頁面全部要改。）
  emojiInsert(targetName) { return H.mentionPicker(targetName, { noUser: true }); },

  // 玩家搜尋選擇器：打暱稱/名稱 → 搜尋伺服器成員 → 點選帶入 ID。
  // 單選模式（預設）：填入 idField/nameField。多選模式（opts.multi）：把 ID 追加到 idField（逗號分隔）。
  memberPicker(idField = 'user_id', nameField = 'username', opts = {}) {
    const label = opts.label || (opts.multi ? '搜尋玩家加入名單（暱稱或名稱）' : '搜尋玩家（暱稱或名稱）');
    const hint = opts.multi ? '選了會加進下方名單；可連續加多位。' : '找不到人？也可以直接在下方填 Discord 使用者 ID。';
    return `<div class="field"><label>${label}</label>
      <div data-memberpick data-idfield="${idField}" data-namefield="${nameField}" data-multi="${opts.multi ? '1' : ''}" style="position:relative">
        <input data-mp-search type="text" placeholder="打暱稱／名稱搜尋，點選帶入" autocomplete="off" style="width:100%;box-sizing:border-box">
        <div data-mp-list style="display:none;position:absolute;z-index:30;left:0;right:0;top:100%;max-height:240px;overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.18);margin-top:2px"></div>
      </div>
      <div class="hint">${hint}</div></div>`;
  },
  bindMemberPickers(root) {
    root.querySelectorAll('[data-memberpick]').forEach(box => {
      if (box.dataset.bound) return; box.dataset.bound = '1';
      const input = box.querySelector('[data-mp-search]');
      const list = box.querySelector('[data-mp-list]');
      const idEl = root.querySelector(`[name="${box.dataset.idfield}"]`);
      const nameEl = root.querySelector(`[name="${box.dataset.namefield}"]`);
      const multi = box.dataset.multi === '1';
      let timer;
      const pick = (id, name) => {
        if (!idEl) return;
        if (multi) {
          const cur = idEl.value.split(',').map(s => s.trim()).filter(Boolean);
          if (!cur.includes(id)) { cur.push(id); idEl.value = cur.join(','); UI.ok('已加入 ' + name); }
          input.value = '';   // 清空以便繼續加下一位
        } else {
          idEl.value = id;
          if (nameEl && !nameEl.value.trim()) nameEl.value = name;
          input.value = name;
        }
        list.style.display = 'none';
      };
      const render = (members) => {
        list.innerHTML = members.length
          ? members.map(m => `<div data-mp-item data-id="${m.id}" data-name="${UI.esc(m.name)}" style="padding:8px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.esc(m.name)} <span style="color:var(--muted);font-size:12px">${UI.esc(m.tag || '')}</span></div>`).join('')
          : '<div style="padding:8px 10px;color:var(--muted)">找不到，換個關鍵字試試</div>';
        list.style.display = 'block';
        list.querySelectorAll('[data-mp-item]').forEach(it => it.addEventListener('mousedown', (e) => {
          e.preventDefault(); pick(it.dataset.id, it.dataset.name);
        }));
      };
      input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { list.style.display = 'none'; return; }
        timer = setTimeout(async () => {
          try { render(await GET('/discord/members?q=' + encodeURIComponent(q))); }
          catch { list.style.display = 'none'; }
        }, 250);
      });
      input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 180));
    });
  },

  // 把一段訊息文字畫成看得懂的樣子：自訂表情變成圖、頻道/身分組標記變成名字。
  // textarea 只能放純文字，沒辦法直接顯示圖，所以用這個做「即時預覽」。
  renderDiscordText(text) {
    return UI.esc(String(text || ''))
      .replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, anim, name, id) =>
        `<img src="https://cdn.discordapp.com/emojis/${id}.${anim ? 'gif' : 'png'}?size=48" title="${UI.esc(name)}" style="width:1.35em;height:1.35em;object-fit:contain;vertical-align:-0.25em">`)
      .replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="dc-chip">${UI.esc(H.chanName(id))}</span>`)
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="dc-chip">${UI.esc(H.roleName(id))}</span>`)
      .replace(/@(everyone|here)\b/g, '<span class="dc-chip">@$1</span>')
      .replace(/\n/g, '<br>');
  },

  // ---- 所見即所得編輯器 ----
  // textarea 只能放純文字，所以改用 contenteditable：自訂表情直接顯示成圖，
  // 頻道/身分組顯示成名字。真正要送出的原始碼（<:name:id>）同步寫回原本的 textarea，
  // 所以後端和各頁面的存檔邏輯都不用改。

  // 原始碼 → 編輯器裡看得到的 HTML
  dcTextToHTML(text) {
    return UI.esc(String(text || ''))
      .replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, anim, name, id) =>
        `<img class="dc-em" contenteditable="false" draggable="false" src="https://cdn.discordapp.com/emojis/${id}.${anim ? 'gif' : 'png'}?size=48" alt=":${name}:" title=":${name}:" data-code="&lt;${anim}:${name}:${id}&gt;">`)
      .replace(/&lt;#(\d+)&gt;/g, (_, id) =>
        `<span class="dc-chip" contenteditable="false" data-code="&lt;#${id}&gt;">${UI.esc(H.chanName(id))}</span>`)
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) =>
        `<span class="dc-chip" contenteditable="false" data-code="&lt;@&amp;${id}&gt;">${UI.esc(H.roleName(id))}</span>`)
      .replace(/\n/g, '<br>');
  },

  // 編輯器裡的 DOM → 要送出的原始碼
  dcNodesToText(node) {
    let out = '';
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (n.dataset && n.dataset.code) { out += n.dataset.code; return; }
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'IMG') { out += n.getAttribute('alt') || ''; return; }
      // 瀏覽器按 Enter 常會包一層 DIV/P，這些要還原成換行
      const block = tag === 'DIV' || tag === 'P';
      if (block && out && !out.endsWith('\n')) out += '\n';
      out += H.dcNodesToText(n);
      if (block && !out.endsWith('\n')) out += '\n';
    });
    return out;
  },

  // 把一個 textarea/input 換成所見即所得編輯器（失敗就原樣保留純文字框）
  attachRichEditor(target) {
    if (!target || target._rich) return null;
    const single = target.tagName === 'INPUT';
    let ed;
    try {
      ed = document.createElement('div');
      ed.className = 'rich-editor' + (single ? ' single' : '');
      ed.contentEditable = 'true';
      ed.spellcheck = false;
      ed.dataset.ph = target.placeholder || '';
      ed.innerHTML = H.dcTextToHTML(target.value);
      target.style.display = 'none';
      target.insertAdjacentElement('afterend', ed);
    } catch (e) { target.style.display = ''; return null; }

    const syncOut = () => { target.value = H.dcNodesToText(ed).replace(/\n$/, ''); };
    ed.addEventListener('input', syncOut);
    ed.addEventListener('blur', syncOut);
    if (single) ed.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    // 貼上一律當純文字，避免把整段網頁的樣式帶進來
    ed.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, single ? t.replace(/\n/g, ' ') : t);
    });

    target._rich = ed;
    // 供外部（例如套用模板後）程式改了 target.value 時，重畫編輯器
    target._refreshRich = () => { ed.innerHTML = H.dcTextToHTML(target.value); };
    // 在游標處插入一段原始碼（表情／頻道／身分組）
    target._insertCode = (code) => {
      ed.focus();
      const sel = window.getSelection();
      let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !ed.contains(range.commonAncestorContainer)) {
        range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
      }
      range.deleteContents();
      const frag = document.createRange().createContextualFragment(H.dcTextToHTML(code));
      const last = frag.lastChild;
      range.insertNode(frag);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last); after.collapse(true);
        sel.removeAllRanges(); sel.addRange(after);
      }
      syncOut();
    };
    H.attachAutocomplete(ed, syncOut);
    return ed;
  },

  // ---- 行內自動完成：像 Discord 一樣打 # 找頻道、@ 找身分組、: 找自訂表情 ----
  // 後台以前只能用內容欄下方的搜尋框插入，很多人不知道，就直接手打「#重要公告」，
  // 送出去只會是純文字、點不動。這裡讓打字當下就能選，選完寫入真正的代碼。
  attachAutocomplete(ed, syncOut) {
    const pop = document.createElement('div');
    pop.className = 'dc-ac';
    pop.style.display = 'none';
    document.body.appendChild(pop);

    let items = [], active = 0, token = null;

    const close = () => { pop.style.display = 'none'; token = null; };

    const sourceFor = (trigger) => {
      if (trigger === '#') return [
        ...(H.channels || []).map(c => ({ code: `<#${c.id}>`, label: '# ' + c.name })),
        ...(H.forums || []).map(c => ({ code: `<#${c.id}>`, label: '# ' + c.name + '（論壇）' }))
      ];
      if (trigger === '@') return (H.roles || []).map(r => ({ code: `<@&${r.id}>`, label: '@ ' + r.name }));
      return (H.emojis || []).map(e => ({ code: e.code, label: e.name, img: e.url }));
    };

    // 找出游標前面正在打的 #xxx / @xxx / :xxx（前面必須是行首或空白，避免網址、時間被誤判）
    const readToken = () => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!r.collapsed || r.startContainer.nodeType !== 3 || !ed.contains(r.startContainer)) return null;
      const before = r.startContainer.nodeValue.slice(0, r.startOffset);
      const m = before.match(/(?:^|\s)([#@:])([^\s#@:]{0,30})$/);
      if (!m) return null;
      return { node: r.startContainer, start: r.startOffset - m[1].length - m[2].length, end: r.startOffset, trigger: m[1], q: m[2] };
    };

    const render = () => {
      pop.innerHTML = items.map((it, i) =>
        `<div data-ac-item data-i="${i}" class="${i === active ? 'on' : ''}">${it.img
          ? `<img src="${it.img}" loading="lazy">` : ''}<span>${UI.esc(it.label)}</span></div>`).join('');
      const sel = window.getSelection();
      const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const top = (rect && rect.height ? rect.bottom : ed.getBoundingClientRect().bottom) + window.scrollY + 4;
      const left = (rect && rect.width !== undefined ? rect.left : ed.getBoundingClientRect().left) + window.scrollX;
      pop.style.top = top + 'px';
      pop.style.left = Math.max(8, Math.min(left, window.innerWidth - 260)) + 'px';
      pop.style.display = 'block';
    };

    const pick = (i) => {
      const it = items[i];
      if (!it || !token) return;
      const range = document.createRange();
      range.setStart(token.node, token.start);
      range.setEnd(token.node, token.end);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      close();
      // 插入代碼，順便把打了一半的 #xxx 換掉
      const frag = document.createRange().createContextualFragment(H.dcTextToHTML(it.code) + '&nbsp;');
      const last = frag.lastChild;
      range.deleteContents();
      range.insertNode(frag);
      if (last) { const a = document.createRange(); a.setStartAfter(last); a.collapse(true); sel.removeAllRanges(); sel.addRange(a); }
      syncOut();
    };

    const update = () => {
      // 編輯視窗關掉後把浮層一起收掉，不然每開一次表單就留一個空 div 在 body
      if (!ed.isConnected) { pop.remove(); return; }
      token = readToken();
      if (!token) return close();
      const q = token.q.toLowerCase();
      items = sourceFor(token.trigger)
        .filter(it => it.label.toLowerCase().includes(q)).slice(0, 12);
      if (!items.length) return close();
      active = 0;
      render();
    };

    ed.addEventListener('input', update);
    ed.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update(); });
    ed.addEventListener('blur', () => setTimeout(close, 180));
    ed.addEventListener('keydown', e => {
      if (pop.style.display === 'none') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { close(); }
    });
    pop.addEventListener('mousedown', e => {
      const it = e.target.closest('[data-ac-item]');
      if (!it) return;
      e.preventDefault();
      pick(parseInt(it.dataset.i, 10));
    });
  },

  // 讓外部在程式改過欄位值之後（例如套用模板）重畫所有編輯器
  refreshEditors(root) {
    (root || document).querySelectorAll('[name]').forEach(t => { if (t._refreshRich) t._refreshRich(); });
  },

  bindMentions(root) {
    root.querySelectorAll('[data-mention]').forEach(box => {
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      const target = root.querySelector(`[name="${box.dataset.mention}"]`);
      if (!target) return;
      H.attachRichEditor(target);
      const insert = (text) => {
        // 所見即所得編輯器：直接把表情插在游標處（會顯示成圖）
        if (target._insertCode) return target._insertCode(text);
        const p = target.selectionStart ?? target.value.length;
        target.value = target.value.slice(0, p) + text + target.value.slice(p);
        target.focus();
        target.selectionStart = target.selectionEnd = p + text.length;
      };
      box.querySelectorAll('[data-mcombo]').forEach(combo => {
        const input = combo.querySelector('[data-mcombo-input]');
        const list = combo.querySelector('[data-mcombo-list]');
        const items = [...combo.querySelectorAll('[data-mcombo-item]')];
        const filter = (q) => {
          q = q.trim().toLowerCase();
          items.forEach(it => { it.style.display = it.textContent.toLowerCase().includes(q) ? '' : 'none'; });
        };
        input.addEventListener('focus', () => { list.style.display = 'block'; filter(input.value); });
        input.addEventListener('input', () => { list.style.display = 'block'; filter(input.value); });
        input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 160));
        items.forEach(it => it.addEventListener('mousedown', (e) => {
          e.preventDefault();
          insert(it.dataset.code);
          input.value = ''; list.style.display = 'none';
        }));
      });
      // 表情符號面板：展開後點圖直接插到游標處（伺服器自訂表情插代碼、一般表情插字元）
      const gbtn = box.querySelector('[data-emgrid]');
      const gbox = box.querySelector('[data-emgrid-box]');
      if (gbtn && gbox) {
        const search = gbox.querySelector('[data-emgrid-search]');
        const cells = [...gbox.querySelectorAll('[data-em]')];
        const empty = gbox.querySelector('.emoji-panel-empty');
        gbtn.onclick = () => {
          const open = gbox.style.display === 'none';
          gbox.style.display = open ? 'block' : 'none';
          gbtn.textContent = open ? '收起表情符號' : '😀 選表情符號';
          if (open) search.focus();
        };
        cells.forEach(c => c.addEventListener('mousedown', (e) => {
          e.preventDefault();
          insert(c.dataset.code);
        }));
        search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          let hit = 0;
          cells.forEach(c => {
            const ok = !q || (c.dataset.key || '').toLowerCase().includes(q)
              || (c.title || '').toLowerCase().includes(q) || c.dataset.code.toLowerCase().includes(q);
            c.style.display = ok ? '' : 'none';
            if (ok) hit++;
          });
          empty.style.display = hit ? 'none' : 'block';
        });
      }
      const ub = box.querySelector('[data-muser]');
      if (ub) ub.onclick = () => insert('{user}');
    });
  },


  // ---- 伺服器貼圖（sticker）選擇器 ----
  // 貼圖跟自訂表情不同：它不是寫進文字裡的代碼，而是送出時另外帶的欄位，
  // 所以這裡用「點圖切換選取」，值存成 JSON 的 id 陣列。Discord 一則訊息最多 3 張。
  MAX_STICKERS: 3,
  stickerField(name, json) {
    let ids = [];
    try { ids = JSON.parse(json || '[]'); } catch {}
    if (!Array.isArray(ids)) ids = [];
    const list = H.stickers || [];
    if (!list.length) {
      return `<input type="hidden" name="${name}" value="[]">
        <div class="hint">這個伺服器沒有貼圖，或機器人還沒讀到貼圖清單。</div>`;
    }
    return `<div data-stickerpick="${name}">
      <input type="hidden" name="${name}" value='${UI.esc(JSON.stringify(ids))}'>
      <input data-sk-search type="text" placeholder="搜尋貼圖…" autocomplete="off" style="width:100%;box-sizing:border-box;margin-bottom:6px">
      <div class="sticker-grid">
        ${list.map(s => `<div data-sk-item data-id="${s.id}" class="${ids.includes(s.id) ? 'on' : ''}" title="${UI.esc(s.name)}">
            <img src="${s.url}" loading="lazy" alt="${UI.esc(s.name)}"><span>${UI.esc(s.name)}</span></div>`).join('')}
      </div>
      <div class="hint" data-sk-hint></div>
    </div>`;
  },
  stickerValue(root, name) {
    const el = root.querySelector(`[data-stickerpick="${name}"] input[type=hidden]`)
      || root.querySelector(`[name="${name}"]`);
    return el ? el.value : '[]';
  },
  bindStickerPickers(root) {
    root.querySelectorAll('[data-stickerpick]').forEach(box => {
      if (box.dataset.bound) return; box.dataset.bound = '1';
      const hidden = box.querySelector('input[type=hidden]');
      const hint = box.querySelector('[data-sk-hint]');
      const search = box.querySelector('[data-sk-search]');
      const items = [...box.querySelectorAll('[data-sk-item]')];
      const read = () => { try { return JSON.parse(hidden.value || '[]'); } catch { return []; } };
      const paint = () => {
        const ids = read();
        items.forEach(it => it.classList.toggle('on', ids.includes(it.dataset.id)));
        hint.textContent = `已選 ${ids.length} / ${H.MAX_STICKERS} 張（Discord 一則訊息最多 3 張）`;
      };
      items.forEach(it => it.addEventListener('click', () => {
        const ids = read();
        const i = ids.indexOf(it.dataset.id);
        if (i >= 0) ids.splice(i, 1);
        else if (ids.length >= H.MAX_STICKERS) return UI.err(`最多只能選 ${H.MAX_STICKERS} 張貼圖`);
        else ids.push(it.dataset.id);
        hidden.value = JSON.stringify(ids);
        paint();
      }));
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        items.forEach(it => { it.style.display = it.title.toLowerCase().includes(q) ? '' : 'none'; });
      });
      paint();
    });
  },

  // ---- 多圖上傳（回傳 JSON 陣列字串）----
  multiUploadField(name, json) {
    let list = [];
    try { list = JSON.parse(json || '[]'); } catch {}
    if (!Array.isArray(list)) list = [];
    return `<div data-multiup="${name}">
      <div data-mulist style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        ${list.map((u, i) => H.muThumb(u, i)).join('')}
      </div>
      <label class="btn small secondary" style="margin:0">＋ 上傳圖片
        <input type="file" accept="image/*" multiple style="display:none" data-muinput></label>
      <div class="hint">可上傳多張，最多 4 張會組成圖庫顯示。</div>
    </div>`;
  },
  muThumb(url, i) {
    return `<div data-muitem data-url="${UI.esc(url)}" style="position:relative">
      <img src="${UI.esc(url)}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">
      <button type="button" data-murm style="position:absolute;top:-6px;right:-6px;background:#ed4245;color:#fff;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer">×</button>
    </div>`;
  },
  bindMultiUploads(root) {
    root.querySelectorAll('[data-multiup]').forEach(box => {
      if (box.dataset.bound) return; box.dataset.bound = '1';
      const list = box.querySelector('[data-mulist]');
      const input = box.querySelector('[data-muinput]');
      input.onchange = async () => {
        for (const f of Array.from(input.files || [])) {
          if (f.size > 25 * 1024 * 1024) { UI.err(f.name + ' 超過 25MB'); continue; }
          try {
            const fd = new FormData(); fd.append('file', f);
            const r = await api('/upload', { method: 'POST', body: fd });
            const d = document.createElement('div'); d.innerHTML = H.muThumb(r.url, 0);
            list.appendChild(d.firstElementChild);
          } catch (e) { UI.err(e.message); }
        }
        input.value = '';
      };
      box.addEventListener('click', e => { if (e.target.matches('[data-murm]')) e.target.closest('[data-muitem]').remove(); });
    });
  },
  multiUploadValue(root, name) {
    const box = root.querySelector(`[data-multiup="${name}"]`);
    if (!box) return '[]';
    return JSON.stringify(Array.from(box.querySelectorAll('[data-muitem]')).map(x => x.dataset.url));
  },

  // ---- Discord 風格表情選擇器（點欄位就跳出來選，不用複製貼上）----
  // 常用 emoji 的中英關鍵字，讓搜尋框打「愛心 / heart / 火」都找得到
  EMOJI_KW: {
    '😀':'笑 smile happy','😁':'笑 grin','😂':'笑哭 lol joy','🤣':'爆笑 rofl','😊':'微笑 blush',
    '😍':'愛 love heart eyes','🥰':'愛 love','😎':'酷 cool','🤔':'思考 think','😴':'睡 sleep',
    '😭':'哭 cry','😡':'生氣 angry','👍':'讚 good like','👎':'倒讚 bad','👏':'拍手 clap',
    '🙏':'拜託 感謝 pray thanks','💪':'加油 muscle','🔥':'火 熱門 fire hot','⭐':'星 star','🌟':'星 star',
    '✨':'閃 亮 sparkle','💯':'滿分 100','✅':'打勾 完成 check ok','❌':'叉 錯誤 cross no','⚠️':'警告 warning',
    '🎉':'慶祝 party tada','🎊':'慶祝 party','🎁':'禮物 抽獎 gift','🎈':'氣球 balloon','🏆':'獎盃 冠軍 trophy',
    '🥇':'金牌 第一 gold','🎮':'遊戲 game','🎵':'音樂 music','🎶':'音樂 music','💬':'聊天 訊息 chat',
    '📢':'公告 廣播 announce','📣':'公告 announce','📌':'釘選 pin','📍':'位置 pin','🔔':'通知 鈴 bell',
    '🔗':'連結 link','💰':'錢 金幣 money','💎':'鑽石 寶石 gem','❤️':'愛心 紅 heart','🧡':'愛心 橘 heart',
    '💛':'愛心 黃 heart','💚':'愛心 綠 heart','💙':'愛心 藍 heart','💜':'愛心 紫 heart','🤍':'愛心 白 heart',
    '🖤':'愛心 黑 heart','💔':'心碎 broken','🌈':'彩虹 rainbow','☀️':'太陽 sun','🌙':'月亮 moon',
    '⚡':'閃電 電 zap','💧':'水滴 water','🍀':'幸運 四葉 clover','🌸':'櫻花 花 flower','🐰':'兔 rabbit',
    '🐱':'貓 cat','🐶':'狗 dog','🦊':'狐狸 fox','🐼':'貓熊 panda','👑':'皇冠 王 crown',
    '🎀':'蝴蝶結 緞帶 ribbon','💫':'星 暈 dizzy'
  },

  // 目前開啟的面板與對應的輸入框
  _pop: null, _popInput: null,

  // 把輸入框的值畫成看得懂的樣子：自訂表情顯示成圖，一般 emoji 就顯示字元本身
  paintEmojiInput(inp) {
    if (!inp) return;
    inp.classList.add('emoji-input');
    const m = String(inp.value || '').match(/^<(a?):\w+:(\d+)>$/);
    if (m) {
      inp.style.backgroundImage = `url(https://cdn.discordapp.com/emojis/${m[2]}.${m[1] ? 'gif' : 'png'}?size=48)`;
      inp.classList.add('has-img');
      inp.title = inp.value;
    } else {
      inp.style.backgroundImage = '';
      inp.classList.remove('has-img');
      inp.title = '';
    }
  },
  paintEmojiInputs(root) {
    (root || document).querySelectorAll('[data-bemoji],[data-rremoji]').forEach(H.paintEmojiInput);
  },

  closeEmojiPicker() {
    if (H._pop) { H._pop.remove(); H._pop = null; H._popInput = null; }
  },

  openEmojiPicker(inp) {
    if (H._pop && H._popInput === inp) return H.closeEmojiPicker();
    H.closeEmojiPicker();
    H._popInput = inp;

    const customs = H.emojis || [];
    const pop = document.createElement('div');
    pop.className = 'emoji-pop';
    pop.innerHTML = `
      <div class="emoji-pop-head"><input type="text" placeholder="搜尋表情…（可打中文或英文）" autocomplete="off"></div>
      <div class="emoji-pop-body">
        ${customs.length ? `<div class="emoji-pop-title" data-sec="custom">伺服器表情（${customs.length}）</div>
        <div class="emoji-grid" data-grid="custom">${customs.map(e =>
          `<button type="button" data-val="${UI.esc(e.code)}" data-kw="${UI.esc(e.name.toLowerCase())}" title="${UI.esc(e.name)}"><img src="${e.url}" loading="lazy" alt=""></button>`).join('')}</div>` : ''}
        <div class="emoji-pop-title" data-sec="uni">一般表情</div>
        <div class="emoji-grid" data-grid="uni">${H.EMOJI_SET.map(e =>
          `<button type="button" data-val="${e}" data-kw="${UI.esc((H.EMOJI_KW[e] || '').toLowerCase())}">${e}</button>`).join('')}</div>
        <div class="emoji-pop-empty" style="display:none">找不到符合的表情</div>
      </div>
      <div class="emoji-pop-foot"><span>點一下即可選用</span>
        <button type="button" class="btn tiny secondary" data-clear>清除</button></div>`;
    document.body.appendChild(pop);
    H._pop = pop;

    // 位置：貼在欄位下方，空間不夠就翻到上方，並夾在畫面內
    const r = inp.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.top = top + 'px';
    pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - w - 8)) + 'px';

    const pick = (val) => {
      inp.value = val;
      H.paintEmojiInput(inp);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      H.closeEmojiPicker();
    };
    pop.addEventListener('mousedown', e => e.preventDefault());   // 不要讓欄位失焦
    pop.addEventListener('click', e => {
      if (e.target.closest('[data-clear]')) return pick('');
      const b = e.target.closest('button[data-val]');
      if (b) pick(b.dataset.val);
    });

    // 搜尋：自訂表情比對名稱，一般表情比對中英關鍵字
    const search = pop.querySelector('.emoji-pop-head input');
    const empty = pop.querySelector('.emoji-pop-empty');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      pop.querySelectorAll('button[data-val]').forEach(b => {
        const hit = !q || (b.dataset.kw || '').includes(q) || (b.dataset.val || '').includes(q);
        b.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      pop.querySelectorAll('[data-grid]').forEach(g => {
        const any = [...g.children].some(c => c.style.display !== 'none');
        g.style.display = any ? '' : 'none';
        const t = pop.querySelector(`[data-sec="${g.dataset.grid}"]`);
        if (t) t.style.display = any ? '' : 'none';
      });
      empty.style.display = shown ? 'none' : '';
    });
    search.focus();
  },

  // 只掛一次：點到表情欄位就跳出選擇器；點別處或按 Esc 關閉
  initEmojiInputs() {
    if (H._emojiInit) return; H._emojiInit = true;
    document.addEventListener('click', e => {
      const inp = e.target.closest('[data-bemoji],[data-rremoji]');
      if (inp) { H.openEmojiPicker(inp); return; }
      if (!e.target.closest('.emoji-pop')) H.closeEmojiPicker();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') H.closeEmojiPicker(); });
    document.addEventListener('input', e => {
      if (e.target.matches && e.target.matches('[data-bemoji],[data-rremoji]')) H.paintEmojiInput(e.target);
    });
    addEventListener('resize', H.closeEmojiPicker);
  },

  // ---- emoji 快選面板（點擊填入指定 input）----
  EMOJI_SET: '😀 😁 😂 🤣 😊 😍 🥰 😎 🤔 😴 😭 😡 👍 👎 👏 🙏 💪 🔥 ⭐ 🌟 ✨ 💯 ✅ ❌ ⚠️ 🎉 🎊 🎁 🎈 🏆 🥇 🎮 🎵 🎶 💬 📢 📣 📌 📍 🔔 🔗 💰 💎 ❤️ 🧡 💛 💚 💙 💜 🤍 🖤 💔 🌈 ☀️ 🌙 ⚡ 💧 🍀 🌸 🐰 🐱 🐶 🦊 🐼 👑 🎀 💫'.split(' '),
  emojiPicker(targetSel) {
    const id = 'ep' + Math.random().toString(36).slice(2, 7);
    const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const customs = H.emojis || [];
    return `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">選擇表情符號${customs.length ? '（含自訂）' : ''}</summary>
      <div data-emojipick="${id}" data-target="${targetSel}">
        <div style="display:flex;flex-wrap:wrap;gap:2px;max-height:110px;overflow:auto;margin-top:4px">
          ${H.EMOJI_SET.map(e => `<span data-emo data-val="${e}" style="cursor:pointer;font-size:22px;padding:2px">${e}</span>`).join('')}
        </div>
        ${customs.length ? `<input data-emo-search type="text" placeholder="搜尋自訂表情…" autocomplete="off" style="width:100%;box-sizing:border-box;margin-top:6px">
          <div style="display:flex;flex-wrap:wrap;gap:3px;max-height:140px;overflow:auto;margin-top:4px">
            ${customs.map(e => `<img data-emo data-val="${escAttr(e.code)}" data-name="${UI.esc(e.name)}" src="${e.url}" loading="lazy" title="${UI.esc(e.name)}" style="width:26px;height:26px;object-fit:contain;cursor:pointer;padding:2px;border-radius:4px">`).join('')}
          </div>` : ''}
      </div></details>`;
  },
  bindEmojiPickers(root) {
    root.querySelectorAll('[data-emojipick]').forEach(box => {
      if (box.dataset.bound) return; box.dataset.bound = '1';
      box.addEventListener('click', e => {
        const el = e.target.closest('[data-emo]');
        if (!el) return;
        const target = box.closest('.btn-row, .rr-row, .field, [data-buttons], .modal-body')?.querySelector(box.dataset.target);
        if (target) target.value = el.dataset.val || el.textContent;
      });
      const search = box.querySelector('[data-emo-search]');
      if (search) {
        const customs = [...box.querySelectorAll('img[data-emo]')];
        search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          customs.forEach(im => { im.style.display = (im.dataset.name || '').toLowerCase().includes(q) ? '' : 'none'; });
        });
      }
    });
  },

  // ---- 圖片 / 檔案上傳欄位 ----
  // 產生「網址輸入 + 選擇檔案 + 預覽」的組合欄位；上傳成功會自動填入網址
  uploadField(name, value = '', { accept = 'image/*', label = '圖片' } = {}) {
    const id = 'up_' + name + '_' + Math.random().toString(36).slice(2, 7);
    return `<div class="upload-field" data-upfield="${id}">
      <div style="display:flex;gap:6px;align-items:center">
        <input name="${name}" value="${UI.esc(value)}" placeholder="貼上網址，或點右邊上傳${UI.esc(label)}" style="flex:1">
        <label class="btn small secondary" style="margin:0;white-space:nowrap">
          📎 上傳<input type="file" accept="${accept}" style="display:none" data-upinput></label>
      </div>
      <div data-uppreview style="margin-top:6px">${H.previewHTML(value)}</div>
    </div>`;
  },

  previewHTML(url) {
    if (!url) return '';
    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(url) || url.startsWith('/uploads/')) {
      return `<img src="${UI.esc(url)}" style="max-height:90px;border-radius:6px;border:1px solid var(--border)"
        onerror="this.replaceWith(document.createTextNode(''))">`;
    }
    return `<span class="hint">${UI.esc(url)}</span>`;
  },

  // 方形裁切（頭像用）
  cropSquare(url) { return H.cropImage(url, 1); },

  // 「裁切背景」按鈕：放在上傳欄位旁，點了對該欄位目前的圖開裁切工具，套用後回填欄位並刷新預覽
  cropButton(fieldName, aspect = 1, label = '裁切範圍') {
    return `<button type="button" class="btn small secondary" data-crop-field="${fieldName}" data-crop-aspect="${aspect}" style="margin-top:6px">${label}</button>`;
  },
  bindCropButtons(root) {
    root.querySelectorAll('[data-crop-field]').forEach(btn => {
      if (btn.dataset.bound) return; btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const input = root.querySelector(`input[name="${btn.dataset.cropField}"]`);
        const url = input && input.value.trim();
        if (!url) { UI.err('請先上傳或填入圖片，再裁切'); return; }
        const cropped = await H.cropImage(url, parseFloat(btn.dataset.cropAspect) || 1);
        if (!cropped) return;
        input.value = cropped;
        const prev = input.closest('[data-upfield]') && input.closest('[data-upfield]').querySelector('[data-uppreview]');
        if (prev) prev.innerHTML = H.previewHTML(cropped);
        UI.ok('已套用裁切');
      });
    });
  },

  // 裁切工具：拖曳方框選要露出的範圍 → canvas 裁切 → 上傳 → 回傳新網址。aspect = 寬/高（1=正方，2.5=卡圖 1000×400）
  cropImage(url, aspect = 1) {
    return new Promise((resolve) => {
      const m = UI.modal({
        title: '裁切照片（拖曳方框選要露出的範圍）',
        okText: '套用裁切',
        bodyHTML: `
          <div data-cropstage style="position:relative;touch-action:none;user-select:none;width:340px;max-width:100%;margin:0 auto;background:#222">
            <img data-cropimg src="${UI.esc(url)}" style="display:block;width:100%;pointer-events:none">
            <div data-cropbox style="position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.55);cursor:move;box-sizing:border-box">
              <div data-crophandle style="position:absolute;right:-9px;bottom:-9px;width:18px;height:18px;background:#fff;border-radius:50%;cursor:nwse-resize"></div>
            </div>
          </div>
          <div class="hint" style="text-align:center;margin-top:8px">方框內＝實際會顯示的範圍。拖曳方框移動、拖右下白點縮放。</div>`,
        onOk: async (back) => {
          const img = back.querySelector('[data-cropimg]');
          const box = back.querySelector('[data-cropbox]');
          const scale = img.naturalWidth / img.clientWidth;
          const ssW = Math.round(box.offsetWidth * scale);
          const ssH = Math.round(box.offsetHeight * scale);
          const sx = Math.round(box.offsetLeft * scale);
          const sy = Math.round(box.offsetTop * scale);
          const outW = Math.min(1400, ssW) || 256;
          const outH = Math.round(outW / aspect);
          const canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          canvas.getContext('2d').drawImage(img, sx, sy, ssW, ssH, 0, 0, outW, outH);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const fd = new FormData();
          fd.append('file', new File([blob], 'crop.png', { type: 'image/png' }));
          try { const r = await api('/upload', { method: 'POST', body: fd }); resolve(r.url); }
          catch (e) { UI.err('裁切上傳失敗：' + e.message); resolve(null); }
          return true;
        }
      });
      const back = m.back;
      const img = back.querySelector('[data-cropimg]');
      const box = back.querySelector('[data-cropbox]');
      const handle = back.querySelector('[data-crophandle]');
      const setBox = (w) => { box.style.width = w + 'px'; box.style.height = (w / aspect) + 'px'; };
      const initBox = () => {
        const W = img.clientWidth, H = img.clientHeight;
        let w = Math.floor(Math.min(W, H * aspect) * 0.9);   // 依長寬比塞進圖片
        setBox(w);
        box.style.left = Math.floor((W - w) / 2) + 'px';
        box.style.top = Math.floor((H - w / aspect) / 2) + 'px';
      };
      if (img.complete && img.clientWidth) initBox(); else img.onload = initBox;
      let mode = null, st = null;
      const down = (e, mm) => { mode = mm; st = { x: e.clientX, y: e.clientY, l: box.offsetLeft, t: box.offsetTop, w: box.offsetWidth }; };
      box.addEventListener('pointerdown', e => { if (e.target === handle) return; down(e, 'move'); });
      handle.addEventListener('pointerdown', e => { e.stopPropagation(); down(e, 'resize'); });
      const move = (e) => {
        if (!mode) return;
        const W = img.clientWidth, H = img.clientHeight;
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        if (mode === 'move') {
          box.style.left = Math.max(0, Math.min(W - box.offsetWidth, st.l + dx)) + 'px';
          box.style.top = Math.max(0, Math.min(H - box.offsetHeight, st.t + dy)) + 'px';
        } else {
          let w = Math.max(60, st.w + Math.max(dx, dy * aspect));
          w = Math.min(w, W - box.offsetLeft, (H - box.offsetTop) * aspect);
          setBox(w);
        }
        e.preventDefault();
      };
      window.addEventListener('pointermove', move);
      const up = () => { mode = null; };
      window.addEventListener('pointerup', up);
      const origRemove = back.remove.bind(back);
      back.remove = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); origRemove(); };
    });
  },

  // 綁定 modal / 卡片內所有上傳欄位（呼叫端在畫面建立後呼叫一次）
  bindUploads(root) {
    root.querySelectorAll('[data-upfield]').forEach(box => {
      const input = box.querySelector('[data-upinput]');
      const urlEl = box.querySelector('input[name]');
      const prev = box.querySelector('[data-uppreview]');
      if (!input || input.dataset.bound) return;
      input.dataset.bound = '1';
      urlEl.addEventListener('change', () => { prev.innerHTML = H.previewHTML(urlEl.value); });
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 25 * 1024 * 1024) return UI.err('檔案超過 25MB 上限');
        prev.innerHTML = '<span class="hint">上傳中…</span>';
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await api('/upload', { method: 'POST', body: fd });
          urlEl.value = r.url;
          prev.innerHTML = H.previewHTML(r.url);
          UI.ok('已上傳：' + r.original);
        } catch (e) { UI.err(e.message); prev.innerHTML = ''; }
        input.value = '';
      };
    });
  },

  // ---- 多個連結按鈕（圖標＋文字＋網址），最多 25 個 ----
  buttonsEditor(name, json) {
    let list = [];
    try { list = JSON.parse(json || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const iconCell = (b = {}) => `<span data-bicon style="display:inline-flex;align-items:center;gap:2px">
        <input data-bemoji placeholder="表情" value="${UI.esc(b.emoji || '')}" style="width:56px;text-align:center">
        <label class="btn tiny secondary" style="margin:0;padding:2px 6px;white-space:nowrap" title="上傳圖片當圖標">圖<input type="file" accept="image/*" style="display:none" data-biconup></label>
      </span>`;
    const row = (b = {}) => `
      <div class="btn-row" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;align-items:center">
        ${iconCell(b)}
        <input data-blabel placeholder="按鈕文字" value="${UI.esc(b.label || '')}" style="flex:1">
        <input data-burl placeholder="https://..." value="${UI.esc(b.url || '')}" style="flex:2">
        <button type="button" class="btn tiny danger" data-brm>✕</button>
      </div>`;
    H._btnRowIcon = iconCell;
    H._btnRow = row;
    return `<div data-buttons="${name}">
      <div data-blist>${list.map(row).join('')}</div>
      <button type="button" class="btn small secondary" data-badd>＋ 新增連結按鈕</button>
      <div class="hint">點「表情」欄位就會跳出表情選擇器，伺服器自訂表情也在裡面（可搜尋）。也可以點「圖」上傳自己的圖片當圖標。Discord 一則訊息最多 25 個按鈕。</div>
    </div>`;
  },

  bindButtons(root) {
    root.querySelectorAll('[data-buttons]').forEach(box => {
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      const list = box.querySelector('[data-blist]');
      const rowTpl = H._btnRow || H._btnRowIcon || (() => '');
      // 記住目前作用中的表情欄，供下方共用的 emoji 選擇器填入
      box._activeBemoji = box.querySelector('[data-bemoji]');
      box.addEventListener('focusin', (e) => {
        if (e.target.matches('[data-bemoji]')) box._activeBemoji = e.target;
      });
      H.bindEmojiPickers(box);
      H.initEmojiInputs();
      H.paintEmojiInputs(box);
      box.querySelector('[data-badd]').onclick = () => {
        if (list.children.length >= 25) return UI.err('最多 25 個按鈕');
        const d = document.createElement('div');
        d.innerHTML = rowTpl();
        const el = d.firstElementChild;
        list.appendChild(el);
        H.bindEmojiPickers(el.closest('[data-buttons]') || box);
      };
      box.addEventListener('click', (e) => {
        if (e.target.matches('[data-brm]')) e.target.closest('.btn-row').remove();
      });
      // 上傳圖片當按鈕圖標 → Application Emoji markup 填入 emoji 欄位
      box.addEventListener('change', async (e) => {
        if (!e.target.matches('[data-biconup]')) return;
        const f = e.target.files[0]; if (!f) return;
        if (f.size > 256 * 1024) { UI.err('圖標需小於 256KB'); e.target.value = ''; return; }
        const emojiInput = e.target.closest('[data-bicon]').querySelector('[data-bemoji]');
        emojiInput.value = '上傳中…';
        try {
          const fd = new FormData(); fd.append('file', f);
          const r = await api('/emoji-upload', { method: 'POST', body: fd });
          emojiInput.value = r.markup;
          H.paintEmojiInput(emojiInput);
          UI.ok('圖標已上傳');
        } catch (err) { UI.err(err.message); emojiInput.value = ''; }
        e.target.value = '';
      });
    });
  },

  buttonsValue(root, name) {
    const box = root.querySelector(`[data-buttons="${name}"]`);
    if (!box) return '[]';
    const out = [];
    box.querySelectorAll('.btn-row').forEach(r => {
      const url = r.querySelector('[data-burl]').value.trim();
      const label = r.querySelector('[data-blabel]').value.trim();
      const emoji = r.querySelector('[data-bemoji]').value.trim();
      if (url && /^https?:\/\//.test(url)) out.push({ emoji, label: label || '前往', url });
    });
    return JSON.stringify(out);
  },

  matchLabel(t) { return { contains: '包含', exact: '完全相同', starts: '開頭符合' }[t] || t; },
  matchSelect(name, sel) {
    return `<select name="${name}">
      <option value="contains" ${sel === 'contains' ? 'selected' : ''}>包含關鍵字</option>
      <option value="exact" ${sel === 'exact' ? 'selected' : ''}>完全相同</option>
      <option value="starts" ${sel === 'starts' ? 'selected' : ''}>開頭符合</option>
    </select>`;
  }
};

// 表情選擇器一載入就掛好（document 層級的事件委派），
// 這樣不管哪個頁面、哪個彈窗、動態新增的列都能直接點欄位叫出選擇器。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => H.initEmojiInputs());
  else H.initEmojiInputs();
}
