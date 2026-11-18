// 服务已在运行时：确认 ChatGPT 连上，没连上就拉起它
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const base = `http://127.0.0.1:${cfg.port}`;
const headers = { 'x-token': cfg.token };

try {
  const st = await (await fetch(`${base}/api/state`, { headers, signal: AbortSignal.timeout(8000) })).json();
  if (st.ok) {
    console.log('  ChatGPT 已连上：' + (st.title || '（当前会话）'));
    process.exit(0);
  }
  console.log('  ChatGPT 没连上（' + (st.error || '未知原因') + '），正在拉起…');
  await fetch(`${base}/api/relaunch`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  console.log('  已请求重新拉起，约 40 秒后可用。');
} catch (e) {
  console.log('  查不到服务状态：' + e.message);
}
