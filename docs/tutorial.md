# 完整教程

从零到手机能用，大约 15 分钟（不含下载）。

---

## 一、电脑端

### 1. 装 Node.js

到 [nodejs.org](https://nodejs.org/) 下 LTS 版，装完在 PowerShell 里确认：

```powershell
node --version    # 需要 v22 或更高
```

### 2. 确认 ChatGPT 桌面版

开始菜单里能搜到「ChatGPT」，装的是 Microsoft Store 的 **OpenAI Codex** 应用（`ChatGPT.exe`）。

ChatPig 需要它以调试端口启动，服务会自动处理，但前提是**它得装在这台电脑上**。

### 3. 启动 ChatPig

```powershell
cd chatpig
node server.mjs
```

第一次运行会生成 `config.json`，并在窗口里打印地址和配对码。

想让它顺便把 ChatGPT 拉起来（带调试端口），双击 `start.cmd` 也一样，而且更省事：它会先看 ChatGPT 有没有带调试端口，没有就重启它。

> **注意**：第一次启动 Node 时 Windows 可能弹防火墙提示，选「允许（专用网络）」。没弹或点错了，用管理员 PowerShell 跑一次：
> ```powershell
> netsh advfirewall firewall add rule name="ChatPig" dir=in action=allow protocol=TCP localport=8787
> ```
> 或者直接双击 `allow-firewall.cmd`。

---

## 二、手机怎么连

### 方案 A：同一个 Wi-Fi（最简单，但只在家/宿舍）

先在电脑上查 IP：

```powershell
ipconfig | findstr IPv4
```

手机浏览器打开 `http://<那个IP>:8787`，输入窗口里的 6 位配对码。

> 校园网/公司网常开「客户端隔离」，开着就互相访问不到；这时用方案 B。

### 方案 B：Tailscale（推荐，手机用移动数据也能连）

1. 电脑和手机都装 [Tailscale](https://tailscale.com/download)，登录**同一个账号**
2. 电脑上执行一次：

```powershell
tailscale serve --bg 8787
```

3. 手机上打开它给的地址（形如 `https://你的机器名.xxxx.ts.net`），输配对码

地址固定不变，而且端到端加密。想随时查地址：`tailscale serve status`。

### 加到主屏幕

- **Android / Chrome**：菜单 →「添加到主屏幕」/「安装应用」
- **iPhone / Safari**：分享 →「添加到主屏幕」

---

## 三、自己打 APK

APK 不是必须的（浏览器版功能一样），但想要**原生后台通知**就得装它。

### 1. 准备工具链（一次性，约 300 MB）

在 `android/` 下建 `toolchain/`，把三样东西放进去：

```
android/toolchain/
├── jdk/jdk-17.x/               ← 解压的 JDK 17（版本号随意，脚本自动探测）
├── buildtools/android-14/      ← Android build-tools 34
└── platform/android-34/android.jar
```

下载（国内可用清华镜像 / Google 官方）：

| 组件 | 地址 |
|---|---|
| JDK 17 | https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/ |
| build-tools 34 | https://dl.google.com/android/repository/build-tools_r34-windows.zip |
| platform 34 | https://dl.google.com/android/repository/platform-34-ext7_r03.zip |

两个 zip 解开后会得到 `android-14`（build-tools）和 `android-14`（platform），把**后者里面的 `android.jar`** 放到 `platform/android-34/`。

最终 `build-apk.cmd` 需要这三个路径都存在：

```
toolchain\jdk\<任意 JDK 17>\bin\javac.exe
toolchain\buildtools\android-14\aapt2.exe
toolchain\platform\android-34\android.jar
```

### 2. 打包

```bat
cd android
build-apk.cmd
```

产物在项目根目录：`ChatPig手机助手.apk`。

第一次会自动生成 `android/keystore.jks`（签名用）。**这个文件要自己留好**：换掉它就没法覆盖安装，只能卸载重装。

### 3. 装到手机

- 把 APK 传到手机（微信/数据线/`https://<你的地址>/apk` 都行——服务会自动提供下载）
- 允许「安装未知来源应用」
- 首次打开会让你填**服务器地址**，就是第二步那个网址

---

## 四、日常使用

1. 双击桌面 `start.cmd`（或 `node server.mjs`）
2. 手机打开 ChatPig（主屏图标 / APK）
3. 电脑上的 ChatGPT 会被自动带调试端口拉起（约 40 秒）

想让它开机自动跑：把 `start.cmd` 的快捷方式丢进 `shell:startup` 就行。

---

## 五、出了问题看这里

见 [troubleshooting.md](troubleshooting.md)。
