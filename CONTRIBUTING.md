# 参与贡献

先说清楚：**这个项目的核心功能依赖对游戏社区接口的非公开调用，本身处在灰色地带。**
所以合并任何改动前，我们更看重「不把风险放大」，其次才是功能多少。有想法建议先开 issue 讨论。

## 开发环境

- Windows x64（本工具只做 Windows；`schtasks` / 注册表 / DPAPI 都是 Windows 专属）
- Node.js ≥ 18，npm
- 无 TypeScript、无打包器、无 lint 配置——源码就是可直接运行的 CommonJS JavaScript

```bat
cd 签到助手
npm install
npm start
```

## 代码约定

- **CommonJS**（`require` / `module.exports`），`'use strict';` 开头。
- 框架与插件都**不引入运行时依赖**：只用 Node 内置模块（`https`、`crypto`、`fs`、`path`）。开发/构建依赖只有 `electron`、`electron-builder`、`7zip-bin`。
- 界面与注释一律中文；标识符用英文。
- 注释写「为什么」不写「是什么」，并且**注释里的事实断言必须可复核**（是实测结论就写清实测时间与依据，别写「官方风控」「已弃用」这类没有出处的归因）。
- 渲染进程零 Node 权限：任何新能力都要经 `preload.js` 的白名单通道走 IPC，主进程 `main.js` 的 `IPC_CHANNELS` 与 preload 的 `INVOKE_CHANNELS`/`EVENT_CHANNELS` 必须完全一致（`test-consistency` 会检查）。
- 只有列在 `core/game-registry.js` 转发白名单里的插件导出会被框架取用；新增框架级钩子要同时改那份白名单。
- 用户可见文案不要用行话（本工具面向不懂编程的用户）。

## 测试

改完必须跑（都在 `签到助手/` 下）：

```bat
npm run test:core
```

三合一：`test-consistency`（IPC 白名单/字典单源 + 全量 JS 语法门禁）、`test-registry`（插件注册表校验）、`test-core`（storage / logger / notify / runner / scheduler / qqbot 逻辑层）。

```bat
npm run test:refs
```

只读体检：核对 Run 自启键 / 计划任务 / 桌面与开始菜单快捷方式 / 通知激活器 CLSID 这 4 处是否都指向当前版本的 exe。**删改交付目录或系统引用前后都要跑**；报 FAIL 就跑 `npm run release:relink` 再复检。

```bat
npm run smoke
```

协议与注册表冒烟。**默认不联网跑真实签到**：需要真实凭据的用例会因为找不到配置而 SKIP（凭据路径由 `SMOKE_KURO_CONFIG` / `SMOKE_MIHOYO_CONFIG` / `SMOKE_TAJIDUO_CONFIG` 三个环境变量指定，都是本地 JSON 文件）。加 `--full`（`npm run smoke:full`）才会真的调官方接口发签到请求，**别在别人的账号上跑**。

```bat
npm run selftest
```

应用内自检。建议隔离数据目录，别碰你自己的正式数据：

```bat
npx electron . --selftest --data-dir=%TEMP%\signin-app-selftest
```

> 注意：`scripts/` 不会被打进 `app.asar`，`--selftest` 只适用于从源码目录运行；打包版里会提示「仅限开发目录」。

## 插件（新游戏脚本）

- 契约见 [脚本开发规范](签到助手/docs/脚本开发规范.md)，最小字段：`id`、`name`、`loginMethods`、`signin`。
- 每种登录方式都要给 `help`（官方网址 + 分步操作说明）；面向小白的工具，帮助文案是功能的一部分。
- `signin` 返回里带上 `accountName`（签到日历和日报靠它显示昵称）。
- **绝不**把 token / Cookie / 手机号明文写进日志、`console`、报错文案或返回值 `lines`（框架会兜底脱敏，但别依赖它）。
- 需要两阶段标识（如米哈游 `actionType`）时必须放在返回值的 `sessionData` 字段里，框架只读那一个字段。
- 提 PR 时请说明：测过哪台系统版本、用的哪种登录方式、以及**你自己承担该接口调用带来的账号风险**。

## 提交与版本

- 提交信息带类型前缀：`fix:`（修 bug）/ `feat:`（加功能）/ `docs:`（文档）/ `chore:`（杂项），中文描述。
- 语义化版本（`签到助手/package.json` 的 `version`）：修 bug 末位加一，加功能中位加一，重大改动首位加一。
- 一个 PR 只做一件事；行为变更和格式化分开提。
- 版本达到可交付状态时打 tag（`vX.Y.Z`）并在 Release 里写清更新内容与风险。

## 不要提的东西

- 绕过验证码 / 风控的代码（本项目对极验只做「检测到了就提示用户走官方 App」，不做破解）。
- 任何形式的多用户凭据集中托管、代签服务。
- 把用户凭据发往第三方服务器的功能。
