# daily-work-hub（M0 骨架）

日常工作台的 DeepSeek Harness 插件骨架：**装上去能看到侧栏图标和一个整页面板，并从 Host 拿到 ping**。业务功能（GitLab 轮询、审查队列、一键 AI 审查、提示词/技能）尚未实现，按 `DESIGN.md` 的里程碑 M0→M4 逐步补。

## 文件

```
daily-work-hub/
  package.json          # dsh.bundle.patch + dsh.client(platform: web, immediately: true, inject: [])
  cordis.patch.yml      # 一行 insert：id: daily-work-hub, config: { instance, pollIntervalSec }
  index.js              # Host：apply(ctx, config)、Config、DEFAULTS、精确路由 GET /api/daily-work/ping
  client/client.js      # Client：plain-JS 动态 bundle，sidebar.panellist 图标行 + main['daily-work-hub'] 整页
  locale/zh.json        # meta.title / meta.description
  locale/en.json
  icon.svg              # 原创单色图标（currentColor，托盘 + 未读点）
  README.md
```

## 这个骨架证明什么

1. Host 半能在裸 `webServer` 上注册 `GET /api/daily-work/ping`，并在入口用 `ctx.connection.requestRejection` 自己把住 401/403/503 —— exact 路由会**绕过** `/api` 前缀栅栏，所以必须自守（dshmarket 同款做法）。
2. Client 半能用 plain-JS 动态 bundle 注册 `main`（keyed 整页）+ `sidebar.panellist`（图标行，工厂收到 `{size, active}`）。
3. 面板能 `fetch` 到那条路由，读到 `version` / `instance` / `pollIntervalSec` / `time` —— 面板 ↔ Host 数据通道成立。

认证策略：**fail-closed**。取不到 `connection` 或其 `requestRejection` 时返回 `503 connection-unavailable`，不降级放行（放行等于把未来的 GitLab PAT 暴露给任意本机网页请求）。

## 安装（本阶段不要执行）

```text
plugin_manager(
  action: "install_bundle",
  target: "D:\\Documents\\GitHub\\daily-work\\plugin\\daily-work-hub"
)
```

- 目标用**绝对目录**；`replace: false`。新 bundle 可经 HMR 激活；替换已安装包才需重启。
- 装完在 Plugin Manager / Settings 里确认标题为「日常工作台」、图标已渲染。

## 装完怎么自测 ping

1. 刷新页面：左侧栏出现「日常工作台」行（托盘图标 + 右上小点），`order: 1` 决定它在面板列表中的位置。
2. 点它：中央区整页打开面板，标题右侧徽标应为**已连通**；表格出现 `version = 0.1.0`、`instance = default`、`pollIntervalSec = 60s`、`Host 时间`。
3. 点「重新检测」：`Host 时间` 更新。
4. 徽标 **未连通 · HTTP 401** → 路由在，但浏览器登录 cookie 不在：先打开 `dsh web` 启动时打印的带 token 网址登录，再刷新。
5. 徽标 **未连通 · HTTP 503 `connection-unavailable`** → 宿主没有 `connection` 服务，路由按 fail-closed 拒绝。
6. 命令行等价（同源、带 cookie）：

```powershell
curl.exe -s -H "Cookie: <粘贴 cookie>" http://127.0.0.1:43129/api/daily-work/ping
# 期望 {"ok":true,"version":"0.1.0","time":"...","instance":"default","pollIntervalSec":60,"method":"GET"}
```

DevTools Console 也可直接 `await (await fetch('/api/daily-work/ping')).json()`。

## 已验证（本次自检，可复现）

| 项 | 命令 | 结果 |
|---|---|---|
| Host 语法 | `node --check index.js` | exit 0 |
| Client 语法 | `node --check client/client.js` | exit 0 |
| Host 可加载 | `import('./index.js')` | 导出 `Config,DEFAULTS,VERSION,apply,inject,name`；`name=daily-work-hub`；`inject=["webServer"]` |
| 清单可解析 | `JSON.parse(package.json)` | 成功；`name/version/private/type`、`exports`、`dsh.bundle.patch`、`dsh.client` 齐全 |
| UTF-8 源 | `node -e` 直读 | 中文 `meta.description` 正常（无乱码、无替换字符） |
| 本地化可解析 | `JSON.parse(locale/zh.json, locale/en.json)` | 成功，`meta.title`/`meta.description` 均为真实文案 |
| patch YAML 可解析 | `js-yaml.load(cordis.patch.yml)`（用 profile 里的 js-yaml） | `[{"insert":[{"id":"daily-work-hub","name":"daily-work-hub","config":{"instance":"default","pollIntervalSec":60}}]}]`，`row_ok=true` |
| 图标可用 | 读 `icon.svg` | `svg ok=true`，474 bytes，含 `currentColor`，根元素/闭合正确 |
| 默认值 | `DEFAULTS` / `normalizeConfig()` | `{"instance":"default","pollIntervalSec":60}`；非法值回落，`pollIntervalSec` 下限 15s |
| 接口对齐 | 代码检查 | 路由 `/api/daily-work/ping` 与客户端 `api('api/daily-work/ping')`（`document.baseURI` 相对解析）指向同一位置 |

## 未验证（必须装上去才知道）

