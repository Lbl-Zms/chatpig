// ChatGPT Mobile Bridge
// 把电脑上的 ChatGPT / Codex 桌面窗口通过 DevTools 协议接管，
// 在本机局域网上开一个只给手机用的小服务。
//
//   node server.mjs
//
// 依赖：Node 22+（用到内置 WebSocket / fetch），无需 npm 安装。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const CONFIG_FILE = path.join(ROOT, 'config.json');

// ---------------------------------------------------------------- 配置

const DEFAULTS = {
  port: 8787,
  cdpPort: 9222,
  // 带调试端口拉起 ChatGPT 用的可执行文件（默认取已安装的 MSIX 包内 exe）
  chatgptExe: '',
  token: '',
  // 手机上输入用的 6 位配对码（比 32 位 token 好敲多了）
  pin: '',
  // 手机用移动数据时，靠 Cloudflare 快速隧道从外网连回来（电脑主动外连，不开放端口）
  tunnel: true,
  // 隧道建立后自动打开二维码图片，方便直接扫
  openQr: true,
  // 双击启动时，如果 ChatGPT 没带调试端口，自动重启它（会中断正在进行的工作）
  autoLaunchChatgpt: true,
  // 工作区根目录（改动文件在这里找）；留空则按项目名猜 G:\<项目名>
  workspaceRoot: '',
  cloudflared: '',
};

function newPin() {
  return String(crypto.randomInt(100000, 999999));
}

function loadConfig() {
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_FILE)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
  }
  if (!cfg.token) cfg.token = crypto.randomBytes(16).toString('hex');
  if (!cfg.pin) cfg.pin = newPin();
  if (!cfg.chatgptExe) cfg.chatgptExe = findChatgptExe();
  if (!cfg.cloudflared) cfg.cloudflared = path.join(ROOT, 'bin', 'cloudflared.exe');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

function findChatgptExe() {
  const base = 'C:\\Program Files\\WindowsApps';
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^OpenAI\.Codex_/i.test(d)).sort();
    for (const d of dirs.reverse()) {
      const exe = path.join(base, d, 'app', 'ChatGPT.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
}

const CFG = loadConfig();

// ---------------------------------------------------------------- CDP 客户端

const CDP_HTTP = `http://127.0.0.1:${CFG.cdpPort}`;

class Cdp {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.targetUrl = '';
    this.state = 'idle'; // idle | connecting | ready | down
    this.lastError = '';
    this.pageEnabled = false;
  }

  on(method, cb) {
    const list = this.listeners.get(method) || [];
    list.push(cb);
    this.listeners.set(method, list);
    return () => {
      const now = (this.listeners.get(method) || []).filter((f) => f !== cb);
      this.listeners.set(method, now);
    };
  }

  async ensurePage() {
    if (this.pageEnabled) return;
    await this.send('Page.enable');
    this.pageEnabled = true;
  }

  async #listTargets() {
    const res = await fetch(`${CDP_HTTP}/json/list`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    return res.json();
  }

  async ensure() {
    if (this.ws && this.ws.readyState === 1) return true;
    if (this.state === 'connecting') return false;
    this.state = 'connecting';
    try {
      const targets = await this.#listTargets();
      const page = targets.find((t) => t.type === 'page' && /app:\/\/|chatgpt/i.test(t.url)) || targets.find((t) => t.type === 'page');
      if (!page) throw new Error('找不到 ChatGPT 窗口');
      await this.#open(page);
      this.state = 'ready';
      this.lastError = '';
      return true;
    } catch (e) {
      this.state = 'down';
      this.lastError = e.message;
      return false;
    }
  }

  #open(page) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 连接超时')); }, 6000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.targetUrl = page.url;
        ws.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          const p = msg.id && this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p(msg); return; }
          if (msg.method) {
            for (const cb of this.listeners.get(msg.method) || []) {
              try { cb(msg.params); } catch {}
            }
          }
        });
        ws.addEventListener('close', () => {
          this.ws = null;
          this.state = 'down';
        });
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 15000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.error) throw new Error(r.error.message || 'CDP 错误');
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || '页面脚本异常');
    return r.result?.result?.value;
  }

  async insertText(text) {
    await this.send('Input.insertText', { text });
  }

  async pressEnter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async hoverAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  }

  async escape() {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}

const cdp = new Cdp();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桌面端把生成的图片/视频写成 app://fs/@fs/<本地路径>，手机上打不开 → 换成走 /media 代理
function rewriteMedia(html) {
  if (!html) return html;
  return html.replace(/(src|href)="(app:\/\/fs\/@fs\/[^"]+|file:\/\/\/[^"]+)"/g, (all, attr, url) => {
    let p = url.startsWith('app://fs/@fs/') ? url.slice('app://fs/@fs/'.length) : url.slice('file:///'.length);
    try { p = decodeURIComponent(p); } catch {}
    return `${attr}="/media?p=${encodeURIComponent(p)}"`;
  });
}

const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ---------------------------------------------------------------- 模型 / 权限 / 附件

const composerBoxExpr = `(() => {
  const c = document.querySelector('[data-codex-composer="true"]');
  if (!c) return null;
  let box = c;
  for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
  return box;
})()`;

