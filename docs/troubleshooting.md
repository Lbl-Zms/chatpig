# 排错

## 手机打不开页面

按顺序排查：

1. **电脑上的服务还在吗？** 窗口里应该有输出；`Get-NetTCPConnection -LocalPort 8787` 能看到监听
2. **手机连的是 Tailscale 还是同一 Wi-Fi？**
   - 用 Tailscale：手机上 Tailscale 要处于开启状态（通知栏有 VPN 图标），电脑上 `tailscale status` 能看到手机
   - 用局域网：校园网/公司网可能开了「客户端隔离」，这时改成 Tailscale
3. **防火墙**：`allow-firewall.cmd` 跑过吗

## 手机显示「正在启动 ChatGPT…」/「连不上调试端口」

ChatPig 要求 ChatGPT 带 `--remote-debugging-port=9222` 启动。

- 双击 `start.cmd`，它会自动关掉重开（**正在跑的任务会中断**）
- 还不行就看 ChatGPT 是不是停在启动 logo：它冷启动要 30–60 秒

不想让它自动重启 ChatGPT：`config.json` 里 `autoLaunchChatgpt: false`。

## 页面打开是空白 / 消息不动

- 会话开着但内容是空的：等 ChatGPT 把界面画出来
- 消息不动：电脑上那条任务可能被审批卡住了，看手机输入框上方有没有提示条，或者电脑上有没有 `Allow once / Deny`

## 通知不弹

- **浏览器版**：需要 HTTPS（Tailscale 的 https 域名就是）+ 授权通知；iOS 要「添加到主屏幕」后才有推送
- **APK**：
  1. 系统设置里给 ChatPig 开通知权限
  2. 保持那条「ChatPig 正在后台盯着任务」的常驻通知存在（删掉它服务就停了）
  3. 国产 ROM（小米/vivo/OPPO/华为/荣耀）还要单独放行「自启动」「后台运行」「电池无限制」
- 提醒是 15 秒轮询一次，不是秒级

## 产物文件显示「电脑上没找到」

卡片是从界面抓的，路径是猜的：

1. 在 `config.json` 里配 `workspaceRoot`（比如 `"D:\\code\\myproject"`），会优先在里面找
2. 也会在 `Downloads` / `Desktop` / `Documents` 里找（最多 3 层）
3. 都找不到就只会显示文件名——去电脑上用「Open in」自己看

## 点「改动」看到的是文件内容，不是 diff

这是设计如此：桌面端的 diff 面板是虚拟列表，逐行提取不稳定，所以给的是**文件清单 + 文件当前内容**。要真 diff，可以让 ChatGPT 自己跑 `git diff` 并把输出贴出来。

## 切模型/权限没反应

- 电脑窗口很窄（或者开了 Changes 侧栏）时，模型按钮会缩成图标，读不到当前值；点开菜单能看到 ✓ 标在哪个上
- 菜单是两级的：先点一次面板里的「模型行」才会展开模型列表

## APK 装不上

- 自签名 APK 要允许「安装未知来源应用」
- 如果之前装过**别的签名**的版本，先卸载
- `android/keystore.jks` 丢了的后果就是这个——重新生成后只能卸载重装

## 桌面端更新后读不到内容

ChatPig 靠 DOM 选择器读界面。桌面端大改版可能让选择器失效。

所有选择器都集中在 `server.mjs` 的 `READ_STATE` 和 `CHANGES_EXPR` 里，改一处即可。调试方法：电脑上打开 `http://127.0.0.1:9222`（ChatGPT 的调试端口）看实际结构。

## 端口被占用

改 `config.json` 里的 `port`（比如 8788），重启服务，手机地址跟着换。