1. **Desktop 宿主下自定义路由可达性**：`dsh-app://` 与 `http://127.0.0.1` 两种载入方式对 cookie 行为不同（`DESIGN.md` §14 的 R1）。
2. **`requestRejection` 的真实判定**：401/403/放行三态是否与浏览器 cookie 对得上。
3. **槽位接受度**：侧栏行与 `main` key 是否被接受、图标 16/18px 是否清晰、`order: 1` 的实际位置。
4. **`layout` 可选性**：卸载清理用 `ctx.get('layout')` 保护，未在真实切换/动画下压测。
5. **`Config` 是否激活**：见下节。

## 已知约束：链接安装下 `Config` 为 `undefined`

> **2026-11-08 更新（实测推翻）**：本机用 `install_bundle` 指向目录时，实际走的是 **generation 安装**（先装进 staging，再 promote），`@deepseek-ai/schemastery` 因此**可解析**，`Config` 已生效——`Config.listConfigs` 返回 `status: schema`，且投影出 `instance` 默认 `default`、`pollIntervalSec` 默认 `60`（`minimum: 0`）。
> 也就是说：**下面这段「链接安装 → Config undefined」只适用于真正的符号链接安装，本机不是**。保留原文只为记录当时的判断与原因。

- `Config` 通过**可选** `import('@deepseek-ai/schemastery')` 获得，解析成功才生成 schema，否则 `undefined`。
- 原因：本机 profile 的 `node_modules` 只有已安装 bundle，无 `@deepseek-ai/*`；`install_bundle` 对本地目录是**链接**安装，不安装该目录依赖。
- 本机效果：Loader 视作"无 schema"，`config` 原样传入 → **`DEFAULTS` + `normalizeConfig()` 承担默认值**（与 `cordis.patch.yml` 初值一致）。
- 打包后安装（`npm pack` → `install_bundle` 指向 tarball）时，声明的可选 peer `@deepseek-ai/schemastery` 会被装上，`Config` 生效，settings 表单与 patch 校验随之可用。
- 取舍：M0 优先「可安装、不炸」，不为一个表单 vendor 第三方包。

## 安装实测结果（2026-11-08，本机）

| 项 | 实测 |
|---|---|
| `install_bundle` 指向 `D:\Documents\GitHub\daily-work\plugin\daily-work-hub` | `application: applied`，`version 0.1.0`，`warnings: []`；generation 安装 667ms |
| 已装文件 | `index.js`、`client/client.js`、`cordis.patch.yml`、`package.json`、`icon.svg`、`locale/{zh,en}.json`、`README.md`（8 个，全部到位） |
| Host 行是否激活 | 是。`Config.listConfigs` 能列出 `include:daily-work-hub`，`status: schema` |
| `Config` schema | 生效。`instance` 默认 `default`；`pollIntervalSec` 默认 `60`，`minimum 0` |
| `main` 槽占用者 | `plugins` / `conversation` / `desktop-workbenches` / `schedules` —— **尚无 `daily-work-hub`** |
| `sidebar.panellist` 占用者 | `plugins` / `schedules` —— **尚无 `daily-work-hub`** |
| 结论 | **Host 半边已通；Client 半边还没被页面加载**（新 bundle 不走 HMR，需要刷新页面一次） |

**下一步验证（1 分钟）**：刷新 Harness 页面 → 左侧栏应出现「日常工作台」行 → 点开应显示 `ping ok` 或明确的 401/503。刷新后如果仍无该行，看 DevTools Console 是否有 `daily-work-hub` 相关报错，再回报。

**回滚**：`plugin_manager(action: "remove_bundle", target: "daily-work-hub")`。本插件不写 profile 以外状态，M0 无 timer。

## 卸载 / 回退

Plugin Manager 移除 bundle 即可。本插件不写 profile 以外状态，M0 不注册 timer / 后台任务，路由由 `ctx.effect` 管，卸载即摘；面板若是当前选中项，清理函数会先 `selectPanel(null)` 再摘 `main` 条目，避免中央区留空 key。

## 自检输出（原样粘贴）

```text
=== 1) node --check index.js ===
exit=0
=== 2) node --check client/client.js ===
exit=0
=== 3) import index.js ===
exports=Config,DEFAULTS,VERSION,apply,inject,name
name=daily-work-hub
inject=["webServer"]
Config=undefined
DEFAULTS={"instance":"default","pollIntervalSec":60}
exit=0
=== 4) JSON parse: package.json / locale/zh.json / locale/en.json ===
package.json OK keys=name|version|private|type|description|icon|exports|files|dsh|peerDependencies|peerDependenciesMeta
locale/zh.json OK keys=meta
locale/en.json OK keys=meta
name=daily-work-hub version=0.1.0 private=true type=module
exports=.,./index,./client,./cordis.patch.yml,./locale/*.json,./icon,./package.json
dsh.bundle.patch=./cordis.patch.yml dsh.client={"platform":"web","immediately":true,"inject":[]}
locale.zh.meta={"title":"日常工作台","description":"面向开发者的整页工作台：GitLab MR 与 Issue 收件箱、审查队列、一键 AI 审查，以及提示词与技能管理。"}
exit=0
```

## 下一步（M1）

1. 装一次，按上面 1–6 步自测 ping，把 401/503/200 真实结果补进「未验证」。
2. 加 `storageDomain`（`items`/`prompts`/`audit`）与 `credentials`（GitLab PAT）。
3. 再做一键 AI 审查：`ctx.agents.create()` + `agent.followup()`，面板按钮从占位改为真实调用，并用 `layout.selectPanel(null)` 回到 Conversation 看流式输出。