const modelBtnRectExpr = `(() => {
  const visible = (b) => b && b.getBoundingClientRect().width > 0;
  // 窄窗口/开了侧栏时，模型按钮会收成图标，只剩 aria-label
  const compact = [...document.querySelectorAll('button[aria-label="Select model"]')].find(visible);
  if (compact) {
    const r = compact.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }
  const box = ${composerBoxExpr};
  if (!box) return null;
  const b = [...box.querySelectorAll('button')].find((x) => /DeepSeek|GPT-?5|Claude|Qwen|Grok/i.test(x.innerText || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

const VISIBLE_MODEL_BTN = modelBtnRectExpr;

const MENU_ITEMS = (role) => `(() => {
  const want = ${JSON.stringify(role)};
  return [...document.querySelectorAll('[role="' + want + '"]')]
    .filter((it) => !it.closest('[aria-label="Application menu"]'))
    .map((it, i) => {
      const r = it.getBoundingClientRect();
      return {
        i,
        text: (it.innerText || '').replace(/\\s+/g, ' ').trim(),
        checked: it.getAttribute('aria-checked') || '',
        visible: r.width > 0 && r.height > 0,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      };
    });
})()`;

// 面板里的「模型行」：点了它才会展开「Select model」列表
const MODEL_ROW_EXPR = `(() => {
  const menu = [...document.querySelectorAll('[role="menu"]')].find((m) => /DeepSeek|GPT|Claude|Qwen|Select model/i.test(m.innerText || ''));
  if (!menu) return null;
  const row = [...menu.querySelectorAll('[role="menuitem"]')].find((e) => /^(DeepSeek|GPT|Claude|Qwen|Grok)/i.test((e.innerText || '').trim()));
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

async function closeMenus() {
  await cdp.escape();
  await sleep(250);
}

// ---------------------------------------------------------------- 工作区 / 改动文件

const PROJECTS_EXPR = `(() => {
  const out = [];
  for (const b of document.querySelectorAll('button[aria-label^="Start new chat in "]')) {
    const name = b.getAttribute('aria-label').replace('Start new chat in ', '');
    const r = b.getBoundingClientRect();
    if (!out.some((x) => x.name === name)) out.push({ name, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  return out;
})()`;

// 当前会话属于哪个工作区：从“激活的会话项”往上找，看哪个祖先里带 “Start new chat in X”
const CURRENT_WORKSPACE_EXPR = `(() => {
  const active = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]');
  if (!active) return '';
  let cur = active;
  for (let i = 0; i < 14 && cur; i++, cur = cur.parentElement) {
    const btn = cur.querySelector && cur.querySelector('button[aria-label^="Start new chat in "]');
    if (btn) return btn.getAttribute('aria-label').replace('Start new chat in ', '');
  }
  return '';
})()`;

async function listProjects() {
  return cdp.eval(PROJECTS_EXPR);
}

async function switchWorkspace(name) {
  const projects = await listProjects();
  const target = projects.find((p) => p.name === name);
  if (!target) throw new Error(`侧边栏里没有工作区「${name}」`);
  await cdp.clickAt(target.x, target.y);
  await sleep(1200);
  await refresh();
  return true;
}

// 改动文件：从会话文本里解析「文件名 +N -M」，再尝试在磁盘上找到它的绝对路径
function parseChanges(messages) {
  const files = [];
  const corpus = (messages || []).map((m) => m.text || '').join('\n');
  for (const line of corpus.split('\n')) {
    const m = line.trim().match(/^(.+?\.[A-Za-z0-9]{1,8})\s*\+(\d+)\s*-(\d+)$/);
    if (!m) continue;
    const name = m[1].replace(/^Edited\s+/i, '').trim();
    if (!name || files.some((f) => f.name === name)) continue;
    files.push({ name, added: Number(m[2]), removed: Number(m[3]) });
  }
  // 在正文里找绝对路径（像 X:\project\file.mjs）
  for (const f of files) {
    const base = f.name.split(/[\\/]/).pop();
    const re = new RegExp('([A-Za-z]:\\\\\\\\[^\\s"\'<>|]+?' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
    const hit = corpus.match(re);
    if (hit) f.path = hit[1];
  }
  return files;
}

async function readChanges() {
  // 如果桌面停在 Changes 标签，切回会话，免得手机操作看不到对话
  const onChanges = await cdp.eval(`[...document.querySelectorAll('[role="tab"]')].some((t) => (t.innerText || '').trim() === 'Changes')`);
  if (onChanges) {
    const back = await cdp.eval(`(() => {
      const title = document.title;
      const el = [...document.querySelectorAll('[role="toolbar"], div')].find((e) => {
        const r = e.getBoundingClientRect();
        return r.y >= 0 && r.y < 80 && r.width > 60 && r.width < 400 && (e.innerText || '').trim() === title;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (back) await cdp.clickAt(back.x, back.y);
    await sleep(1000);
    await refresh();
  }

  const files = (snapshot.changes || []).slice();
  for (const f of files) {
    if (!f.path) {
      const base = f.name.split(/[\\/]/).pop();
      const guess = CFG.workspaceRoot ? path.join(CFG.workspaceRoot, f.name) : '';
      if (guess && fs.existsSync(guess)) f.path = guess;
      else {
        // 在最近的消息里找绝对路径
        const corpus = (snapshot.messages || []).map((m) => m.text || '').join('\n');
        const re = new RegExp('([A-Za-z]:\\\\\\\\[^\\s"\'<>|]+?' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')');
        const hit = corpus.match(re);
        if (hit) f.path = hit[1];
      }
    }
    f.exists = !!(f.path && fs.existsSync(f.path));
  }
  const text = files
    .map((f) => `${f.name}  +${f.added} -${f.removed}${f.exists ? '' : '  （磁盘上没找到）'}`)
    .join('\n');
  return { ok: true, files, text, workspace: CFG.workspaceRoot || '' };
}

async function openModelList() {
  await closeMenus();
  const rect = await cdp.eval(VISIBLE_MODEL_BTN);
  if (!rect) throw new Error('找不到模型按钮（可能不在对话页）');
  await cdp.clickAt(rect.x, rect.y);
  await sleep(600);
  const row = await cdp.eval(MODEL_ROW_EXPR);
  if (row) {
    await cdp.clickAt(row.x, row.y);
    await sleep(600);
  }
  return cdp.eval(MENU_ITEMS('menuitemradio'));
}

async function listModels() {
  try {
    const items = await openModelList();
    return items.filter((i) => i.text);
  } finally {
    await closeMenus();
  }
}

async function setModel(name) {
  try {
    const items = await openModelList();
    const want = String(name).trim().toLowerCase();
    const target = items.find((i) => i.text.trim().toLowerCase() === want)
      || items.find((i) => i.text.trim().toLowerCase().startsWith(want));
    if (!target) throw new Error(`菜单里没有「${name}」`);
    await cdp.clickAt(target.x, target.y);
    await sleep(800);
    return true;
  } finally {
    await closeMenus();
  }
}

async function openModelPanelOnly() {
  await closeMenus();
  const rect = await cdp.eval(VISIBLE_MODEL_BTN);
  if (!rect) throw new Error('找不到模型按钮（可能不在对话页）');
  await cdp.clickAt(rect.x, rect.y);
  await sleep(600);
}

async function setEffort(level) {
  const levels = ['None', 'Minimal', 'Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'];
  const idx = levels.findIndex((l) => l.toLowerCase() === String(level).toLowerCase());
  if (idx < 0) throw new Error('未知档位');
  await openModelPanelOnly();
  try {
    const slider = await cdp.eval(`(() => {
      const s = [...document.querySelectorAll('[role="slider"]')].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 20 && r.y > 0 && r.y < window.innerHeight;
      });
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
    })()`);
    if (!slider) throw new Error('找不到强度滑杆');
    const frac = (idx + 0.5) / levels.length;
    await cdp.clickAt(Math.round(slider.x + slider.w * frac), slider.y);
    await sleep(500);
    return true;
  } finally {
    await closeMenus();
  }
}

async function listPermissions() {
  const rect = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Change permissions' && x.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) throw new Error('找不到权限按钮');
  await cdp.clickAt(rect.x, rect.y);
  await sleep(500);
  try {
    const items = await cdp.eval(MENU_ITEMS('menuitem'));
    return items.filter((i) => i.visible && i.text);
  } finally {
    await closeMenus();
  }
}

async function setPermission(name) {
  const rect = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Change permissions' && x.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) throw new Error('找不到权限按钮');
  await cdp.clickAt(rect.x, rect.y);
  await sleep(600);
  try {
    const items = await cdp.eval(MENU_ITEMS('menuitem'));
    const target = items.find((i) => i.visible && i.text.toLowerCase().startsWith(String(name).toLowerCase()));
    if (!target) throw new Error(`菜单里没有「${name}」`);
    await cdp.clickAt(target.x, target.y);
    await sleep(800);
    // 切到 Full access 会弹「Turn on Full Access?」确认框
    const confirmRect = await cdp.eval(`(() => {
      const dlg = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].find((d) => /Full Access|确认|Turn on/i.test(d.innerText || ''));
      if (!dlg) return null;
      const btn = [...dlg.querySelectorAll('button')].find((b) => /^(Confirm|Turn on|Enable|确认|开启)$/i.test((b.innerText || '').trim()));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (confirmRect) {
      await cdp.clickAt(confirmRect.x, confirmRect.y);
      await sleep(600);
    }
    return true;
  } finally {
    await closeMenus();
  }
}

// 桌面端的「+」按钮走的是原生文件对话框，CDP 点不动；
// 但把文件「拖」进输入框是有效的 —— 这里用 CDP 的拖放事件塞进去。
const COMPOSER_POINT = `(() => {
  const c = document.querySelector('[data-codex-composer="true"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

const ATTACH_COUNT = `(() => {
  const c = document.querySelector('[data-codex-composer="true"]');
  if (!c) return 'no-composer';
  let box = c;
  for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
  const imgs = [...box.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().width > 40).length;
  const text = (box.innerText || '').replace(/\\s+/g, ' ').trim();
  return imgs + '|' + text;
})()`;

async function attachFile(filePath) {
  const pt = await cdp.eval(COMPOSER_POINT);
  if (!pt) throw new Error('找不到输入框');
  const before = await cdp.eval(ATTACH_COUNT);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: pt.x, y: pt.y, data });
  await sleep(120);
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: pt.x, y: pt.y, data });
  await sleep(120);
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: pt.x, y: pt.y, data });
  await sleep(1500);
  let after = await cdp.eval(ATTACH_COUNT);
  if (after === before) {
    // 偶尔第一次会落空，再试一次
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: pt.x, y: pt.y, data });
    await sleep(1500);
    after = await cdp.eval(ATTACH_COUNT);
  }
  if (after === before) throw new Error('文件没能挂到输入框（可能是格式不支持）');
  return { before, after };
}

// ---------------------------------------------------------------- 页面交互脚本

// 读取页面状态：会话列表 + 当前对话 + 是否生成中
const READ_STATE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const seen = new Set();
  const threads = [];
  for (const el of document.querySelectorAll('[data-app-action-sidebar-thread-id]')) {
    const id = el.getAttribute('data-app-action-sidebar-thread-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rowText = (el.innerText || '').replace(/\\s+/g, ' ');
    threads.push({
      id,
      title: el.getAttribute('data-app-action-sidebar-thread-title') || clean(el.innerText).slice(0, 60),
      pinned: el.getAttribute('data-app-action-sidebar-thread-pinned') === 'true',
      active: el.getAttribute('data-app-action-sidebar-thread-active') === 'true',
      needsApproval: /Needs approval|需要批准|待批准/i.test(rowText),
    });
  }

  const nodes = [...document.querySelectorAll('[data-user-message-bubble], [data-markdown-text-style="assistant-message"]')];
  const messages = nodes.slice(-40).map((el) => {
    if (el.matches('[data-user-message-bubble]')) {
      return { role: 'user', text: el.innerText.trim() };
    }
    let html = el.innerHTML;
    // 丢掉 svg（复制按钮图标之类），体积能小一个量级
    html = html.replace(/<svg[\\s\\S]*?<\\/svg>/gi, '');
    return { role: 'assistant', html, text: el.innerText.trim().slice(0, 20000) };
  });

  const stopBtn = document.querySelector('button[aria-label="Stop"], button[aria-label="停止"]');
  const composer = document.querySelector('[data-codex-composer="true"]');
  const titleEl = document.querySelector('[data-app-shell-titlebar-content] span.truncate, main .truncate');
  const newChatBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'New chat');

  const visible = (b) => b && b.getBoundingClientRect().width > 0;
  // 模型按钮在输入框那一行里，用 composer 往上找容器最稳
  const composerBox = (() => {
    const c = document.querySelector('[data-codex-composer="true"]');
    if (!c) return null;
    let box = c;
    for (let i = 0; i < 8 && box.parentElement; i++) box = box.parentElement;
    return box;
  })();
  const modelBtn = composerBox
    ? [...composerBox.querySelectorAll('button')].find((x) => /DeepSeek|GPT-?5|Claude|Qwen|Grok/i.test(x.innerText || ''))
    : null;
  const compactModelBtn = [...document.querySelectorAll('button[aria-label="Select model"]')].find(visible);
  const permBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Change permissions');
  const modelLine = modelBtn ? clean((modelBtn.innerText || '').split('\\n')[0]).slice(0, 60) : '';
  const chipText = modelBtn ? clean(modelBtn.innerText || '') : '';
  const EFFORTS = ['Extra High', 'Persistent', 'Minimal', 'Medium', 'Ultra', 'Light', 'High', 'Max', 'None'];
  const effort = (EFFORTS.find((e) => new RegExp('(^|\\\\s)' + e + '($|\\\\s)').test(chipText)) || '');
  const modelName = modelLine.replace(/\\s*(None|Minimal|Light|Medium|High|Extra High|Max|Ultra|Persistent)\\s*$/i, '').trim();

  // 当前会话属于哪个工作区
  const activeThread = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]');
  let workspace = '';
  if (activeThread) {
    let cur = activeThread;
    for (let i = 0; i < 14 && cur; i++, cur = cur.parentElement) {
      const btn = cur.querySelector && cur.querySelector('button[aria-label^="Start new chat in "]');
      if (btn) { workspace = btn.getAttribute('aria-label').replace('Start new chat in ', ''); break; }
    }
  }

  // 有没有可看的改动
  const hasChanges = [...document.querySelectorAll('button')].some((b) => /View changes/i.test(b.innerText || ''));

  // 改动文件：多文件是 turn-diff-file-row，单文件只有 turn-diff-header（"Edited x.py +258 -0"）
  const changes = [];
  {
    const push = (name, a, r) => {
      const n = clean(String(name || '')).replace(/^Edited\\s+/i, '');
      if (n && !changes.some((c) => c.name === n)) changes.push({ name: n, added: Number(a), removed: Number(r) });
    };
    for (const row of document.querySelectorAll('[class*="turn-diff-file-row"], [class*="diff-file-row"]')) {
      const t = clean(row.innerText || '');
      const m = t.match(/^(.+?)\\s+(?:\\1\\s+)?\\+(\\d+)\\s*-(\\d+)$/);
      if (m) push(m[1], m[2], m[3]);
    }
    for (const h of document.querySelectorAll('[class*="turn-diff-header"]')) {
      const t = clean(h.innerText || '');
      const m = t.match(/^(?:Edited\\s+)?(.+?)\\s*\\+(\\d+)\\s*-(\\d+)/);
      if (m) push(m[1], m[2], m[3]);
    }
  }

  // 产物文件卡片（PDF/DOCX/图片…），桌面端单独渲染在正文之外
  const files = [];
  const FILE_RE = /([^\s/\\<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|zip|txt|md|csv|json|html?))\b/i;
  for (const el of document.querySelectorAll('main span, main div')) {
    const t = clean(el.innerText || '');
    if (t.length > 160 || !/Open in|Open preview|打开|预览/i.test(t)) continue;
    const m = t.match(FILE_RE);
    if (!m) continue;
    const name = m[1];
    if (!files.some((f) => f.name === name)) files.push({ name });
  }

  // 审批请求（Allow once / Deny 那张卡片）
  const allowBtn = [...document.querySelectorAll('button')].find((b) => /^(Allow once|Allow|允许)/i.test(clean(b.innerText || '')));
  const denyBtn = [...document.querySelectorAll('button')].find((b) => /^(Deny|拒绝)/i.test(clean(b.innerText || '')));
  let pendingApproval = null;
  if (allowBtn) {
    let card = allowBtn;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      card = card.parentElement;
      const t = clean(card.innerText || '');
      if (t.length > 120) break;
    }
    const text = clean(card.innerText || '');
    pendingApproval = { text: text.replace(/Allow once.*$/i, '').replace(/Deny.*$/i, '').slice(0, 240), hasDeny: !!denyBtn };
  } else if (threads.some((t) => t.needsApproval)) {
    pendingApproval = { text: '有一个会话在等你批准（点开对应会话）', hasDeny: false };
  }

  return {
    ok: true,
    threads,
    messages,
    files,
    changes,
    pendingApproval,
    generating: !!stopBtn,
    canSend: !!composer,
    title: clean(titleEl && titleEl.innerText).slice(0, 80) || '',
    model: modelName,
    effort,
    permission: permBtn ? clean(permBtn.innerText).slice(0, 40) : '',
    workspace,
    hasChanges,
    href: location.href,
    hasNewChat: !!newChatBtn,
    messageCount: messages.length,
  };
})()`;

const FOCUS_COMPOSER = `(() => {
  const c = document.querySelector('[data-codex-composer="true"]');
  if (!c) return false;
  c.focus();
  const r = document.createRange();
  r.selectNodeContents(c);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  return true;
})()`;

// ---------------------------------------------------------------- 状态缓存

let snapshot = {
  ok: false,
  bridge: 'starting',
  error: '',
  threads: [],
  messages: [],
  generating: false,
  canSend: false,
  title: '',
  updatedAt: 0,
};
let lastSerialized = '';
const clients = new Set();

function broadcast() {
  // updatedAt 每次都变，不能拿它判断“内容是否变化”，否则每 0.9 秒都会推一次，
  // 手机端跟着整段重绘，正在播放的视频会被反复销毁重建（这就是视频播不动的原因）。
  const { updatedAt, ...stable } = snapshot;
  const serialized = JSON.stringify(stable);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  const payload = JSON.stringify(snapshot);
  for (const res of clients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}

// ---------------------------------------------------------------- 自动拉起 ChatGPT

let offlineSince = 0;
let nextLaunchAt = 0;
let launching = false;

// 窄窗口时模型名读不到，退回读 ChatGPT 的配置文件
function modelFromConfig() {
  try {
    const p = path.join(os.homedir(), '.codex', 'config.toml');
    const text = fs.readFileSync(p, 'utf8');
    const m = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (!m) return '';
    const id = m[1].toLowerCase();
    const known = { 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };
    return known[id] || m[1];
  } catch {
    return '';
  }
}

// 产物文件卡片在虚拟列表里，只有滚到可见才会渲染 → 抓之前先滚到底部再还原
// 改动卡片：多文件时是 turn-diff-file-row，单文件时只有 turn-diff-header（"Edited x.py +258 -0"）
const CHANGES_EXPR = `(() => {
  const out = [];
  const push = (name, a, r) => {
    name = String(name || '').replace(/^Edited\\s+/i, '').trim();
    if (name && !out.some((c) => c.name === name)) out.push({ name, added: Number(a), removed: Number(r) });
  };
  for (const row of document.querySelectorAll('[class*="turn-diff-file-row"], [class*="diff-file-row"]')) {
    const t = (row.innerText || '').replace(/\\s+/g, ' ').trim();
    const m = t.match(/^(.+?)\\s+(?:\\1\\s+)?\\+(\\d+)\\s*-(\\d+)$/);
    if (m) push(m[1], m[2], m[3]);
  }
  for (const h of document.querySelectorAll('[class*="turn-diff-header"]')) {
    const t = (h.innerText || '').replace(/\\s+/g, ' ').trim();
    const m = t.match(/^(?:Edited\\s+)?(.+?)\\s*\\+(\\d+)\\s*-(\\d+)/);
    if (m) push(m[1], m[2], m[3]);
  }
  return out;
})()`;

async function listFiles() {
  const scroller = `(() => {
    const isGood = (d) => {
      const s = getComputedStyle(d);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 120 && /said:|Worked|You said/i.test(d.innerText || '');
    };
    return [...document.querySelectorAll('div')].filter(isGood).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  })()`;

  const before = await cdp.eval(`(() => { const s = ${scroller}; return s ? s.scrollTop : -1; })()`);
  await cdp.eval(`(() => { const s = ${scroller}; if (s) s.scrollTop = s.scrollHeight; return true; })()`);
  await sleep(900);

  const names = await cdp.eval(`(() => {
    const FILE_RE = /([^\\s/\\\\<>:"|?*]+\\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|zip|txt|md|csv|json|html?))\\b/i;
    const out = [];
    for (const el of document.querySelectorAll('span, div')) {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 160 || !/Open in|Open preview|打开|预览/i.test(t)) continue;
      const m = t.match(FILE_RE);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  })()`);

  // 同一屏里顺便把改动卡片也收了
  const changes = await cdp.eval(CHANGES_EXPR);

  // 还原本来的滚动位置，别打乱电脑上的浏览
  if (before >= 0) {
    await cdp.eval(`(() => { const s = ${scroller}; if (s) s.scrollTop = ${before}; return true; })()`);
  }

  const files = (names || []).map((name) => {
    const p = resolveFile(name);
    return { name, path: p, exists: !!(p && fs.existsSync(p)) };
  });
  return { files, changes: changes || [] };
}
function resolveFile(name) {
  const roots = [
    CFG.workspaceRoot,
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
  ].filter(Boolean);

  for (const root of roots) {
    try {
      const direct = path.join(root, name);
      if (fs.existsSync(direct)) return direct;
    } catch {}
  }

  const skip = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build']);
  let budget = 4000;
  const walk = (dir, depth) => {
    if (depth > 3 || budget <= 0) return '';
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const e of entries) {
      if (budget-- <= 0) return '';
      if (e.isFile() && e.name === name) return path.join(dir, e.name);
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue;
      const found = walk(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return '';
  };
  for (const root of roots.slice(0, 2)) {
    if (!fs.existsSync(root)) continue;
    const found = walk(root, 0);
    if (found) return found;
  }
  return '';
}

function chatgptRunning() {  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'], { encoding: 'utf8', timeout: 5000 });
    return /ChatGPT\.exe/i.test(out);
  } catch {
    return false;
  }
}

function killChatgpt() {
  try {
    execFileSync('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { stdio: 'ignore', timeout: 10000 });
  } catch {}
}

function launchChatgptDebug() {
  try {
    spawn(CFG.chatgptExe, [`--remote-debugging-port=${CFG.cdpPort}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 双击启动时，如果 ChatGPT 没带调试端口就自动重启它；
 * 完全没启动就直接带参启动。90 秒内只尝试一次，避免反复杀进程。
 */
async function ensureChatgpt() {
  if (!CFG.autoLaunchChatgpt) return false;
  if (launching) return false;
  if (Date.now() < nextLaunchAt) return false;
  launching = true;
  nextLaunchAt = Date.now() + 90_000;
  try {
    if (chatgptRunning()) {
      console.log('  [自动] ChatGPT 在跑但没开调试端口，正在带参重启…');
      killChatgpt();
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      console.log('  [自动] ChatGPT 没在运行，正在带参启动…');
    }
    const ok = launchChatgptDebug();
    console.log(ok ? `  [自动] 已拉起，等它加载（约 40 秒）：${path.basename(CFG.chatgptExe)}` : '  [自动] 启动失败');
    snapshot.error = '正在启动 ChatGPT（约 40 秒）…';
    snapshot.bridge = 'starting';
    broadcast();
    return ok;
  } finally {
    launching = false;
  }
}

async function refresh() {
  const connected = await cdp.ensure();
  if (!connected) {
    const now = Date.now();
    if (!offlineSince) offlineSince = now;
    // 离线超过 8 秒就尝试自动拉起（首次启动时也给 ChatGPT 一点时间）
    if (now - offlineSince > 8000) ensureChatgpt().catch(() => {});
    const next = {
      ...snapshot,
      ok: false,
      bridge: 'offline',
      error: launching || now - offlineSince > 8000
        ? (snapshot.error || `ChatGPT 没带调试端口，正在自动拉起…`)
        : '正在连接 ChatGPT…',
      updatedAt: now,
    };
    snapshot = next;
    broadcast();
    return next;
  }
  offlineSince = 0;
  try {
    const prevGenerating = !!snapshot.generating;
    const prevCount = snapshot.messages?.length || 0;
    const state = await cdp.eval(READ_STATE, 8000);
    if (Array.isArray(state.messages)) {
      state.messages = state.messages.map((m) => (m.role === 'assistant' ? { ...m, html: rewriteMedia(m.html) } : m));
    }
    // 窄窗口时模型/权限会收成图标，读不到文字；这时保留上一次的值，别把界面刷成空白
    const merged = { ...snapshot, ...state, ok: true, bridge: 'online', error: '', updatedAt: Date.now() };
    // 窄窗口读不到模型名时保留上一次的值；配置文件里的 model 不一定和界面对得上，不用它兜底
    if (!state.model) merged.model = snapshot.model;
    if (Array.isArray(state.files) && state.files.length) {
      merged.files = state.files.map((f) => {
        const p = f.path || resolveFile(f.name);
        return { ...f, path: p, exists: !!(p && fs.existsSync(p)) };
      });
    } else {
      merged.files = snapshot.files || [];
    }
    if (!state.permission) merged.permission = snapshot.permission;
    if (!state.workspace) merged.workspace = snapshot.workspace;
    snapshot = merged;

    // 一轮任务刚结束 → 自动抓一次产物（这时视图通常就在底部，滚动代价很小）
    if (prevGenerating && !merged.generating && (merged.messages?.length || 0) > prevCount) {
      setTimeout(() => {
        listFiles().then((r) => {
          if (r.files?.length) snapshot.files = r.files;
          if (r.changes?.length) snapshot.changes = r.changes;
          broadcast();
        }).catch(() => {});
      }, 1200);
    }
  } catch (e) {
    snapshot = { ...snapshot, ok: false, bridge: 'error', error: e.message, updatedAt: Date.now() };
  }
  broadcast();
  return snapshot;
}

// ---------------------------------------------------------------- HTTP

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('文件太大（上限 200MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req, url) {
  const header = req.headers['x-token'];
  if (header && header === CFG.token) return true;
  if (url.searchParams.get('t') === CFG.token) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `dsh_token=${CFG.token}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, rel) {
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB) || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const LOCK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#0e1013" />
<title>配对 ChatGPT 手机端</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1013;color:#e7e9ee;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
  .card{width:100%;max-width:360px;text-align:center}
  h1{font-size:19px;margin:0 0 6px}
  p{color:#9aa3b2;font-size:14px;margin:0 0 22px}
  input{width:100%;padding:16px;font-size:28px;letter-spacing:.35em;text-align:center;border-radius:14px;
        border:1px solid #262b33;background:#16191e;color:#fff;outline:none;font-variant-numeric:tabular-nums}
  input:focus{border-color:#4b67b4}
  button{width:100%;margin-top:14px;padding:15px;border:0;border-radius:14px;background:#4b67b4;color:#fff;font-size:16px}
  button:disabled{opacity:.5}
  .err{color:#ff9d99;font-size:14px;min-height:20px;margin-top:10px}
  .hint{margin-top:26px;font-size:12px;color:#5f6774;line-height:1.7}
</style></head>
<body><div class="card">
  <h1>连接这台电脑</h1>
  <p>输入电脑上显示的 6 位配对码</p>
  <form id="f">
    <input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" autofocus />
    <button id="go" type="submit">连接</button>
  </form>
  <div class="err" id="err"></div>
  <div class="hint">配对码在电脑的黑色窗口里，形如「配对码：123456」。<br />一次配对，之后打开就不用再输。</div>
</div>
<script>
  const f = document.getElementById('f');
  const pin = document.getElementById('pin');
  const err = document.getElementById('err');
  const go = document.getElementById('go');
  pin.addEventListener('input', () => { pin.value = pin.value.replace(/\\D/g, ''); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: pin.value }) });
      const d = await r.json();
      if (d.ok) location.replace('/');
      else err.textContent = d.error || '配对码不对';
    } catch { err.textContent = '连不上电脑'; }
    go.disabled = false;
  });
</script>
</body></html>`;

// ---------------------------------------------------------------- 公网隧道（移动数据用）

let publicUrl = '';
let tunnelProc = null;
let tunnelWanted = false;

function writeQrPng(url) {
  try {
    const py = `import qrcode\nqrcode.make(${JSON.stringify(url)}).save(${JSON.stringify(path.join(ROOT, '配对二维码.png'))})\n`;
    spawn('python', ['-c', py], { stdio: 'ignore' }).on('error', () => {});
  } catch {}
}

function openQr() {
  if (!CFG.openQr) return;
  try {
    spawn('cmd', ['/c', 'start', '', path.join(ROOT, '配对二维码.png')], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

function tailscaleIp() {
  const candidates = ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 4000 }).trim().split(/\r?\n/)[0].trim();
      if (/^100\.\d+\.\d+\.\d+$/.test(out)) return out;
    } catch {}
  }
  return '';
}

// tailscale serve 已经挂上 443 的话，优先用 https://<机器名>.<tailnet>.ts.net
function tailscaleServeHost() {
  for (const bin of ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale']) {
    try {
      const raw = execFileSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 4000 });
      const json = JSON.parse(raw);
      const web = json?.Web;
      if (!web) continue;
      for (const key of Object.keys(web)) {
        const host = String(key).replace(/:443$/, '');
        if (/\.ts\.net$/.test(host)) return host;
      }
    } catch {}
  }
  return '';
}

// 有 Tailscale 就优先用它：地址固定、端到端加密，不用担心 URL 变化
function preferTailscale() {
  const host = tailscaleServeHost();
  const ip = tailscaleIp();
  if (!host && !ip) return false;
  const url = host ? `https://${host}` : `http://${ip}:${CFG.port}`;
  if (publicUrl === url) return true;
  publicUrl = url;
  console.log('');
  console.log('  Tailscale 内网地址（永久固定）：');
  console.log(`    ${url}`);
  console.log('  二维码已更新：配对二维码.png');
  console.log('');
  writeQrPng(`${url}/?t=${CFG.token}`);
  openQr();
  snapshot.publicUrl = url;
  broadcast();
  tunnelWanted = false;
  try { tunnelProc?.kill(); tunnelProc = null; } catch {}
  return true;
}

function startTunnel() {
  if (!CFG.tunnel) return;
  const bin = CFG.cloudflared;
  if (!bin || !fs.existsSync(bin)) {
    console.log('  [隧道] 找不到 cloudflared，只能用局域网地址');
    return;
  }
  try { tunnelProc?.kill(); } catch {}
  tunnelWanted = true;
  tunnelProc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${CFG.port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== publicUrl) {
      publicUrl = m[0];
      const full = `${publicUrl}/?t=${CFG.token}`;
      console.log('');
      console.log('  外网地址（移动数据可用，每次重启会变）：');
      console.log(`    ${publicUrl}`);
      console.log('  二维码已更新：配对二维码.png');
      console.log('');
      writeQrPng(full);
      openQr();
      snapshot.publicUrl = publicUrl;
      broadcast();
    }
  };
  tunnelProc.stdout.on('data', scan);
  tunnelProc.stderr.on('data', scan);
  tunnelProc.on('exit', () => {
    publicUrl = '';
    snapshot.publicUrl = '';
    if (tunnelWanted) setTimeout(startTunnel, 6000);
  });
  tunnelProc.on('error', () => {});
}

// 配对尝试限流：同一 IP 15 分钟内最多 12 次（暴露到公网后必须防爆破）
const pairTries = new Map();
function pairAllowed(ip) {
  const now = Date.now();
  for (const [k, v] of pairTries) if (now > v.reset) pairTries.delete(k);
  let rec = pairTries.get(ip);
  if (!rec) { rec = { n: 0, reset: now + 15 * 60 * 1000 }; pairTries.set(ip, rec); }
  rec.n += 1;
  return rec.n <= 12;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 首次带 token 访问 → 种 cookie 并去掉 URL 里的 token
  if (url.pathname === '/' && url.searchParams.get('t') === CFG.token) {
    res.writeHead(302, {
      location: '/',
      'set-cookie': `dsh_token=${CFG.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    });
    return res.end();
  }

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, bridge: snapshot.bridge });

  // 给 APK 的后台服务用：拿到 token 后自己轮询，不依赖网页 JS
  if (url.pathname === '/api/token') return json(res, 200, { ok: true, token: CFG.token });

  // 手机浏览器直接下载 APK：https://<地址>/apk
  if (url.pathname === '/apk') {
    const file = path.join(ROOT, 'ChatPig手机助手.apk');
    const legacy = path.join(ROOT, 'ChatGPT手机端.apk');
    const use = fs.existsSync(file) ? file : legacy;
    if (!fs.existsSync(use)) return json(res, 404, { error: '还没有打包 APK' });
    const stat = fs.statSync(use);
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': stat.size,
      'content-disposition': 'attachment; filename="chatpig-mobile.apk"',
      'cache-control': 'no-store',
    });
    return fs.createReadStream(use).pipe(res);
  }

  // 配对：手机输入 6 位码换 cookie
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'x').toString();
    if (!pairAllowed(ip)) return json(res, 429, { ok: false, error: '尝试太频繁，过一会儿再试' });
    const { pin } = await readBody(req);
    if (String(pin || '').trim() !== CFG.pin) return json(res, 401, { ok: false, error: '配对码不对' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `dsh_token=${CFG.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 没配对：首页给配对页，其它资源照常（配对页不需要它们）
  if (url.pathname === '/' && !authorized(req, url)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(LOCK_HTML);
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/events' || url.pathname === '/media') {
    if (!authorized(req, url)) return json(res, 401, { error: '未配对' });
  }

  // 代理桌面端引用的本地图片/视频/文件（app://fs/@fs/...）
  if (url.pathname === '/media') {
    const p = url.searchParams.get('p') || '';
    if (!p) return json(res, 400, { error: '缺少 p 参数' });
    let file = p;
    try { file = path.normalize(decodeURIComponent(p)); } catch {}
    if (!path.isAbsolute(file) || !fs.existsSync(file)) return json(res, 404, { error: '文件不存在' });
    const stat = fs.statSync(file);
    if (!stat.isFile()) return json(res, 404, { error: '不是文件' });
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const download = url.searchParams.get('dl') === '1';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(range));
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
      ...(download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` } : {}),
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.pathname === '/api/state') {
    if (snapshot.updatedAt === 0) await refresh();
    return json(res, 200, snapshot);
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    const { threadId } = await readBody(req);
    try {
      const clicked = await cdp.eval(`(() => {
        const el = document.querySelector('[data-app-action-sidebar-thread-id=' + JSON.stringify(${JSON.stringify(String(threadId))}) + ']');
        if (!el) return false;
        el.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      await refresh();
      return json(res, 200, { ok: !!clicked, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/new' && req.method === 'POST') {
    try {
      const clicked = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'New chat' || (x.innerText || '').trim() === 'New chat');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 900));
      await refresh();
      return json(res, 200, { ok: !!clicked, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 会话操作：置顶 / 取消置顶 / 归档
  if (url.pathname === '/api/thread/action' && req.method === 'POST') {
    const { threadId, action } = await readBody(req);
    const map = { pin: 'Pin chat', unpin: 'Unpin chat', archive: 'Archive chat' };
    const label = map[action];
    if (!label) return json(res, 400, { ok: false, error: '未知操作' });
    try {
      const result = await cdp.eval(`(() => {
        const id = ${JSON.stringify(String(threadId))};
        const label = ${JSON.stringify(label)};
        const row = document.querySelector('[data-app-action-sidebar-thread-id="' + id + '"]');
        if (!row) return 'no-row';
        const scopes = [row, row.parentElement, row.closest('div.contents') || row.parentElement];
        for (const scope of scopes) {
          if (!scope) continue;
          const btn = [...scope.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
          if (btn) { btn.click(); return 'clicked'; }
        }
        return 'no-btn';
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      await refresh();
      return json(res, 200, { ok: result === 'clicked', result, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 手机传文件 → 落到电脑上的 uploads/ → 挂到 ChatGPT 输入框
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    try {
      const rawHeader = String(req.headers['x-filename'] || 'upload.bin');
      let rawName = rawHeader;
      try { rawName = decodeURIComponent(rawHeader); } catch {}
      const buf = await readRaw(req);
      if (!buf.length) return json(res, 400, { ok: false, error: '空文件' });
      const dir = path.join(ROOT, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const safe = rawName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-80) || 'upload.bin';
      const dest = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(dest, buf);
      await attachFile(dest);
      await refresh();
      return json(res, 200, { ok: true, name: safe, size: buf.length, path: dest, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/projects') {
    try {
      return json(res, 200, { ok: true, items: await listProjects(), current: await cdp.eval(CURRENT_WORKSPACE_EXPR) });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/workspace' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
    try {
      await switchWorkspace(String(name));
      return json(res, 200, { ok: true, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/files') {
    try {
      const r = await listFiles();
      snapshot.files = r.files;
      if (r.changes.length) snapshot.changes = r.changes;
      broadcast();
      return json(res, 200, { ok: true, files: r.files, changes: r.changes });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    const { action } = await readBody(req);
    try {
      const clicked = await cdp.eval(`(() => {
        const deny = ${JSON.stringify(String(action))} === 'deny';
        const re = deny ? /^(Deny|拒绝)/i : /^(Allow once|Allow|允许)/i;
        const b = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').replace(/\\s+/g, ' ').trim()));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await sleep(900);
      await refresh();
      return json(res, 200, { ok: !!clicked, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/changes') {
    try {
      return json(res, 200, await readChanges());
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/models') {
    try {
      return json(res, 200, { ok: true, items: await listModels(), current: snapshot.model || '' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/model' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
    try {
      await setModel(String(name));
      snapshot.model = String(name);
      await refresh();
      return json(res, 200, { ok: true, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/effort' && req.method === 'POST') {
    const { level } = await readBody(req);
    try {
      await setEffort(String(level || ''));
      await refresh();
      return json(res, 200, { ok: true, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/permissions') {
    try {
      return json(res, 200, { ok: true, items: await listPermissions(), current: snapshot.permission || '' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/permission' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
    try {
      await setPermission(String(name));
      snapshot.permission = String(name);
      await refresh();
      return json(res, 200, { ok: true, state: snapshot });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const { text } = await readBody(req);
    if (!text || !String(text).trim()) return json(res, 400, { error: '内容为空' });
    try {
      const focused = await cdp.eval(FOCUS_COMPOSER);
      if (!focused) return json(res, 409, { error: '输入框不可用（可能不在对话页）' });
      await cdp.insertText(String(text));
      await new Promise((r) => setTimeout(r, 250));
      await cdp.pressEnter();
      setTimeout(() => { refresh().catch(() => {}); }, 600);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    try {
      const clicked = await cdp.eval(`(() => {
        const b = document.querySelector('button[aria-label="Stop"], button[aria-label="停止"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      setTimeout(() => { refresh().catch(() => {}); }, 400);
      return json(res, 200, { ok: !!clicked });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 兜底：ChatGPT 没带调试端口时，由 bridge 关掉再带参拉起（会中断正在进行的工作）
  if (url.pathname === '/api/relaunch' && req.method === 'POST') {
    try {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { stdio: 'ignore' });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
      await new Promise((r) => setTimeout(r, 2500));
      spawn(CFG.chatgptExe, [`--remote-debugging-port=${CFG.cdpPort}`], { detached: true, stdio: 'ignore' }).unref();
      // ChatGPT 启动要 30–60 秒
      return json(res, 200, { ok: true, note: '已重新拉起，约 40 秒后可用' });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html');
  return serveStatic(res, url.pathname.replace(/^\/+/, ''));
});

// ---------------------------------------------------------------- 启动

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

server.listen(CFG.port, '0.0.0.0', () => {
  const ips = lanAddresses();
  const bar = '  ' + '-'.repeat(46);
  console.log('');
  console.log('  ChatPig 手机助手已启动');
  console.log(bar);
  for (const ip of ips) console.log(`  手机打开：  http://${ip}:${CFG.port}`);
  console.log(`  配对码：    ${CFG.pin}`);
  console.log(bar);
  console.log(`  本机自测：  http://127.0.0.1:${CFG.port}/?t=${CFG.token}`);
  console.log(`  调试端口：  ${CFG.cdpPort}`);
  if (CFG.tunnel) console.log('  正在建立外网隧道（cloudflared）…');
  console.log('');
  refresh().catch(() => {});
  // 有 Tailscale 就不折腾隧道；没有就走 Cloudflare 快速隧道
  if (!preferTailscale()) startTunnel();
  setInterval(() => { if (!/^http:\/\/100\./.test(publicUrl)) preferTailscale(); }, 30000);
});

setInterval(() => { refresh().catch(() => {}); }, 900);

// 退出时收掉隧道进程，别留孤儿
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    try { tunnelProc?.kill(); } catch {}
    if (sig === 'exit') return;
    process.exit(0);
  });
}
