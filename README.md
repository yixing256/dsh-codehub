# dsh-codehub

> **代码用法学习源，不是代码搬运器。**
> 从 GitHub / Gitee / CSDN 检索并深读真实代码，产出的永远是**学习笔记**（实现思路、API 用法、
> 取舍、踩坑），不是可以直接粘贴进用户项目的代码文件。返回结构里的 `is_verbatim_copy`
> 恒为 `false`，`code` 字段仅作学习参考展示，不得作为交付物转述。

---

## 它解决什么问题

需要「某个库/框架到底怎么用、接口契约是什么、别人踩过哪些坑」时，agent 通常只能靠记忆或通用
搜索。本插件给 agent 一个**受约束的**代码来源：能查、能读、能对比，但**拿不到可以直接落盘的
交付物形态**。

**它做什么** —— 总结实现思路、提炼 API 用法、对比不同实现取舍、记录踩坑笔记。

**它不做什么** —— 不 clone 仓库、不把远端文件写进你的项目、不把抓到的片段原样粘贴、
不生成「直接抄来的函数 / 文件」当交付物、不执行任何远端代码（无 `eval`，不 spawn 远端脚本）、
不内置任何代理。

### 防搬运是机制，不是叮嘱

`CodeLearnResult.is_verbatim_copy` 的类型是**字面量 `false`**（不是 `boolean`）：

```ts
readonly is_verbatim_copy: false
```

没有任何可赋给该字段的值能表示「这是一份允许的直接复制」，所以**不存在构造出 `true` 的代码
路径**。配套：`code` 经统一出口截断（默认 4000 字符）、渲染时强制打「仅学习参考 · 不得直接
粘贴进用户项目」横幅、深读产出的是结构化**思路笔记**而非文件副本。

同一段防搬运声明**同时**写进 agent tool 的 description 和系统提示词段，两处引用
`src/contract.ts` 里同一个 `ANTI_COPY_STATEMENT` 常量 —— 不是两份内容相同的副本。

---

## 切勿提交 `.env` / local 配置

- `.env`、`.env.*`、`*.local.yml`、`*.local.json`、`*.token`、`*.key`、`*.pem`、
  `credentials.json`、`secrets.*` **一律不入库**（`.gitignore` 已冻结这些条目）。
- 仓库里只允许存在**模板**：`.env.example`（值全空）、`config.example.yml`（占位值）。
- 任何真实 token / cookie / 代理凭据只能通过 DSH 凭证服务或本机环境变量提供。
- 提交前自查：`git status --porcelain` 里不应出现 `.env`、`*.local.yml`、`*.token`。

**token 存放位置（三重策略）**

| 数据 | 存哪 | 绝不 |
|---|---|---|
| GitHub / Gitee token、CSDN cookie | DSH 凭证服务（`ctx.credentials`） | 不进 schema、不进 profile patch、不进日志、不回显对话 |
| 本机代理地址（敏感但非密钥） | `$DSH_HOME/dsh-codehub.json`（权限 `0600`） | 不进仓库 |
| 仓库里的模板 | `config.example.yml` / `.env.example` | 不含任何真实值 |

---

## 安装

使用这个插件**不需要** `pnpm install`，也**不需要**构建：

- DSH 直接加载已发布的 `lib/` 产物（`lib/index.mjs` 为 host 入口，`lib/client.js` 为 web 客户端入口）。
- 仓库里的 `node_modules/`、`lib/` 属于开发期产物，已被 `.gitignore` 忽略。
- Node 版本要求：`^22.19.0 || >=24.0.0`（本机实测 v24.19.0）。

### 装进 DSH

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者是一个**顶层 YAML 数组**
（空文件或只有注释会被解析成 `null` 并拒绝）：

```yaml
- insert:
    - id: dsh-codehub
      name: dsh-codehub
```

把包放进 profile 的 `node_modules/` 并让该 bundle 生效后，插件提供：

- **service** `ctx.codeSource` —— 供其他插件调用
- **agent tool** `learn_code_from_web` —— 供 agent 主动查询
- **侧边栏入口 + 设置页** —— 默认两处都显示：侧边栏顶部是 GitHub 猫标 + `codehub`，
  点开是完整面板；设置页里是同一份表单。放哪由插件设置里的「显示位置」控制，保存一次即生效。

