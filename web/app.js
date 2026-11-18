/* ChatGPT 手机端 —— 前端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const listView = $('list-view');
  const chatView = $('chat-view');
  const threadsEl = $('threads');
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const micBtn = $('mic');
  const attachBtn = $('attach');
  const fileEl = $('file');
  const modelChip = $('model-chip');
  const permChip = $('perm-chip');
  const workspaceChip = $('workspace-chip');
  const changesChip = $('changes-chip');
  const diffView = $('diff-view');
  const diffText = $('diff-text');
  const diffFilesList = $('diff-files-list');
  const titleEl = $('chat-title');
  const genPill = $('gen-pill');
  const dot = $('status-dot');
  const banner = $('offline');
  const bannerText = $('offline-text');
  const searchEl = $('search');
  const sheet = $('sheet');
  const sheetTitle = $('sheet-title');
  const sheetActions = $('sheet-actions');
  const toastEl = $('toast');
  const toBottom = $('to-bottom');
  const approvalBar = $('approval-bar');
  const approvalText = $('approval-text');
  const approvalAllow = $('approval-allow');
  const approvalDeny = $('approval-deny');

  let state = { threads: [], messages: [], generating: false, ok: false, title: '', model: '', permission: '' };
  let current = null;
  let filter = '';
  let atBottom = true;
  let wasGenerating = false;
  let lastCount = 0;
  let sheetPick = null;

  /* ---------------- 工具 ---------------- */

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function vibrate(pattern = 40) {
    try { navigator.vibrate?.(pattern); } catch {}
  }

  // 通知：APK 里由后台服务轮询发（网页在后台会被冻结），浏览器里走 Notification API
  function notify(title, body) {
    // APK 里通知交给 WatchService，避免和网页重复弹
    if (window.AndroidNotify && window.AndroidNotify.show) return;
    if (!('Notification' in window)) return;
    const fire = () => {
      try { new Notification(title, { body: body || '', icon: '/icon-192.png', tag: 'chatpig' }); } catch {}
    };
    if (Notification.permission === 'granted') fire();
    else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }).catch(() => {});
  }

  // 启动 APK 的后台监视服务
  async function startNativeWatch() {
    try {
      if (!window.AndroidNotify || !window.AndroidNotify.startWatch) return;
      const r = await api('/api/token');
      window.AndroidNotify.startWatch(location.origin, r.token);
    } catch {}
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
    const root = doc.getElementById('r');
    const bad = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON']);
    const walk = (node) => {
      for (const el of [...node.children]) {
        if (bad.has(el.tagName)) { el.remove(); continue; }
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style' || name === 'srcdoc') el.removeAttribute(attr.name);
          if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
        if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
        walk(el);
      }
    };
    walk(root);
    for (const code of [...root.querySelectorAll('code')]) {
      if (code.closest('pre')) continue;
      const cls = code.className || '';
      if (/whitespace-pre|\bblock\b/.test(cls) || code.textContent.includes('\n')) {
        const pre = doc.createElement('pre');
        code.replaceWith(pre);
        pre.appendChild(code);
      }
    }
    // 桌面端的 <video> 没有 controls（它自己画了一层控件），手机端必须补原生控件才能播
    for (const v of [...root.querySelectorAll('video')]) {
      v.setAttribute('controls', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('preload', 'metadata');
      if (!v.getAttribute('src') && !v.querySelector('source')) v.setAttribute('preload', 'none');
    }
    for (const a of [...root.querySelectorAll('audio')]) {
      a.setAttribute('controls', '');
      a.setAttribute('preload', 'metadata');
    }
    // 图片/视频如果是包在 <a> 里的，让它直接显示，不要点开新窗口
    for (const media of [...root.querySelectorAll('img, video')]) {
      const link = media.closest('a');
      if (link && link.getAttribute('href') === media.getAttribute('src')) link.replaceWith(media);
    }
    return root.innerHTML;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ---------------- 渲染 ---------------- */

  function renderStatus() {
    dot.className = 'dot ' + (!state.ok ? 'offline' : state.generating ? 'busy' : 'online');
    if (!state.ok) {
      banner.classList.remove('hidden');
      bannerText.textContent = state.error || '连不上电脑上的 ChatGPT';
    } else {
      banner.classList.add('hidden');
    }
    genPill.classList.toggle('hidden', !state.generating);
    stopBtn.classList.toggle('hidden', !state.generating);
    sendBtn.classList.toggle('hidden', state.generating);
    sendBtn.disabled = !state.ok;

    const ap = state.pendingApproval;
    approvalBar.classList.toggle('hidden', !ap);
    if (ap) {
      approvalText.textContent = ap.text || '电脑上的 ChatGPT 在等你确认';
      approvalDeny.classList.toggle('hidden', !ap.hasDeny);
    }
  }

  function renderChips() {
    modelChip.textContent = state.model ? `🧠 ${state.model}` : '🧠 模型…';
    permChip.textContent = state.permission ? `🔐 ${state.permission}` : '🔐 权限…';
    workspaceChip.textContent = state.workspace ? `📁 ${state.workspace}` : '📁 工作区';
    modelChip.disabled = !state.ok;
    permChip.disabled = !state.ok;
    workspaceChip.disabled = !state.ok;
    attachBtn.disabled = !state.ok;
    changesChip.classList.toggle('hidden', !state.hasChanges);
  }

  function renderThreads() {
    const q = filter.trim().toLowerCase();
    const items = (state.threads || []).filter((t) => !q || (t.title || '').toLowerCase().includes(q));
    if (!items.length) {
      threadsEl.innerHTML = `<div class="empty">${state.ok ? '没有会话' : '等待连接电脑…'}</div>`;
      return;
    }
    const pinned = items.filter((t) => t.pinned);
    const rest = items.filter((t) => !t.pinned);
    const row = (t) => `
      <div class="thread ${t.active ? 'active' : ''}" data-id="${esc(t.id)}" data-title="${esc(t.title || '')}" data-pinned="${t.pinned ? 1 : 0}">
        <span class="t">${esc(t.title || '（无标题）')}</span>
        ${t.needsApproval ? '<span class="needs">待批准</span>' : t.pinned ? '<span class="pin">置顶</span>' : ''}
      </div>`;
    threadsEl.innerHTML =
      (pinned.length ? `<div class="section-label">置顶</div>${pinned.map(row).join('')}` : '') +
      (rest.length ? `<div class="section-label">${pinned.length ? '全部' : '会话'}</div>${rest.map(row).join('')}` : '');
  }

  // 只有消息内容真变了才重绘；否则每 0.9 秒一次的重绘会把正在播放的 <video> 销毁重建
  let lastMsgKey = '';

  function messagesKey() {
    const msgs = state.messages || [];
    const last = msgs[msgs.length - 1] || {};
    const tail = String(last.html || last.text || '')
      + '|' + (state.files || []).map((f) => f.name).join(',')
      + '|' + (state.changes || []).map((c) => c.name).join(',');
    let h = 0;
    for (let i = 0; i < tail.length; i++) h = (h * 31 + tail.charCodeAt(i)) | 0;
    return `${msgs.length}|${state.generating ? 1 : 0}|${h}`;
  }

  function renderMessages() {
    if (!state.messages?.length) {
      lastMsgKey = 'empty';
      messagesEl.innerHTML = `<div class="empty">还没有消息。在下面输入，电脑上会立即开始。</div>`;
      return;
    }
    const key = messagesKey();
    if (key === lastMsgKey) return;
    lastMsgKey = key;
    const wasBottom = atBottom;
    const beforeH = messagesEl.scrollHeight;
    const older = state.messages.length >= 40
      ? `<div class="older-hint">更早的消息没有同步（只显示最近 40 条）</div>`
      : '';
    const html = state.messages.map((m, i) => {
      if (m.role === 'user') {
        return `<div class="msg user" data-i="${i}">${esc(m.text)}<button class="msg-act" data-act="copy">复制</button></div>`;
      }
      return `<div class="msg assistant" data-i="${i}">${sanitize(m.html || esc(m.text || ''))}<button class="msg-act" data-act="copy">复制</button></div>`;
    }).join('');
    const typing = state.generating
      ? `<div class="msg assistant typing-bubble"><span class="typing"><i></i><i></i><i></i> 电脑上的 ChatGPT 正在输出…</span></div>`
      : '';
    const filesHtml = (state.files || []).length
      ? `<div class="file-cards">` + state.files.map((f) => {
          const href = f.path ? `/media?p=${encodeURIComponent(f.path)}&dl=1` : '#';
          return `<a class="file-card" href="${href}" target="_blank" rel="noopener">
            <span class="ficon">📄</span>
            <span class="fbody"><span class="fname ellipsis">${esc(f.name)}</span><span class="fmeta">${f.exists ? '点开查看 / 下载' : '电脑上没找到'}</span></span>
          </a>`;
        }).join('') + `</div>`
      : '';
    const changesHtml = (state.changes || []).length
      ? `<div class="file-cards changes-inline">` + state.changes.map((c, i) => `
          <div class="file-card change-card" data-ci="${i}">
            <span class="ficon">✏️</span>
            <span class="fbody"><span class="fname ellipsis">${esc(c.name)}</span>
            <span class="fmeta"><b>+${c.added}</b> <i>-${c.removed}</i> · 点开看内容</span></span>
          </div>`).join('') + `</div>`
      : '';
    messagesEl.innerHTML = older + html + filesHtml + changesHtml + typing;
    if (wasBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    else messagesEl.scrollTop = Math.max(0, messagesEl.scrollHeight - beforeH + messagesEl.scrollTop);
  }

  function render() {
    renderStatus();
    renderChips();
    renderThreads();
    renderMessages();
    titleEl.textContent = state.title || (current ? '对话' : 'ChatGPT');
    toBottom.classList.toggle('hidden', atBottom);
  }

  function showList() {
    current = null;
    chatView.classList.add('hidden');
    listView.classList.remove('hidden');
    toBottom.classList.add('hidden');
  }

  function showChat() {
    listView.classList.add('hidden');
    chatView.classList.remove('hidden');
    atBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ---------------- 数据流 ---------------- */

  function applyState(next) {
    const prev = state;
    const justFinished = prev.generating && !next.generating;
    const grew = (next.messages?.length || 0) > lastCount;
    wasGenerating = !!next.generating;
    lastCount = next.messages?.length || 0;
    state = next;
    render();

    if (justFinished && grew && current) {
      vibrate([30, 60, 30]);
      if (document.hidden) document.title = '✅ 回复完成';
      notify('✅ 任务完成', next.title ? `${next.title} — 电脑上的 ChatGPT 已回复` : '电脑上的 ChatGPT 已回复');
    }

    // 新出现的审批请求
    if (next.pendingApproval && !prev.pendingApproval) {
      vibrate([40, 80, 40]);
      const detail = String(next.pendingApproval.text || '').slice(0, 140);
      notify('⚠️ 需要你确认', detail || '电脑上的 ChatGPT 在等你批准');
    }
  }

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (ev) => { try { applyState(JSON.parse(ev.data)); } catch {} };
    es.onerror = () => { es.close(); setTimeout(connect, 2500); };
  }

  async function refreshNow() {
    try { applyState(await api('/api/state')); } catch (e) { console.warn(e); }
  }

  // 产物文件：需要电脑端滚一下虚拟列表，所以只在打开会话/手动刷新时抓
  async function refreshFiles() {
    try {
      const r = await api('/api/files');
      if (Array.isArray(r.files)) {
        state.files = r.files;
        lastMsgKey = '';
        render();
      }
    } catch (e) {
      console.warn(e);
    }
  }

  /* ---------------- 底部面板（通用） ---------------- */

  function openSheet(title, actions, onPick) {
    sheetTitle.textContent = title;
    sheetPick = onPick;
    sheetActions.innerHTML = actions.map((a, i) =>
      `<button class="sheet-btn ${a.danger ? 'danger' : ''} ${a.active ? 'active' : ''}" data-i="${i}">${esc(a.label)}${a.active ? ' ✓' : ''}</button>`
    ).join('') + `<button class="sheet-btn cancel" data-i="-1">取消</button>`;
    sheet.classList.remove('hidden');
  }

  function closeSheet() {
    sheet.classList.add('hidden');
    sheetPick = null;
  }

  sheet.addEventListener('click', async (ev) => {
    if (ev.target === sheet) return closeSheet();
    const btn = ev.target.closest('.sheet-btn');
    if (!btn) return;
    const idx = Number(btn.dataset.i);
    const pick = sheetPick;
    closeSheet();
    if (idx < 0 || !pick) return;
    try { await pick(idx); } catch (e) { toast(e.message); }
  });

  /* ---------------- 会话 ---------------- */

  let pressTimer = null;
  let longPressed = false;

  threadsEl.addEventListener('pointerdown', (ev) => {
    const row = ev.target.closest('.thread');
    if (!row) return;
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      longPressed = true;
      vibrate(25);
      const pinned = row.dataset.pinned === '1';
      const actions = pinned
        ? [{ label: '取消置顶', act: 'unpin' }, { label: '归档（从列表移除）', act: 'archive', danger: true }]
        : [{ label: '置顶', act: 'pin' }, { label: '归档（从列表移除）', act: 'archive', danger: true }];
      openSheet(row.dataset.title || '会话', actions, async (i) => {
        const r = await api('/api/thread/action', { threadId: row.dataset.id, action: actions[i].act });
        toast(r.ok ? '已处理' : '电脑上没找到这个按钮');
        if (r.state) applyState(r.state);
      });
    }, 480);
  });

  threadsEl.addEventListener('pointerup', async (ev) => {
    clearTimeout(pressTimer);
    const row = ev.target.closest('.thread');
    if (!row || longPressed) return;
    const id = row.dataset.id;
    current = id;
    row.classList.add('active');
    showChat();
    titleEl.textContent = row.dataset.title || '对话';
    lastMsgKey = '';
    messagesEl.innerHTML = `<div class="empty">正在打开…</div>`;
    try { await api('/api/open', { threadId: id }); await refreshFiles(); }
    catch (e) { bannerText.textContent = e.message; banner.classList.remove('hidden'); }
  });

  threadsEl.addEventListener('pointercancel', () => clearTimeout(pressTimer));

  /* ---------------- 模型 / 权限 ---------------- */

  modelChip.addEventListener('click', async () => {
    try {
      toast('正在读取模型列表…', 900);
      const r = await api('/api/models');
      const items = (r.items || []).filter((x) => x.text);
      if (!items.length) return toast('没读到模型列表');
      const actions = items.map((x) => ({ label: x.text, active: x.checked === 'true' }));
      const currentName = r.current || '';
      openSheet('切换模型', actions, async (i) => {
        const name = items[i].text;
        toast('正在切换…', 1200);
        const out = await api('/api/model', { name });
        if (out.state) applyState(out.state);
        toast('已切换到 ' + name);
      });
      void currentName;
    } catch (e) { toast(e.message); }
  });

  permChip.addEventListener('click', async () => {
    try {
      toast('正在读取权限选项…', 900);
      const r = await api('/api/permissions');
      const items = (r.items || []).filter((x) => x.text);
      if (!items.length) return toast('没读到权限选项');
      const actions = items.map((x) => ({
        label: x.text.split(/\s{2,}/)[0] + (x.text.length > 30 ? ' — ' + x.text.slice(x.text.indexOf(' ') + 1, 70) : ''),
      }));
      openSheet('权限模式', actions, async (i) => {
        const name = items[i].text.split(/\s{2,}/)[0];
        toast('正在切换…', 1200);
        const out = await api('/api/permission', { name });
        if (out.state) applyState(out.state);
        toast('权限已改为 ' + name);
      });
    } catch (e) { toast(e.message); }
  });

  /* ---------------- 附件 ---------------- */

  attachBtn.addEventListener('click', () => fileEl.click());

  fileEl.addEventListener('change', async () => {
    const files = [...(fileEl.files || [])];
    fileEl.value = '';
    if (!files.length) return;
    for (const f of files) {
      toast(`正在上传 ${f.name}（${(f.size / 1024 / 1024).toFixed(1)} MB）…`, 6000);
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'x-filename': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' },
          body: f,
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
        if (data.state) applyState(data.state);
        toast(`${f.name} 已添加到电脑上的输入框`);
      } catch (e) {
        toast('上传失败：' + e.message, 3000);
      }
    }
  });

  /* ---------------- 工作区 / 改动 ---------------- */

  workspaceChip.addEventListener('click', async () => {
    try {
      toast('正在读取工作区…', 900);
      const r = await api('/api/projects');
      const items = r.items || [];
      if (!items.length) return toast('侧边栏里没有项目');
      const actions = items.map((p) => ({ label: p.name, active: p.name === r.current }));
      openSheet('切换工作区（会在该工作区里开新会话）', actions, async (i) => {
        toast('正在切换…', 1800);
        const out = await api('/api/workspace', { name: items[i].name });
        if (out.state) applyState(out.state);
        current = 'live';
        showChat();
        lastMsgKey = '';
        toast('已切到工作区 ' + items[i].name);
      });
    } catch (e) {
      toast(e.message);
    }
  });

  changesChip.addEventListener('click', () => openChanges());

  async function openChanges(selectIndex) {
    try {
      toast('正在读取改动文件…', 2000);
      const r = await api('/api/changes');
      const files = r.files || [];
      pendingFiles = files;
      diffFilesList.innerHTML = files.length
        ? files.map((f, i) => `<div class="diff-file ${i === selectIndex ? 'active' : ''}" data-i="${i}"><span class="ellipsis">${esc(f.name)}</span><span class="stat"><b>+${f.added}</b> <i>-${f.removed}</i></span></div>`).join('')
        : '<div class="empty">这个会话没有改动文件</div>';
      diffText.textContent = files.length ? '点上面的文件看内容' : '（没有改动）';
      diffView.classList.remove('hidden');
      if (typeof selectIndex === 'number' && files[selectIndex]) showFile(files[selectIndex], diffFilesList.querySelector(`.diff-file[data-i="${selectIndex}"]`));
    } catch (e) {
      toast(e.message);
    }
  }

  let pendingFiles = [];

  async function showFile(f, row) {
    if (!f) return;
    diffFilesList.querySelectorAll('.diff-file').forEach((el) => el.classList.remove('active'));
    if (row) row.classList.add('active');
    if (!f.path) {
      diffText.textContent = `${f.name}\n\n+${f.added}  -${f.removed}\n\n（磁盘上没找到这个文件，可能已被移走）`;
      return;
    }
    diffText.textContent = '读取中…';
    try {
      const res = await fetch(`/media?p=${encodeURIComponent(f.path)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      diffText.textContent = (await res.text()).slice(0, 200000);
    } catch (e) {
      diffText.textContent = `读取失败：${e.message}`;
    }
  }

  diffFilesList.addEventListener('click', async (ev) => {
    const row = ev.target.closest('.diff-file');
    if (!row) return;
    showFile(pendingFiles[Number(row.dataset.i)], row);
  });

  $('diff-close').addEventListener('click', () => diffView.classList.add('hidden'));
  $('diff-files').addEventListener('click', () => {
    diffFilesList.classList.toggle('hidden');
  });

  /* ---------------- 基础交互 ---------------- */

  $('back').addEventListener('click', () => { showList(); refreshNow(); });
  $('refresh').addEventListener('click', async () => { await refreshNow(); await refreshFiles(); });

  $('new-chat').addEventListener('click', async () => {
    try {
      await api('/api/new', {});
      current = null;
      showChat();
      titleEl.textContent = '新会话';
      lastMsgKey = '';
      messagesEl.innerHTML = `<div class="empty">新会话已就绪，直接发消息即可。</div>`;
      inputEl.focus();
    } catch (e) { bannerText.textContent = e.message; banner.classList.remove('hidden'); }
  });

  $('composer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    inputEl.value = '';
    autoGrow();
    atBottom = true;
    try { await api('/api/send', { text }); }
    catch (e) {
      bannerText.textContent = e.message;
      banner.classList.remove('hidden');
      inputEl.value = text;
    }
  });

  stopBtn.addEventListener('click', async () => {
    try { await api('/api/stop', {}); vibrate(20); } catch {}
  });

  async function approve(action) {
    try {
      const r = await api('/api/approve', { action });
      if (r.state) applyState(r.state);
      toast(r.ok ? (action === 'deny' ? '已拒绝' : '已允许') : '电脑上没找到审批按钮');
    } catch (e) {
      toast(e.message);
    }
  }
  approvalAllow.addEventListener('click', () => approve('allow'));
  approvalDeny.addEventListener('click', () => approve('deny'));

  // 第一次点屏幕时申请一次通知权限（浏览器里需要，APK 走原生）
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    try {
      if (!window.AndroidNotify && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch {}
  }, { once: true });

  $('relaunch').addEventListener('click', async () => {
    bannerText.textContent = '正在重启 ChatGPT（约 40 秒）…';
    try { await api('/api/relaunch', {}); } catch (e) { bannerText.textContent = e.message; }
  });

  searchEl.addEventListener('input', () => { filter = searchEl.value; renderThreads(); });

  messagesEl.addEventListener('click', async (ev) => {
    const changeCard = ev.target.closest('.change-card');
    if (changeCard) {
      openChanges(Number(changeCard.dataset.ci));
      return;
    }
    const btn = ev.target.closest('.msg-act');
    if (!btn) return;
    const holder = btn.closest('.msg');
    const msg = state.messages?.[Number(holder?.dataset.i)];
    if (!msg) return;
    try {
      await navigator.clipboard.writeText(msg.text || holder.innerText);
      toast('已复制');
      vibrate(15);
    } catch { toast('复制失败'); }
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  }
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('composer').requestSubmit();
    }
  });

  messagesEl.addEventListener('scroll', () => {
    atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    toBottom.classList.toggle('hidden', atBottom);
  });

  toBottom.addEventListener('click', () => {
    atBottom = true;
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    toBottom.classList.add('hidden');
  });

  /* ---------------- 语音输入 ---------------- */

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle('listening', on);
    micBtn.textContent = on ? '⏺' : '🎤';
    if (on) vibrate(20);
  }

  window.onSpeechResult = (text) => {
    inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + text;
    autoGrow();
  };
  window.onSpeechError = (msg) => { toast(msg || '语音识别失败'); setListening(false); };
  window.onSpeechEnd = () => setListening(false);

  micBtn.addEventListener('click', () => {
    if (listening) {
      try { recog?.stop(); } catch {}
      try { window.AndroidSpeech?.stop(); } catch {}
      setListening(false);
      return;
    }
    if (SR) {
      recog = new SR();
      recog.lang = 'zh-CN';
      recog.interimResults = false;
      recog.maxAlternatives = 1;
      recog.onresult = (e) => window.onSpeechResult(e.results[0][0].transcript);
      recog.onerror = (e) => window.onSpeechError(e.error === 'not-allowed' ? '没给麦克风权限' : '语音识别失败');
      recog.onend = () => setListening(false);
      try { recog.start(); setListening(true); } catch { toast('语音启动失败'); }
      return;
    }
    if (window.AndroidSpeech) {
      setListening(true);
      try { window.AndroidSpeech.start(); } catch { setListening(false); toast('语音启动失败'); }
      return;
    }
    toast('这个环境不支持语音输入');
  });

  /* ---------------- 其他 ---------------- */

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }
  setInterval(() => keepAwake(state.generating), 3000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      document.title = 'ChatGPT 手机端';
      refreshNow();
    }
  });

  refreshNow().then(() => refreshFiles()).then(() => startNativeWatch()).finally(() => {
    connect();
    if (state.ok && state.messages?.length) { current = 'live'; showChat(); }
    else showList();
    render();
  });
})();
