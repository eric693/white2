// App 骨架：登入、側欄導覽、頁面路由
const App = {
  me: null,
  pages: {},   // key -> { title, sub, group, module, render(el) }

  page(key, def) { App.pages[key] = def; },

  guilds: [],
  currentGuild: '',

  async boot() {
    try {
      App.me = await GET('/me');
      await App.loadGuilds();
      App.renderLayout();
      App.go(location.hash.slice(1) || 'dashboard');
    } catch {
      App.renderLogin();
    }
    window.addEventListener('hashchange', () => {
      if (App.me) App.go(location.hash.slice(1) || 'dashboard');
    });
  },

  async loadGuilds() {
    try {
      const r = await GET('/guilds');
      App.guilds = r.guilds || [];
      // 目前選定的伺服器：優先 localStorage，其次回傳的 current，再其次第一個
      const saved = window.CURRENT_GUILD;
      const valid = App.guilds.find(g => g.id === saved);
      App.currentGuild = valid ? saved : (r.current || (App.guilds[0] && App.guilds[0].id) || '');
      window.CURRENT_GUILD = App.currentGuild;
      localStorage.setItem('w2_guild', App.currentGuild);
    } catch { App.guilds = []; }
  },

  switchGuild(gid) {
    window.CURRENT_GUILD = gid;
    App.currentGuild = gid;
    localStorage.setItem('w2_guild', gid);
    App.go(location.hash.slice(1) || 'dashboard'); // 重新載入目前頁面
  },

  onUnauthorized() { if (App.me) { App.me = null; App.renderLogin(); } },

  can(mod) { return App.me && (App.me.role === 'admin' || App.me.modules.includes(mod)); },

  // ---- 登入頁 ----
  renderLogin() {
    document.getElementById('app').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <h1>White2 後台</h1>
          <div class="sub">Discord 機器人管理系統</div>
          <div class="field"><label>帳號</label><input id="lg-u" autocomplete="username"></div>
          <div class="field"><label>密碼</label><input id="lg-p" type="password" autocomplete="current-password"></div>
          <button class="btn" id="lg-btn">登入</button>
          <div class="err" id="lg-err"></div>
        </div>
      </div>`;
    const btn = document.getElementById('lg-btn');
    const err = document.getElementById('lg-err');
    const submit = async () => {
      err.textContent = '';
      btn.disabled = true;
      try {
        await POST('/login', {
          username: document.getElementById('lg-u').value.trim(),
          password: document.getElementById('lg-p').value
        });
        App.me = await GET('/me');
        App.renderLayout();
        App.go('dashboard');
      } catch (e) { err.textContent = e.message; }
      finally { btn.disabled = false; }
    };
    btn.onclick = submit;
    document.getElementById('lg-p').onkeydown = e => { if (e.key === 'Enter') submit(); };
    document.getElementById('lg-u').focus();
  },

  // 導覽分組
  // 側欄分區。跟 auth.js 的 MODULES.group 對齊 ——
  // 遊戲區獨立成一塊，每個頁面各自一把權限鑰匙，才能只把其中一兩頁交給某個管理員。
  groups: [
    { name: '', keys: ['dashboard'] },
    { name: '互動', keys: ['keywords', 'mentions', 'alerts', 'warnings', 'welcome', 'birthday', 'forum', 'tickets', 'levels'] },
    { name: '活動', keys: ['announcements', 'polls', 'giveaways', 'wheels', 'reminders', 'music'] },
    { name: '遊戲區', keys: ['gather', 'ranch', 'aquarium', 'crops', 'home', 'special', 'tax', 'charity', 'auction', 'loans', 'stock', 'news'] },
    { name: '設定', keys: ['blacklist', 'media', 'appearance', 'perms', 'system', 'guilds', 'users'] }
  ],

  renderLayout() {
    const navHTML = App.groups.map(g => {
      const items = g.keys.filter(k => App.pages[k] && App.can(App.pages[k].module || k));
      if (!items.length) return '';
      const links = items.map(k =>
        `<a href="#${k}" data-nav="${k}">${UI.esc(App.pages[k].title)}</a>`).join('');
      return (g.name ? `<div class="nav-group">${g.name}</div>` : '') + links;
    }).join('');

    document.getElementById('app').innerHTML = `
      <div class="layout">
        <div class="backdrop" id="backdrop"></div>
        <aside class="sidebar" id="sidebar">
          <div class="brand">
            <span class="dot ${App.me.bot_online ? 'on' : ''}"></span>${UI.esc(App.me.brand_title || 'White2 後台')}
            <small>${UI.esc(App.me.brand_sub || '')}</small>
          </div>
          <nav class="nav">${navHTML}</nav>
          <div class="user-box">
            <div class="name">${UI.esc(App.me.name)}</div>
            <div style="color:#9aa0c9">${App.me.role === 'admin' ? '總管理員' : '管理員'}</div>
            <button id="logout">登出</button>
          </div>
        </aside>
        <main class="main">
          <div class="topbar">
            <button class="menu-btn" id="menu-btn">☰</button>
            <strong>${UI.esc(App.me.brand_title || 'White2 後台')}</strong>
            <div class="spacer" style="flex:1"></div>
            ${App.guilds.length ? `<span style="color:var(--muted);font-size:13px">管理伺服器：</span>
              <select id="guild-switch" style="max-width:220px">
                ${App.guilds.map(g => `<option value="${g.id}" ${g.id === App.currentGuild ? 'selected' : ''}>${UI.esc(g.name)}</option>`).join('')}
              </select>` : ''}
          </div>
          <div id="view"></div>
        </main>
      </div>`;

    document.getElementById('logout').onclick = async () => {
      await POST('/logout'); App.me = null; location.hash = ''; App.renderLogin();
    };
    const gs = document.getElementById('guild-switch');
    if (gs) gs.onchange = (e) => App.switchGuild(e.target.value);
    const sb = document.getElementById('sidebar'), bd = document.getElementById('backdrop');
    document.getElementById('menu-btn').onclick = () => { sb.classList.add('open'); bd.classList.add('show'); };
    bd.onclick = () => { sb.classList.remove('open'); bd.classList.remove('show'); };
  },

  go(key) {
    const def = App.pages[key];
    if (!def || !App.can(def.module || key)) return App.go('dashboard');
    document.querySelectorAll('[data-nav]').forEach(a =>
      a.classList.toggle('active', a.dataset.nav === key));
    const sb = document.getElementById('sidebar'), bd = document.getElementById('backdrop');
    if (sb) sb.classList.remove('open'); if (bd) bd.classList.remove('show');
    const view = document.getElementById('view');
    view.innerHTML = `
      <div class="page-title">${UI.esc(def.title)}</div>
      <div class="page-sub">${UI.esc(def.sub || '')}</div>
      <div id="page-body"></div>`;
    try { def.render(document.getElementById('page-body')); }
    catch (e) { UI.err(e.message); }
  }
};