### 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit，严格模式，是正确性的权威门禁
pnpm run build       # tsc 声明产物 + tsdown 双入口 + scripts/wrap-client.mjs
pnpm test            # vitest —— 488 例
pnpm run verify      # 交付验收：SDK 表面 → 产物 → 两端座位 → 提交卫生
pnpm run verify:sdk  # 单独查：src/ 里每个「值」导入在真机运行时是否真的存在
pnpm run verify:hygiene # 单独查：可提交文件里没有凭据 / 本地覆盖 / 你的配置快照
pnpm run boot-check  # 真实启动一个 profile，确认插件真的挂上（见下）
pnpm run smoke       # 真实端点连通性读数（需网络，刻意不进 test）
```

各命令的分工不要混：

| 命令 | 回答的问题 | 会漏掉什么 |
|---|---|---|
| `typecheck` | 类型对不对 | 运行期行为；**手写的 SDK shim 写错时它也会跟着错** |
| `test` | 行为对不对（488 例，**零网络**） | **类型错误**（vitest 只转译不做类型检查） |
| `verify:sdk` | 导入的 SDK 名字在**真机运行时**存不存在 | 语义（名字在但行为变了） |
| `verify` | **产物**里该有的东西在不在、两端座位能不能注册并渲染 | 逻辑正确性 |
| `verify:hygiene` | 这次提交会不会带上**你的**凭据或配置 | 逻辑正确性（它只管"别把私货提交上去"） |
| `boot-check` | 插件在**真实加载器**里能不能挂上 | 无断言，只给读数 |
| `smoke` | 真端点通不通 | 无断言，只给读数 |

> **为什么必须有 `verify:sdk`**：本插件曾在 `typecheck` / `build` / `test` **全绿**的情况下
> 于真机上「点开什么都没有」—— 浏览器半边按 0.1.5 时代的名字导入了
> `IconPlusOutline16` / `IconCloseOutline16` / `IconRefreshOutline16` /
> `IconChevronDownOutline14`，而真机是 **DSH 0.2.0-rc.2**，图标的命名约定已改成
> `Icon<Name>Outline{Medium|Regular}`。这些导入在运行期是 `undefined`，渲染
> `<undefined />` 会抛错，于是**面板和设置节同时变空白**，而侧边栏那行（纯内联 SVG、
> 不用任何 SDK 图标）却正常 —— 这种「一半好用一半空白」最容易看成一团谜。
> `typecheck` 之所以放行，是因为手写的 `types/dsh/index.d.ts` 本身就抄错了。
> 现在：图标由插件自己画（`src/client/icon.tsx`），SDK shim 不再声明任何 `Icon*`，
> `verify:sdk` 直接读 `app.asar` 里的真包逐个核对，座位外面还套了渲染护栏
> （`src/client/error-boundary.tsx`），出错时显示可读信息而不是空白。
>
> **为什么必须有 `boot-check`**：本插件还曾在同一种「全绿但真机不可用」里栽过 —— `learn_code_from_web`
> 的 `output.schema` 用了语法糖 `required: true`，而运行时的 schema 校验器**拒绝**该写法并
> **中止整个工具注册**。单测全部注入假 transport、从不经过真实加载器，所以完全看不到。
> **只有真启动会走那道校验。** 改动工具 schema、插槽注册或服务挂载后，请跑一次
> `pnpm run boot-check <profile>`。

`pnpm test` 与 `pnpm typecheck` **不可互相替代**：`@ts-expect-error` 的「是否被使用」、`satisfies` 是否成立、`readonly` 违规这三类防线**只有 typecheck 守**（esbuild 转译会把它们全擦掉），而运行期断言只有 test 守。

`build` 三步各有分工，不要跳过第三步：`tsdown` 把客户端半边编成 CommonJS 中间产物，
`scripts/wrap-client.mjs` 再把它包进 DSH 客户端模块加载器要求的
`window.__ModuleLoader__.load({ id, factory })` 闭包工厂。**模块体被延迟进 `factory`**，
loader 真正实例化时才执行 —— 这也意味着 `require(...)` 调用不会污染页面全局环境。

---

## 接口稳定性

- **CSDN** —— `CSDN v3 搜索接口为非官方内部接口（非公开 API），实测日期 2026-10-03，字段与可用性可能随时失效；失效时请改用 CSDN 网页搜索或关闭该源。`
  该端点不是文档化的公开 API，随时可能改字段或下线。插件把失败归类为
  `empty` / `parse-failed` / `not-code` 并在 `reason` 里带上这条来源说明，**不为它编造字段**。
- **GitHub** —— `api.github.com` 官方 REST，稳定。但见下方「已验证事实」：本机 raw 域名不可直连。
- **Gitee** —— 官方 v5 REST，稳定。**但 v5 没有代码搜索端点**：`GET /api/v5/search/code` 实测
  **返回 404（HTML「页面不存在」）**，本插件不再为它构造任何请求；仓库搜索匿名返回空数组（需要
  token）；公开仓库文件内容匿名可读；网页版代码搜索需要登录。原文见
  [`src/contract.ts`](./src/contract.ts) 的 `GITEE_LOGIN_REQUIREMENT` 常量。

---

## 本机代理

- 本机代理 / SOCKS5 设置的作用范围：**仅 Node 直连传输生效**。
- 走 DSH 自带 web 通道时由 Harness 负责出网，本插件无法为其注入代理。

插件有两条出网通道，代理地址只能左右其中一条：

| 通道 | 是什么 | 受本机代理设置影响 |
|---|---|---|
| `dsh-web` | Harness 自带的 web 服务（**默认优先**） | **否** —— 出网由 DSH 负责 |
| `node` | 本插件进程内的 `fetch` | **是** —— 代理在这里生效 |

> **注意作用域的实际后果**：`node` 通道在**当前这台机器**上时通时不通（见「已验证事实」的两次
> 实测对比），所以本机代理设置在这里**不保证产生效果**：只有 `node` 通道真的能出网时它才有意义。
> 插件不会为了「让代理生效」而偷偷改走别的通道。

配置项是 `github.localProxy`，单个地址字符串。**协议从地址本身解析，没有独立字段**：

| 你填 | 解析为 |
|---|---|
| `127.0.0.1:7890` | `http://127.0.0.1:7890`（无协议前缀时按 HTTP 处理） |
| `http://host:port` | HTTP 代理 |
| `https://host:port` | HTTPS 代理 |
| `socks5://host:port` | SOCKS5 代理（`socks5h://` 亦可，按 socks5 处理） |

