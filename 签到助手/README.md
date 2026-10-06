# 游戏社区签到助手 · 框架源码（`签到助手/`）

Windows x64 桌面应用（Electron + 原生 JavaScript，中文界面）。**框架本身不内置任何游戏脚本**，签到能力全部由「脚本插件」提供。

本仓库自带的三款官方插件在仓库根的 [`脚本/`](../脚本)（鸣潮/崩铁/异环，中文文件夹名），随包交付、放进去即自动加载。

> 面向使用者的说明（下载、教程、风险与免责声明）在仓库根的 [README.md](../README.md)；
> 开发约定、测试与提交规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)；
> 凭据如何处理见 [SECURITY.md](../SECURITY.md)。本文件只讲框架源码这层。

## 目录结构

```
签到助手/
├── main.js                 # 主进程：窗口/托盘/单实例/IPC/登录编排/schtasks/QQ 日报
├── preload.js              # contextBridge 白名单桥（渲染进程零 Node 权限）
├── renderer/               # 界面：账号管理 / 签到日历 / 通知设置 三页 + 登录弹窗
├── core/                   # 逻辑层
│   ├── storage.js          # 数据目录、设置与凭据（DPAPI 加密，含明文降级标记）
│   ├── runner.js           # 单账号执行与结果落盘、出口统一脱敏
│   ├── scheduler.js        # 内置定时器与三级时间（账号→游戏→全局）调度
│   ├── game-registry.js    # 插件扫描/校验/转发白名单（kind 词汇表 KINDS 在此）
│   ├── browser-login.js    # gui 类登录的本地页面服务
│   ├── login-gui.html      # 上面对应的登录页（短信 / 粘贴）
│   ├── notify.js           # Server酱 / PushPlus / 企业微信 / SMTP 告警
│   ├── qqbot.js            # QQ 机器人日报（HTTPS 主动消息 + 绑定时临时 WebSocket）
│   ├── redact.js           # 凭据样式值脱敏（日志与界面共用）
│   ├── proc-output.js      # reg/schtasks 输出的 GBK 兼容解码
│   └── logger.js           # 运行日志与每日结果文件、一年保留策略
├── scripts/                # 只用于开发/发布，不会进 app.asar
│   ├── test-consistency.js # IPC 白名单与共享字典单源 + 全量 JS 语法门禁
│   ├── test-registry.js    # 插件注册表校验
│   ├── test-core.js        # storage/logger/notify/runner/scheduler/qqbot 逻辑层
│   ├── check-system-refs.js# 4 处系统引用只读体检
│   ├── smoke.js            # 协议/注册表冒烟（--full 会跑真实签到）
│   ├── selftest.js         # 应用内自检（仅源码目录可用）
│   ├── rebuild-unpacked.js # 构建 dist/win-unpacked（含图标/版本注入与产物自检）
│   └── release.js          # 一键发版：构建 → 组装 → 7z → 重链系统引用 → 清理旧版
├── build/icon.ico          # 应用图标
├── docs/脚本开发规范.md     # 插件契约（写给开发者，也写给 AI）
└── dist/                   # 构建产物（不进 Git）
```

## 开发与验证

以下命令**都在本目录（`签到助手/`）下执行**：

```bat
npm install                       # 只装开发依赖：electron / electron-builder / 7zip-bin
npm start                         # 从源码启动（脚本目录取仓库根的 脚本/）

npm run test:core                 # 一致性 + 注册表 + 核心层三合一（每次改动后必跑）
npm run test:refs                 # 只读体检：Run 自启键 / 计划任务 / 快捷方式 / 通知 CLSID
npm run smoke                     # 协议 / 注册表冒烟（npm run smoke:full 会跑真实签到）
node scripts/rebuild-unpacked.js  # 只构建 win-unpacked，不碰系统引用
npx electron . --selftest --data-dir=%TEMP%\signin-app-selftest
```

单独跑某一层：`node scripts/test-consistency.js`、`node scripts/test-registry.js`、`node scripts/test-core.js`。

发版走一键脚本 `npm run release`（= `node scripts/release.js`）：构建 → 在工作区根组装
`游戏社区签到助手-免安装版-v<版本>/` → 打同名 7z → 把 4 处系统引用重链到新 exe → 清理更早版本目录 → 输出自检。
只改路径/引用、不重建产物时用 `npm run release:relink`。

⚠️ **release 脚本会写注册表、创建计划任务与快捷方式**（这是它存在的理由：目录换代后不重链会导致开机自启失效、
计划任务指向已删目录）。在别人机器上试用本仓库时，只想看构建产物就别跑它，改用 `node scripts/rebuild-unpacked.js`。

打 7z 需要一个 7z 可执行文件：优先用工作区根的 `工具/7zr.exe`，没有就自动改用开发依赖 `7zip-bin` 自带的 7za，
两者都没有时脚本会明确报错（或用 `npm run release -- --no-7z` 跳过压缩）。

## 插件契约

见 [docs/脚本开发规范.md](docs/脚本开发规范.md)。插件最少要导出 `id`、`name`、`loginMethods`、`signin` 四项；
只有列在 `core/game-registry.js` 转发白名单里的函数名会被框架取用。

## 安全边界

- 渲染进程零 Node 权限：`contextIsolation` + `sandbox` + `preload.js` 白名单 IPC。
- 凭据与通知密钥用 safeStorage（Windows DPAPI）加密落盘。**safeStorage 不可用时会降级为明文存储并在该条凭据上标
  `plain: true`**，界面会显示加密状态——别把「一定加密」当绝对前提。解密失败则标 `_decryptFailed`，不会静默丢账号。
- 日志与界面对 `title`/`lines` 逐条脱敏（`core/redact.js`）后再落盘/上屏。
- 系统计划任务只操作 `签到助手-*` 前缀，不碰其它任务。
- 插件 = 主进程本机代码（`require` 执行，无沙箱），只装可信来源。