支持 `user:pass@` 形式的代理认证（该地址只存本机 `0600` 文件，不进仓库、不进日志）。

**SOCKS4 会被明确拒绝**，并且**不发起请求、也不绕过代理静默直连** —— 插件宁可失败也不在你
不知情的情况下裸奔。界面上的该控件 label 与 help 都会写明「仅 Node 直连传输生效」这条适用范围。

**Watt Toolkit（原名 Steam++，官网 [steampp.net](https://steampp.net)）**：插件**不自带**、
也**不内置**任何代理。界面只提示你可以安装 Watt Toolkit 并在「网络加速」里勾选 GitHub，
插件会检测系统代理 / Hosts 是否已生效 —— 检测到不等于启用，仍需你主动勾选访问方式。

---

## GitHub 访问方式（必须由你主动选择）

插件**不会**替你决定走哪条路，也**不会**默认偷偷开。八个方式分四档风险，每档都标注了前置
条件与风险：

| 风险 | 方式 | 携带 token |
|---|---|---|
| 稳定 | 官方直连 API | 是 |
| 稳定 | GitHub Token 登录 | 是 |
| 稳定 | Watt Toolkit | 是 |
| 临时 | 网页 / API 代理（ghproxy、ghfast.top 等） | 否 |
| 临时 | raw 文件镜像（仅文件下载用） | 否 |
| 临时 | 本机代理 / SOCKS5 | 是 |
| 不推荐 | Hosts / DNS 优化（不硬编码过期 IP） | 是 |
| 有隐私风险 | 第三方镜像站 | 否 |

**token 与镜像互斥是硬约束**，不是界面提示：把长期凭据交给第三方转发站就是凭据泄露，所以
镜像路径会在构造请求时被强制剥离 token。

---

## 已验证事实

本机（Windows + Node v24.19.0）实测结论，写死在此以免后人重复踩坑。

### 通道可达性：会变，所以每次都实测

2026-10-03 的实测是「`node` 直连三个源全部 `fetch failed`」，而**同一台机器上** Harness 自己的
`web_fetch`（即 `dsh-web` 通道）能拿到 `api.github.com` HTTP 200。当时的结论是：

> **`dsh-web` 是本机唯一可用的出网通道。** 插件默认优先 `dsh-web`、失败才回落 `node`
> 的设计因此不是偏好问题，而是**本机的硬约束**。

**2026-10-04 复测推翻了其中一半**：从本进程直连时 `api.github.com`（HTTP 200）、
`gitee.com`（HTTP 200）、`so.csdn.net`（HTTP 200）都可达，只有 `github.com` 与
`raw.githubusercontent.com` 仍是 TCP 443 超时（Harness 的 `web_fetch` 打 `github.com` 同样失败）。

所以结论要按「会变的事实」来用：

> **两条通道都可能通、也都可能不通。** 插件因此不把任何一条写死：仍默认优先 `dsh-web`、
> 失败回落 `node`，并在 OAuth 之前做一次**运行期可达性预检**，把「这条主机现在通不通」
> 当成读数而不是常量。

### 端点可达性（2026-10-04 复测）

| 目标 | 经 `dsh-web` 通道 | 经 `node` 直连 |
| --- | --- | --- |
| `api.github.com` | **可达**（HTTP 200） | **可达**（HTTP 200） |
| `github.com`（授权页/令牌页所在主域） | 不可达（`fetch failed`） | **不可达**（TCP 443 超时） |
| `raw.githubusercontent.com` | 曾被观测到 HTTP 200 | 不可达 |
| `gitee.com` | 可达 | **可达**（HTTP 200） |
| `so.csdn.net` | 可达 | **可达**（HTTP 200） |
| `blog.csdn.net` 文章页 | — | 带 UA/Referer 时 200，缺头部时偶发 HTTP 521 |

### 接口形态（与可达性无关，是服务端行为）

| 端点 | 实测结果 |
| --- | --- |
| `gitee.com/api/v5/projects?q=...` | 返回 **404** —— 该接口不存在，禁止为它编造响应字段 |
| `gitee.com/api/v5/search/repositories?q=...` | HTTP 200，但**匿名返回空数组**（需 token） |
| `gitee.com/api/v5/search/code?q=...` | **404（HTML 页面不存在）** —— v5 没有代码搜索端点，本插件不使用它 |
| `gitee.com/api/v5/repos/{owner}/{repo}/contents/{path}` | HTTP 200，公开仓库**匿名可读** |
| `api.github.com/search/code?q=...`（匿名） | **401 `Requires authentication`** —— 查代码必须 token |
| `so.csdn.net/api/v3/search?...` | HTTP 200，`result_vos[]` 有真实数据；30 条里约 6 条带 `body`，且**没有 `originalType` 字段** |
| `blog.csdn.net` 文章页 | HTTP 200 且含真实 `<pre>` 代码块（实测 19 个）；缺 UA/Referer 时 HTTP **521** |

> Gitee 真实存在的搜索端点是 `/search/repositories`（需 `access_token`）。网上常见资料里写的
> `/api/v5/projects?q=...` 实测 404，本插件不使用；`/search/code` 同样 404，而且这次不是
> 「需要登录」——**端点根本不存在**。

### 怎么复核这些结论

```bash
pnpm run smoke
```

该脚本**刻意不进 `pnpm test`**：它依赖网络、会被限流、并打一个非公开 API。它输出的是
**读数而非断言** —— 失败可能意味着端点搬了、机器离线或没配凭据，这些都是有用的事实而不是
构建坏了。

---

## 决策点：插件永不替你拍板

下面每一项都有「未配置」状态。**未配置时 agent tool 会拒绝执行、且不发任何网络请求**，
转而返回一句可以直接转达给你的问题。

| 决策点 | 控件 | 未配置时 |
|---|---|---|
| 三源查询优先级 | 拖拽排序 | 拒绝，问「你想按 GitHub→Gitee→CSDN 还是别的顺序查？」 |
| GitHub 访问方式 | 分风险档勾选 + 排序 | 拒绝，问「你本机开了 Watt Toolkit 还是配了代理？」 |
| 失败自动降级 | 三态开关 | 未定 → 拒绝（**不默认开**） |
| 多源合并 | 三态开关 | 未定 → 拒绝（**不默认合并**） |
| Gitee 登录 | 登录弹窗 | 无 token 时允许只打公开端点，空结果标 `auth-required` |
| CSDN 登录 | 登录弹窗 | 匿名搜索，受限结果降低可信度 |
| 镜像源列表 | 界面增删改 | **不预填任何数据**；空 = 该方式不可用，不兜底 |
| 本机代理地址 | 输入框 | 未填 = 该方式不可用 |
| 超时 / 重试 | 数字输入 | 有默认值（15s / 2 次），属偏好而非决策点 |
| 递归深度 / 最大条目 | 数字输入 | 硬顶封顶，防无限递归 |
| 深度阅读目标 | 多选 | 未选 = 只做浅搜索 |

「未决策」与「答了 false」是两回事：`false`（「不要降级」）是**有效答案**，必须与
`undefined`（「还没问」）区分开。

### 显示位置：默认两处都显示

默认 `entryPlacement: 'both'`，**不弹任何首次选择对话框**。要改就在插件设置页（或侧边栏
面板）最上面的「显示位置」里选，然后点「保存显示位置」：

- **侧边栏面板** —— 侧边栏靠上位置显示 GitHub 猫标 + `codehub`
- **设置页** —— 设置里增加一节「DSH CodeHub 设置」
- **侧边栏 + 设置页（默认）** —— 两处都显示（两者数据同源，天然同步）

座位跟随**已保存**的配置：点单选框本身不会动界面，保存成功后立即重新注册，不用重载页面。

---

## 登录与凭据获取（手把手）

本插件的设置页里有一个**单独的获取向导**（点「获取向导」打开），按平台逐步告诉你：为什么需要、
打开哪个页面、填什么、粘回哪里、点哪个按钮验证。向导把取凭据的方式分成**两族、明显分开**：

| 族 | 包含 | 特征 |
|---|---|---|
| **① 浏览器登录（OAuth）** | GitHub 设备码、Gitee 授权码 | 浏览器完成授权，token 由插件直接写进凭据服务——你不需要看到、也不需要复制任何密钥 |
| **② 令牌 / Cookie 手动导入** | 个人访问令牌（PAT）、Cookie 手动粘贴、Cookie CDP 抓取（实验性） | 你从浏览器复制一段值粘回来；适合不想注册 OAuth 应用、或平台根本没有 OAuth 的情况 |

- 每个方式是一张可选卡片（带「令牌 / Cookie」种类徽标），**点一下就地切换**，不用关窗重开；切换会清空上一个方式留下的所有输入框。
- CSDN **没有 OAuth**，向导会直接写明这一点，只列手动导入（不会假装有一个浏览器登录入口）。
- 内容多于一个窗口时**正文滚动**，「关闭」按钮固定在滚动区之外，永远点得到。

下面是同一份内容的文字版。

| 源 | 能不能 OAuth | 怎么做 | 兜底 |
|---|---|---|---|
| GitHub | **能**（设备码流程，不需要 client_secret） | 在你自己账号下建一个 OAuth App，**勾选 Enable Device Flow**，把 Client ID 填进插件；点「浏览器登录」后会出现一个 8 位用户码，在 `https://github.com/login/device` 输入即可 | 个人访问令牌（fine-grained 预填链接，读公开内容无需任何权限） |
| Gitee | **能，但必须 client_secret**（Gitee 不支持 PKCE、也不支持设备码） | 建一个 Gitee 第三方应用，把插件显示的回调地址**原样登记**进去，把 Client ID 填配置、Client Secret 存凭据服务；授权后浏览器跳回本机自动完成 | 私人令牌；或授权后手动把地址栏里的 `code` 粘回来 |
| CSDN | **不能**（CSDN 没有 OAuth，`open.csdn.net` 并不存在） | 一键打开登录页，从 DevTools → Network 复制 `Cookie` 请求头粘回来（`document.cookie` 看不到 HttpOnly 的会话 cookie） | 实验性：点**「启动调试浏览器」**——插件自己找到 Chrome/Edge，用独立配置目录带调试端口启动，并把登录页打开；你登录后回来点「读取 Cookie」（默认关闭、需显式同意） |

三条硬约束：

1. **插件不内置任何第三方 client_id**。复用一个不属于你的应用身份（例如 GitHub CLI 的 client_id）
   在 GitHub 的使用条款下属于冒充风险，本插件不做。
2. **能自动就自动，不能自动就说清楚**。GitHub/Gitee 的 token 由 host 侧直接写入 DSH 凭据服务，
   **不经过浏览器**；界面只显示「已配置 / 未配置」。
3. **client_secret / token / cookie 只进 `ctx.credentials`**，不进配置文件、不进 git、不回显、
   不写日志。

> 实测提醒：在**本机**，`github.com` 主域 TCP 443 连接超时（同一时刻 `api.github.com` 可达），
> 所以 GitHub 的授权页/登录页在这里可能打不开。插件在开始流程前会先做可达性预检，不可达时直接
> 告诉你原因和替代路径（配代理/Watt 后重试，或在能访问 GitHub 的设备上生成 PAT 再粘贴），
> 而不是转圈之后给你一个看不懂的报错。

---

## 查代码是否需要登录：实测矩阵

`LOGIN_REQUIREMENT_PROBED_AT` = **2026-10-04**，在本机实测。面板里的「连通性与登录要求」卡会显示
同一张表，失败行的下面直接写着失败原因。

| 操作 | GitHub | Gitee | CSDN |
|---|---|---|---|
| 匿名可达 | ✅ `api.github.com` 200 | ✅ `gitee.com` 200 | ✅ `so.csdn.net` 200 |
| 仓库/文章搜索 | ✅ 匿名可用 | ⚠️ 匿名返回**空数组**（需要 token） | ✅ 匿名 30 条（仅 6 条带正文） |
| 读公开文件内容 | ✅ 匿名可用 | ✅ 匿名可用 | —（没有文件概念） |
| **查代码** | ❌ **必须 token**（匿名 `/search/code` → HTTP **401**） | ❌ **v5 没有该端点**（`/search/code` → HTTP **404**；网页代码搜索需登录） | ⚠️ 搜索接口不带正文，**需要打开文章页**；文章页缺 UA/Referer 时被 HTTP **521** 反爬拦截，登录 cookie 可提高成功率 |
| OAuth | ✅ 设备码流程 | ✅ 授权码（必须 secret） | ❌ 没有 |

**站点策略披露**：`so.csdn.net/robots.txt` 声明 `Disallow: /`（该主机不允许自动抓取）。
本插件只在你的显式操作下发起单次请求，不做爬取、不批量遍历；`blog.csdn.net/robots.txt` 是
`Allow: /`。

---

## 连通性检测怎么读

「运行匿名自检」只打**公开端点、不带任何凭据**（token / cookie 都不会发出），结果渲染成三行固定
状态，不是一个 JSON 文档：

```
GitHub     ● 连通     HTTP 200 · 812ms · dsh-web
Gitee      ● 失败     HTTP 404 · 1204ms · node
           失败原因：Gitee v5 没有 /search/code 端点（实测 404）…
CSDN       ○ 未检测
```

- 三行恒定出现（GitHub / Gitee / CSDN），没测过的显示「未检测」，**顺序与返回顺序无关**。
- 成功行给 HTTP 状态码、延迟与所用通道；**失败行的下一行直接给失败原因**，可一键复制。
- 「用已保存凭据验证」是另一个按钮：只有你点它，才会带着已存凭据发一次校验请求
  （GitHub/Gitee 用 `/user` 判断 200/401；CSDN 没有官方校验接口，用匿名/带 cookie 的抽样对比，
  并如实告诉你有没有观察到改善）。

---

## 配置保存后你会看到什么

**默认自动保存，而且能关**：改完暂停约 0.7 秒自动写入 host，防抖把一串连续编辑合并成**一次**写入
（不会每个按键发一次请求，也不会让「本次修改」的行数失去意义）。保存栏常驻在表单底部（`sticky`），
**自动保存的开关就在这个栏里**（`自动保存` 复选框，存在 `ui.autoSave`），不用去别处找：

| 自动保存 | 状态文案 | 右侧按钮 |
|---|---|---|
| 开 | `改好了，正在自动保存…` | **立即保存** —— 有改动即可点，点一下立刻落地（不必等防抖） |
| 开 | `已自动保存 · 3 项改动 · 12:01:02` | 没有待写内容时按钮置灰（这是它唯一该灰的时候） |
| 关 | `有未保存的改动（自动保存已关闭）` | **保存到 host** —— 唯一的写入方式 |
| 关 | `已保存到 host · 3 项改动` | 手动保存的结果 |
| 任意 | `与 host 配置一致` | 无待写内容 |

- **写入失败不会吞掉你的改动**：草稿保留、仍标记为待保存、错误就地显示，按钮可重试。
- **关掉自动保存会取消已经排期的写入**：不会出现「我刚关掉它，它还是偷偷写了一次」。取消这个动作本身
  只写一次「自动保存=关」这个设置（文案显示「已保存自动保存设置」，不会伪装成自动保存又跑了一遍）。
- **host 不认识这个设置时不会静默改回「开」**：那是插件未重新加载时的表现。此时本页保持你的选择，
  保存栏会说明「当前 host 不认识自动保存设置……重启 DSH 后可持久化」，而不是把复选框偷偷拨回去。
- 「撤销改动」同样先取消已排期的写入，再回到 host 的值。
- 把某个值改回原样不算改动，不会产生一次写入。

另外，保存成功后**第一眼看到的是「我保存了什么」**，而不是「我还缺什么」：

- 顶部摘要卡按 host 回读的值逐行列出当前配置（源优先级顺序、GitHub 访问方式、自动降级、多源合并、
  账号状态、镜像数量、本机代理、关键上限、深读目标、显示位置），本次改动过的行标「本次修改」。
- 「开始使用前还差 N 项」在**保存栏上方**，可折叠；N=0 时只剩一行
  `4/4 已就绪，learn_code_from_web 可直接执行`；每条都能就地定下来（排序项有「填入推荐顺序」，
  两个开关直接给「开/关」）。
- 措辞描述的是**系统要求**（「还差 2 项」「未提供」），不是你的缺失。
- 可选未配项（token、镜像、代理、CSDN 登录）**不会**出现在任何「未完成」清单里，只在各自控件
  旁边内联显示「未配置」。

---

## 目录结构

```
src/
├─ contract.ts           契约常量（插件身份、备注文案、统一返回类型、决策点定义、登录/实测事实）
├─ index.ts              host 半边入口（service + tool + routes + 提示词段 + OAuth 接线）
├─ config.ts             schemastery 配置 schema（设置表单由此自动派生）
├─ gating.ts             决策点门禁：未决策 → 拒答 + 零网络请求
├─ tool.ts               learn_code_from_web
├─ service.ts            ctx.codeSource（含 probe / validateCredential）
├─ oauth.ts              浏览器登录流程引擎（GitHub 设备码 / Gitee 授权码）
├─ cdp.ts                实验性 cookie 抓取（浏览器调试端口，默认关闭）
├─ routes.ts             /api/dsh-codehub/*（loopback 围栏）
├─ net.ts                统一网络出口（双通道 + 错误分类 + 代理适用性 + 唯一的 POST seam）
├─ store.ts              $DSH_HOME/dsh-codehub.json（0600）
├─ detect.ts             系统代理 / SOCKS5 / Watt / hosts 探测
├─ prompt.ts             系统提示词段
├─ sources/              GitHub / Gitee / CSDN 适配器 + 降级链
└─ learn/                摘要 / 深读 / 去重 / 打分
src/client/
├─ panel.tsx             侧边栏面板与共享控件面（连通性 GUI / 保存摘要 / 还差 N 项）
├─ credential-guide.tsx  凭据获取向导（手把手步骤）
├─ login-dialog.tsx      登录弹窗（向导入口 + 手动粘贴兜底）
└─ …
types/dsh/index.d.ts     DSH SDK 契约垫片（官方 SDK 不在磁盘上，见下）
scripts/wrap-client.mjs  把客户端半边包进 DSH 的模块加载器工厂
docs/DESIGN.md           设计说明（边界、决策点、接口冻结、数据流、已知限制）
test/                    vitest
```

### 关于 `types/dsh/index.d.ts`

`@deepseek-ai/*` 官方 SDK 在本机**不在磁盘上**（打包在 DSH 的运行体内、不可作为目录读取），
所以没有上游 `.d.ts` 可 import。该文件是**按实测运行时形状手写的契约垫片**，tsconfig 已把它
include 进程序。DSH 升级后需要按实测复核。

### 约定

- 契约常量集中在 `src/contract.ts`，其它模块**只引用不重写**。
- 模块间的相对 import 一律用 **`.js` 说明符**（`./x.js`）—— NodeNext 正确，且能安全穿过声明
  产物；`tsdown` 会在打包时解析回 `.ts`。
- `lib/` 与 `node_modules/` 是开发期产物，不入库。

---

## 已知限制

- **`node` 直连通道的可达性会变，不要把它写死。** 2026-10-03 的实测是「三个源全部 `fetch failed`」，
  而 2026-10-04 复测时 `api.github.com` / `gitee.com` / `so.csdn.net` 都可达，**只有 `github.com`
  仍 TCP 443 超时**。所以插件不假定任何一条通道一定可用：默认仍优先 `dsh-web`（Harness 自带出网），
  失败回落 `node`，并在 OAuth 前做**运行期可达性预检**。详见「已验证事实」。
- **`github.com` 主域在本机不可达**（TCP 443 超时，Harness 的 `web_fetch` 同样失败）——
  GitHub 的 OAuth 授权页 / 设备码页 / 令牌页在这台机器上打不开。插件会先说清楚，并给出替代路径；
  `api.github.com` 仍可达，所以**带着已有 token 的 API 查询不受影响**。
- **Gitee v5 没有代码搜索端点**（`/search/code` 实测 404）—— 插件不再为它发请求；仓库搜索需要
  token（匿名返回空数组）；网页版代码搜索需要登录。
- **CSDN 没有 OAuth** —— 登录态只有 cookie；搜索结果大多不带正文，代码要靠打开文章页；
  缺 UA/Referer 时文章页会被 HTTP 521 反爬拦截。`so.csdn.net/robots.txt` 是 `Disallow: /`，
  本插件只做用户显式触发的单次请求，不爬取。
- **实验性 CDP 抓取有安全代价**：它会在本机开一个任何本地进程都能访问的浏览器调试端口。默认关闭，
  需在设置里开启并在界面上显式确认。**两个入口**：
  ①「凭据获取向导」→ CSDN → ② 令牌 / Cookie 手动导入 → CDP 抓取 —— 关着时会直接说明并提供
  「启用 CDP 抓取并保存」按钮（点一下就落地，不用另找界面）；② 面板 →「CSDN 抓取选项」→ 勾选
  「实验性：从本机浏览器读取 Cookie（CDP）」→ 自动/手动保存。
- **不用自己带参数启动浏览器了**：打开上面的开关后，点 **「启动调试浏览器」** 即可（面板与向导里都有）
  —— 插件先探测 `http://127.0.0.1:<端口>/json/version`，端口上已经有可调试的浏览器就**直接复用**，
  否则自己找到 Chrome / Edge / Brave / Chromium（**用哪个由插件内定，不弹选择框**），用**独立配置目录**
  （`$DSH_HOME/dsh-codehub-browser-<浏览器>`，因为 Chromium 会忽略被其它进程占用的 profile 上的调试
  参数）加 `--remote-debugging-port=<端口> --remote-allow-origins=*` 启动，并把 CSDN 登录页打开；等端口
  响应后回传 `webSocketDebuggerUrl`。你只需要在那个窗口里登录 CSDN，然后回来点「读取 Cookie」。
  独立配置目录装着一份登录态，和 cookie 同级敏感，所以放在 `$DSH_HOME` 下（0700），不进仓库。
- **配置保存的落点与优先级**：DSH 的 settings namespace 在本机拒绝本插件的写入（日志：
  `Plugin entry "dsh-codehub" has no volatile fields`），所以保存的配置实际落在
  `$DSH_HOME/dsh-codehub.json`（0600）的 `fallbackConfig`。优先级已修正为
  **内置 / Profile 配置 < 该快照（你的保存） < settings namespace（可读时）**；旧顺序会让你的保存
  被 schema 默认值盖掉——表现为面板一直显示「尚未决定」、`csdn.cdpEnabled` 勾了也读回 `false`。
  遇到「保存了却没生效」，请使用包含该修正的构建。
- **本机代理不作用于 `dsh-web` 通道**（仅 Node 直连传输生效）—— 见「本机代理」一节。
- **`raw.githubusercontent.com` 在本机不稳定/不可直连** —— 建议配 raw 镜像基址。
- **`lib/client.css` 目前不会自动注入页面**。DSH 客户端模块加载器能否解析 CSS 说明符无法在
  本机验证，而猜错的代价是**整个插件加载失败**（比「没样式」严重得多），所以样式表作为独立
  构建产物发布，待对照真实 GUI 确认后再接线。面板与设置页是语义 HTML + 渐进增强，
  样式未加载时全部控件仍可用可读。
- **浏览器半边未经真实 GUI 验证**。host 半边有 typecheck、构建、单测、真实端点探针与**对运行中
  DSH 的活体路由验证**背书；client 半边只有 typecheck + 构建 + 座位/产物检查
  （`check-client-seats.mjs`、`verify-artifacts.mjs`）与源码级断言，真实 GUI 里的交互仍需人工确认。
- **`boot-check` 的客户端探针路径在本机 DSH 版本上不可用**：它按 0.1.5 时代的
  `/plugins/<id>/client.js` 取产物，而本机（0.2.0-rc.2）把客户端产物放在 harness 的 `/api` 围栏之后
  （`/api/plugins/...` 无凭据访问返回 401），所以那条探针会报 404 `PROBLEM`，与插件本身无关。
  客户端半边的等价门禁是 `node scripts/check-client-seats.mjs`（它按真实模块加载器契约加载
  `lib/client.js`、驱动 `apply()` 并渲染全部座位）。此外，**`boot-check` 会以同名 profile 再起一个
  host**：当桌面应用正在运行该 profile 时不要跑它，否则是端口/存储竞争。
- **CDP 抓取未对真实 Chrome 验证**：`Storage.getCookies`（browser 作用域，先试）与
  `Network.getCookies`（页面作用域，回退）两条路径都由注入式假 socket 覆盖，真机需要你先以
  `--remote-debugging-port` 启动浏览器才可复核。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE)。
