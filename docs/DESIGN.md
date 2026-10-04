# dsh-codehub 设计说明

> 本文件是第 8 条要求的「先设计再写代码」正文，也是实现的规范来源。
> 契约常量以 [`src/contract.ts`](../src/contract.ts) 为准；本文件解释**为什么**是那个形状。

---

## 0. 插件边界

**定位：代码用法学习源（code-usage learning source），不是代码搬运器。**

插件只做四件事的**原材料供给**：

1. 总结实现思路
2. 提炼 API 用法与接口契约
3. 对比不同实现的取舍
4. 记录踩坑笔记

它**不做**：

- 不 clone 仓库，不把远端文件写入用户项目
- 不把远端抓到的代码片段原样粘贴进用户项目
- 不生成「直接抄来的函数 / 文件」作为交付物
- 不执行任何远端代码（无 `eval` / `new Function`，不 spawn 远端脚本）
- 不内置任何代理、不绕合规边界

用户确实需要某段逻辑时，agent 只能**基于学到的思路、按用户项目既有风格重新手写**，并主动说明「这是参考 &lt;来源 URL&gt; 思路重写的，非直接复制」。

### 机制级阻断（不靠模型自觉）

`CodeLearnResult.is_verbatim_copy` 的类型是**字面量 `false`**，不是 `boolean`：

```ts
readonly is_verbatim_copy: false
```

这不是注释约定，是类型系统的约束 —— 没有任何可赋给该字段的值能表示「这是一份允许的直接复制」，因此**不存在构造出 `true` 的代码路径**，`grep -rn "is_verbatim_copy: true"` 永远不可能匹配。

配套约束：

- `code` 字段只作学习参考展示，经统一出口 `redactForDelivery()` 产出，默认上限 `limits.maxCodeChars`（默认 4000，硬顶 20000）
- 超限设置 `codeTruncated: true`
- `render` 强制打上 `LEARNING_ONLY_BANNER`（「仅学习参考 · 不得直接粘贴进用户项目」）
- `learned_summary` 必须承载**思路**，不是代码的改写

### 备注③：防搬运声明双写

同一段硬声明必须**同时**出现在两处：

| 位置 | 常量 |
|---|---|
| `learn_code_from_web` 的 tool description | `ANTI_COPY_TOOL_CLAUSE` |
| system prompt 段（`plugin:dsh-codehub`） | `PROMPT_SECTION_TEXT` |

两者都由 [`contract.ts`](../src/contract.ts) 里的 `ANTI_COPY_STATEMENT` 派生，并由单测断言「两处都含有同一个 `ANTI_COPY_STATEMENT`」。**不允许**在任何地方手写第二份声明文本。

---

## 1. 显示位置

**默认两处都显示，不询问。** 早期版本在 `config.onboarded === false` 时弹一次性对话框
让用户三选一；那个对话框已删除（用户明确要求「不要每次打开就问我显示在哪里」）。
`onboarded` 字段保留仅为 schema 兼容，默认已是 `true`。

| 选项 | 注册的落点 |
|---|---|
| 侧边栏面板 | `sidebar.panellist`（id `codehub`）+ `main`（key `codehub`） |
| 设置页 | `settings.section`（id `codehub`） |
| 两处都显示（默认 `entryPlacement: 'both'`） | 上述三处全注册 |

显示位置是**插件设置页里的一项普通设置**（`CodeHubControls` 的第一项，设置页与侧边栏面板
共用同一控件）：三个选项各自成行、标题与说明分两行，点「保存显示位置」走
`saveDraft()` → `PATCH /api/dsh-codehub/config`，保存成功后由 `subscribeConfig` 驱动
重新注册座位 —— **保存一次即生效，不重载页面，也不再追问**。

关键实现事实：

- **`sidebar.panellist` 收的是「图标」，不是面板。** 该槽位由 shell 拥有按钮、label、
  tooltip 与轨道几何，只把 `{ size }` 交给组件；`main` 才是整页面板。这正是原生
  `dsh-ssh` 的写法（`sidebar.panellist` → `SshPanelIcon`，`main` → `SshPanelPage`）。
  把整块面板挂到 `sidebar.panellist` 会让该行不可用（早期版本就是这么错的，表现为
  「侧边栏找不到入口」）。本项目注册 `CodeHubPanelGlyph`（GitHub 猫标，`currentColor`）。
- 侧边栏行文本固定为 `UI_ENTRY_LABEL = 'codehub'`（不走字典，避免被翻译改掉），
  `UI_ENTRY_ORDER = 5` 让它排在侧边栏靠上位置。
- **`sidebar.panellist` 是 `kind: 'list'`、`replaceRisk: 'none'` 的槽位**。`main` 是
  `kind: 'keyed'`、按 panel id 派发的槽位 —— 侧边栏按钮的 id 与 `main` 的 key 同名即可配对。
- 早期插件（如 `@linxin666/dsh-ssh`）因为当时没有可用槽位，改用了 **DOM 注入**（自愈 MutationObserver）。**本项目不走 DOM 注入** —— 运行时已支持槽位注册，用槽位更干净。
- 座位跟随**已保存**的配置（`config.entryPlacement`），不跟草稿：点单选框本身不会动 shell，
  只有保存成功才重新注册。
- 登录对话框仍渲染在 `shell.overlay` 槽位（`kind: 'list'`、root scope）。
- **显示位置不阻塞 tool**，改错了随时在设置里改回来。

---

## 2. 决策点清单

**不变量：插件永不替用户拍板。**

每个决策点都有「未配置」状态。未配置时 `learn_code_from_web` **拒绝执行**，且：

1. **零网络请求**（不是先查了再问）
2. 返回 `ok: false` + `unresolved_decisions[]`
3. 每条 decision 带 `ask` —— 一句可以直接转述给用户的问题
4. 附带 `control` 字段告诉用户去哪里点

| # | 决策点 | 控件 | 未配置时行为 |
|---|---|---|---|
| 1 | 三源查询优先级 `sourcePriority` | 拖拽排序 | 拒绝，问「你想按 GitHub→Gitee→CSDN 还是别的顺序查？」 |
| 2 | GitHub 访问方式 `githubAccessPriority` | 分风险标签勾选 + 排序 | 拒绝，问「你本机开了 Watt Toolkit 还是配了代理？」 |
| 3 | 失败自动降级 `failoverEnabled` | 开关 | 未触碰 → 拒绝（**不默认开**） |
| 4 | 多源合并 `mergeSources` | 开关 | 未触碰 → 拒绝（**不默认合并**） |
| 5 | Gitee 登录 | 登录弹窗 → `ctx.credentials` | 无 token 时**允许**只打公开端点；空结果标 `auth-required` |
| 6 | CSDN 登录 | 登录弹窗 → `ctx.credentials` | 匿名搜索；受限结果降 `confidence` |
| 7 | 镜像源列表增删 | 界面 CRUD，**不预填死数据** | 空列表 = 该方式不可用，**不兜底** |
| 8 | 本机代理 / SOCKS5 地址 | 输入框 | 未填 = 该方式不出现在可用路径里 |
| 9 | 超时 / 重试次数 | 数字输入 | 有 schema 默认（15s / 2 次）—— 属用户偏好，不是决策点 |
| 10 | 递归深度 / 最大条目 | 数字输入 | 硬顶封顶，防无限递归 |
| 11 | 深度阅读目标 | 多选 | 未选 = 只做浅搜索 |

「未决策」在 schema 里统一表示为 **`undefined` / 空数组**，而不是 `false` —— `false` 是一个**已决定**的答案（「不要降级」），必须与「还没问」区分开。这是 `failoverEnabled?: boolean` 与 `mergeSources?: boolean` 用可选类型的原因。

---

## 3. GitHub 访问方式

**先联网调研，再做成用户可选项。** 调研结论（实测日期 2026-10-03）：

| 目标 | 实测结果 | 结论 |
|---|---|---|
| `api.github.com` | HTTP 200 | 官方直连可行 |
| `raw.githubusercontent.com` | fetch failed | **不可直连，必须依赖镜像** |
| `ghproxy.net/https://raw.githubusercontent.com/...` | HTTP 200，内容正确 | 代理镜像可用 |
| `gitee.com/api/v5/projects?q=...` | **HTTP 404** | 该接口**不存在**，不得实现 |
| `gitee.com/api/v5/search/repositories?q=vue` | 200，返回 `[]` | 真实端点，匿名可能空 |
| `so.csdn.net/api/v3/search?...` | 200，`result_vos[]` 有数据 | 可用（非官方接口，见备注②） |

### 八个方式，分四个风险标签

| 标签 | 方式 | 携带 token |
|---|---|---|
| 稳定 | 官方直连 API | ✅ |
| 稳定 | GitHub Token 登录 | ✅ |
| 临时 | 网页 / API 代理（ghproxy、ghfast.top…） | ❌ |
| 临时 | raw 文件镜像（仅文件下载用） | ❌ |
| 临时 | 本机代理 / SOCKS5 | ✅ |
| 稳定 | Watt Toolkit（原名 Steam++） | ✅ |
| 不推荐 | Hosts / DNS 优化 | ✅ |
| 有隐私风险 | 第三方镜像站 | ❌ |

**token 与镜像互斥是硬约束**，不是 UI 提示：`TOKEN_FORBIDDEN_ACCESS` 列出 `ghproxy` / `raw-mirror` / `third-party-mirror`，请求构造时再校验一次。把长期凭据交给第三方转发站就是凭据泄露。

**Watt Toolkit**：插件不自带、不内置任何代理。界面只提示「可安装 Watt Toolkit（官网 steampp.net）并在『网络加速』里勾选 GitHub，本插件自动检测系统代理 / Hosts 是否已生效」。检测到不等于启用 —— 仍需用户主动勾选。

**Hosts / DNS**：只写说明，**不硬编码任何过期 IP**。

**不合规的都不做**：不内置违规代理、不绕合规边界；任何访问方式都必须用户主动勾选或填写后才生效。

### 备注①：本机代理的适用范围

本机代理（`local-proxy`）只在**传输通道为 `node` 直连**时生效。

插件有两条传输通道：

| 通道 | 是什么 | 能否被代理地址左右 |
|---|---|---|
| `dsh-web` | Harness 自带的 web 服务（`ctx.web.fetch`） | **不能** —— 出网由 DSH 负责，插件无法为其注入代理 |
| `node` | 本进程全局 `fetch` | **能** —— 代理地址在这里生效 |

所以该控件的 label 与 help 必须明确写「**仅 Node 直连传输生效**」（`LOCAL_PROXY_SCOPE_NOTE`），并由单测断言该字样存活到渲染的 label 里。这条限制同时写进 README。

### 403 / 429 处理

按用户预设的 `failover.chain` 切换备选方式；整条链走完仍失败，才问用户「要不要降级查 Gitee / CSDN？」——即降级本身也是一个需要确认的动作。

---

## 4. 配置 schema 与密钥策略

设置表单**由插件导出的 schemastery `Config` 自动派生**（本机 `settings` 服务没有 `installSection` / `register`，只有 `configure`/`describe`/`update`/`replace`/`mutate`）。

字段分组：`enabled`、`onboarded`、`entryPlacement`、`sourcePriority[]`、`github{...}`、`gitee{...}`、`csdn{...}`、`failover{...}`、`mergeSources?`、`limits{...}`、`marking{...}`、`deepRead{...}`、`announceToAgent`。

### 密钥三重策略

1. **token / cookie / 私钥** → 只进 `ctx.credentials`。`CredentialRef` 就是一个字符串、同时充当环境变量名（如 `DSH_CODEHUB_GITEE_TOKEN`）。**不进 schema、不进 profile patch、不进日志、不回显对话**。
2. **代理地址** 虽非密钥但同样敏感 → 只进 `$DSH_HOME/dsh-codehub.json`，文件权限 `0600`。
3. **git 只跟踪模板** → `config.example.yml` / `.env.example`，**无任何真实值**。

反例警示：`@linxin666/dsh-ssh` 把 SSH 密码**明文**存在 `$DSH_HOME/dsh-ssh.json`，它自己的文件头也承认这一点。那是历史妥协，**不是本项目要效仿的模式**。

### 备注②：CSDN 接口来源标注

`CSDN_SEARCH_BASE` 指向的是**非官方内部接口**。`CSDN_API_NOTE` 必须同时含三要素 —— 非官方、实测日期、可能失效 —— 并出现在四处：`src/sources/csdn.ts` 文件头、`CSDN_SEARCH_BASE` 旁行内注释、设置面板 CSDN 区域可见文案、README「接口稳定性」小节。单测断言三要素都在。

---

## 5. 仓库结构与数据流

```
agent 调 learn_code_from_web(query, sources?, deepRead?)
  │
  ├─ gating.ts ── 检查 sourcePriority / githubAccessPriority / failoverEnabled / mergeSources
  │       └─ 任一未决策 → { ok:false, unresolved_decisions[], ask_user }（零网络请求）
  │
  └─ CodeSourceService.search()
          │
          ├─ 按 sourcePriority 顺序逐源
          │     └─ net.ts 统一出口（transport: 'dsh-web' | 'node'）
          │           ├─ 本机代理仅在 transport='node' 生效   ← 备注①
          │           ├─ 按用户 accessPriority 切代理 / 镜像 / raw 镜像
          │           └─ token 只随官方直连发出，镜像路径强制剥离
          │
          ├─ 错误分类：network / timeout / empty / rate-limited / auth-required / parse-failed / not-code
          ├─ 403·429 → failover.chain 逐级切换；链尽 → 返回「是否降级」询问
          └─ mergeSources → URL 归一化 + 内容指纹去重
          │
          ├─ learn/summary    → learned_summary（思路 / 用法 / 取舍 / 坑）
          ├─ learn/deepread   → LearnNote（思路笔记，非文件副本）
          └─ learn/score      → confidence + reason
          │
          └─ redactForDelivery()
                ├─ code 截断至 limits.maxCodeChars，置 codeTruncated
                ├─ 打 LEARNING_ONLY_BANNER
                ├─ is_verbatim_copy 恒 false
                └─ 附 confidence + reason
```

### 客户端与宿主的配置读写

**主路径是插件自己的 `/api/dsh-codehub/config` 路由**，不是 `settingsScope`。

原因：DSH 的 settings RPC **只服务白名单 namespace**，本插件的 namespace 不保证在白名单内，`settingsScope` 可能返回 `status: 'unavailable'`。有现成证据 —— `dsh-better-sidebar/src/client/prefs.ts` 就因此改用自家 fenced route 读写自己的 namespace。

所以：

- `settingsScope` 只作**可选增强**：可用就顺带同步，`unavailable` 时不报错、不阻塞
- 路由必须做 **loopback 围栏**（`isLoopbackRequest` → 403），因为 Harness 的 `/api` 围栏**不覆盖**插件自己注册的路由
- 一个 `(kind, path)` 只能注册一个 handler，所以路径内自行按 HTTP method 分发（405 处理其他动词）

#### 配置合并的优先级（一次真实故障后修正）

```
live Cordis config（apply() 拿到的、已被 schema 填满默认值）   ← 基线
  < $DSH_HOME/dsh-codehub.json 的 fallbackConfig（用户保存的答案） ← 在这里赢
  < settings namespace（可读时最权威）
本机代理地址单独由 0600 store 拥有（备注①）。
```

**为什么必须这样**：`apply()` 收到的是 schema 解析后的配置，因此**每个有默认值的键都带着默认值**。旧顺序把 live config 放在 store 快照之上，等于把「用户保存的答案」永久钉死在默认值上。真实表现：settings RPC 拒绝本 namespace 的写入（`Plugin entry "dsh-codehub" has no volatile fields`），用户保存的 `sourcePriority` / `github.accessPriority` / CSDN 开关都正确落进了 0600 快照，而 host 依旧回答 `sourcePriority: []` —— 面板把用户已经做过的决策显示成「尚未决定」，工具门禁继续拒绝执行，`csdn.cdpEnabled` 勾了也永远读回 `false`。

现在的顺序让三个层各就各位：**内置/Profile 配置是基线，用户保存的答案覆盖它，settings 可读时覆盖一切**。回归测试在 `test/service-outlet.test.ts`（「配置合并优先级」），断言 store 快照赢过 schema 默认值、四项已答后 `getUnresolved()` 为空、settings 仍能压过快照。

### 客户端槽位与组件契约

- 面板与设置页注册用 **`ctx.slots.inject(slot, cb)`**，不用裸 `register` —— 后者在槽位尚未声明到 ledger 时**会抛异常**；`inject` 是声明感知的，会等声明提交后再执行回调。
- 组件 props 形状：`PropsRuntime<'settings.section'> & PropsLocale<NS> & InjectFace<T>`。
- 样式用 CSS Modules + DSH token：`--dsw-alias-*`（语义色，如 `-bg-layer-1`、`-border-l1`、`-label-primary`、`-brand-primary`、`-state-error-primary`）与 `--ds-*`（动效 / 字体，如 `--ds-font-family-code`）。
- **React 是 external**，绝不打包；客户端 bundle 形如 `window.__ModuleLoader__.load({ id, factory })`，导出**具名 `apply` + 具名 `inject`**，不是 default export。
- `apply` 里 **DOM / 挂载失败只记日志、绝不抛出** —— client 插件 apply 抛异常会让整个 GUI 启动失败。

---

## 6. 验证

1. `pnpm run typecheck`、`pnpm run build` 通过；产出 `lib/index.mjs`（纯 ESM）与 `lib/client.js`
2. `pnpm test` 覆盖：
   - 决策点门禁：未配 `sourcePriority` → **零网络请求** + 返回提问
   - 降级链：403 / 429 / timeout 逐级切换
   - 防搬运不变量：`is_verbatim_copy` 恒 `false`
   - 去重生效
   - **备注①** 本机代理 label 含「仅 Node 直连传输生效」
   - **备注②** `CSDN_API_NOTE` 含非官方 / 实测日期 / 可能失效三要素
   - **备注③** tool description 与 prompt 段引用同一 `ANTI_COPY_STATEMENT`
3. 网络冒烟：`api.github.com` 直连 200；`raw` 走镜像 200；Gitee 无 token → `auth-required`（不伪造数据）；CSDN 匿名搜索抽到代码块
4. **提交卫生是脚本，不是自律**：`node scripts/check-commit-hygiene.mjs`（也在 `verify` 链里）对着
   「`git add -A` 会暂存的那一组文件」检查三件事 —— ① 路径不是凭据 / 本地覆盖（`.env`、`*.local.yml`、
   `*.token`、profile / sessions 目录）；② 内容里没有高信号凭据形状（真长度的 PAT、私钥块、JWT、
   `X_SECRET = '<literal>'`），并**单独检查已暂存的集合**，因为 `git add -f` 能绕过 ignore；
   ③ `$DSH_HOME` 位于仓库之外，且可提交文件里没有任何 `dsh-codehub.json` 快照。
   判定规则的自我测试很重要：先用真形状的假 secret 确认它会**失败**，再用模板确认它会**通过** ——
   一个不会失败的检查等于没有检查（第一版就漏掉了 `const X_SECRET = '…'` 与 `git add -f` 两种形状）。
5. 三种 `entryPlacement` 均能落位

---

## 7. 凭据获取与浏览器登录（接口冻结）

> 本节由 Lead 在 Phase 0 冻结；W1/W2/W4 只实现签名，不改签名。文案与实测事实的唯一来源是
> [`src/contract.ts`](../src/contract.ts) 的 `LOGIN_*` / `*_LOGIN_REQUIREMENT` 常量。

### 7.1 三条实测事实（`LOGIN_REQUIREMENT_PROBED_AT`）

| 源 | 查代码是否需要登录 | 实测证据 |
|---|---|---|
| GitHub | **是** | 匿名 `api.github.com/search/code` → HTTP 401；仓库搜索与读公开文件匿名可用 |
| Gitee | **是，但方式不同** | `gitee.com/api/v5/search/code` → **HTTP 404（端点不存在）**；`/search/repositories` 匿名 → `[]`；公开仓库 `contents` 匿名可读；网页代码搜索需登录 |
| CSDN | **需要，且没有 OAuth** | 搜索接口匿名 200，但 30 条仅 6 条带正文；文章页匿名可取代码（实测 19 个 `<pre>`），缺 UA/Referer 时 HTTP 521 |

另：`github.com` 主域在本机 **TCP 443 连接超时**（Harness 的 `web_fetch` 同样失败），而 `api.github.com`
可达 —— 所以 OAuth 必须做**运行期可达性预检**，不能假定能连上。CSDN 的
`so.csdn.net/robots.txt` 是 `Disallow: /`，必须在界面与 README 一并披露。

**单一来源**：上表的每一格都由 `GITHUB_LOGIN_REQUIREMENT` / `GITEE_LOGIN_REQUIREMENT` /
`CSDN_LOGIN_REQUIREMENT` 三个常量承载（`CSDN_ROBOTS_DISCLOSURE` 承载 robots 立场），全部定义在
[`src/contract.ts`](../src/contract.ts)；面板、适配器 `reason`、README 都只引用它们，不手抄第二份。

### 7.2 为什么需要新的 POST seam

| 通道 | 能力 | 能否用于 OAuth |
|---|---|---|
| `dsh-web`（`ctx.web.fetch`） | 只有 GET，接收 `{ url }`，不带头部/凭据 | **不能** |
| `node`（本进程 fetch / 手写代理隧道） | 原本也是 GET-only | 需要新增 POST |

因此 `src/net.ts` 新增**唯一**一条 GET 之外的出网形状：

```ts
export interface PostRequest { url: string; form: Record<string,string>; headers?: Record<string,string>;
  proxy?: string; timeoutMs: number; signal?: AbortSignal }
export type PostLike = (request: PostRequest) => Promise<{ statusCode: number; body: string }>
export function createPostTransport(deps: { fetchImpl?: FetchLike; localProxy?: string }): PostLike
```

硬约束：该 seam **只打官方主机**（`github.com` / `gitee.com`），只被 OAuth 模块调用；带凭据的 POST
永不经镜像或第三方转发（`TOKEN_FORBIDDEN_ACCESS` 的精神在这里同样适用）。

### 7.3 `src/oauth.ts` — 流程引擎

- **GitHub**：设备码流程（RFC 8628）。`POST /login/device/code` → 显示 `user_code` + 打开
  `https://github.com/login/device` → 轮询 `POST /login/oauth/access_token`；`slow_down` 按官方
  语义把间隔 +5s；**不需要 client_secret**，但用户自己的 OAuth App 必须勾选 Enable Device Flow。
- **Gitee**：授权码流程。`/oauth/authorize` → loopback 回调（`OAUTH_CALLBACK_PATH`）→
  `POST /oauth/token`，必须 client_id + **client_secret**（Gitee 无 PKCE、无设备码，已核实）；
  回调失败时永远保留「把 code 粘回来」的手动路径。
- 状态**只存内存**：单源单流程、`OAUTH_FLOW_TTL_MS`、随机 `state`；回调 `state` 不符 → 400 且不写凭据。
- 不变量：凭据值只交给 `writeCredential()`；预检失败不再发第二个请求；响应对浏览器只有布尔与状态码。

### 7.4 `src/cdp.ts` + `src/launcher.ts` — 实验性 cookie 抓取与它的浏览器

- 仅当 `csdn.cdpEnabled === true` **且**请求带 `consent: true` 才执行；否则拒绝（不是默认）。
  `/launch-browser` 用**同一组**双重门禁：启动一个开着调试端口的浏览器就是那个有风险的动作用户要
  亲自同意，不能顺带发生。
- **launcher 先探测再启动**（`GET /json/version`）：端口上已经有可调试的浏览器时**不启动第二个**
  （两个实例抢同一个 profile 只会互相破坏），直接把它的 `webSocketDebuggerUrl` 回传。
- **浏览器顺序是内定的：Edge 优先，然后 Chrome、Brave、Chromium**。理由：Edge 随 Windows 自带，是用户
  最可能已经有、也最不介意被打开的那个；Chrome 作兜底。**这是实现决定，不是给用户的选项** —— UI 里没有
  选择框，多问一个问题正是这个功能要消灭的东西（实测本机两者都在时启动的是 Edge）。
- **必须用独立 `--user-data-dir`**：Chromium 对已被其它进程占用的（尤其是默认的）profile 会**直接
  忽略** `--remote-debugging-port` —— 这正是「用户说自己加过参数、插件却永远超时」的真正原因。目录放在
  `$DSH_HOME/dsh-codehub-browser-<浏览器>`（0700）：它装着一份登录态，和 cookie 同级敏感，绝不放进仓库
  或共享临时目录；**按浏览器分目录**是因为 Edge 与 Chrome 虽同属 Chromium，但共用一个 profile 目录会在
  切换时触发 profile 重置。代价是新目录一开始未登录，所以 launcher 顺手打开 CSDN 登录页。
- 启动参数固定为 `--remote-debugging-port=<port>`、`--remote-allow-origins=*`（Chromium 111+ 会拒绝
  来源不被允许的 CDP websocket）、`--user-data-dir=<dir>`、`--no-first-run`、`--no-default-browser-check`；
  `detached: true` + `stdio: 'ignore'` —— 浏览器必须活过这次请求，而且不能挂在没人读的管道上。
- 只用 `http://127.0.0.1:<port>/json/version`（必要时 `/json/list`）与全局 `WebSocket`（Node ≥22 自带）：
  不打包浏览器、不读 cookie 数据库（不碰 DPAPI/App-Bound）、不装根证书、不起代理。
- **两次尝试，顺序有原因**：先打 browser 端点的 `Storage.getCookies`（不需要附加任何页面 target），
  它的答案覆盖整个浏览器上下文，所以**必须按请求站点过滤**后才允许成为凭据；只有当 browser 端点
  拒绝该方法时，才从 `/json/list` 挑一个页面 target（优先已停在 CSDN 的那个）改用页面作用域的
  `Network.getCookies`。
- **必须先等握手完成再发请求**：`WebSocket.send()` 在 CONNECTING 状态会抛错。实测教训：第一版边连边发，
  异常被归成「连接超时」，于是端口明明在监听，用户却被告知端口不通。现在握手失败有独立文案（并提示
  `--remote-allow-origins`），发送失败另有文案，CDP 的错误帧立刻如实返回（`unsupported` + 浏览器自己的
  错误文本），都不会伪装成超时。
- 返回的 `cookieHeader` 只交给凭据服务；响应只带 cookie **名称与数量**。

**真机实测（本机 Windows + Edge/Chrome 双装）**：`/launch-browser` 的候选顺序为
`edge → chrome`（`…\Microsoft\Edge\Application\msedge.exe` 在前），启动的是 **Microsoft Edge**，独立
profile 与 9334 端口，回传了 `ws://127.0.0.1:9334/devtools/browser/…`；再用同一台的 Chrome 复测时，
打开 csdn.net 后 `Storage.getCookies` 直接返回 **21 个 cookie** 并拼出 `cookieHeader` ——
即 browser 端点的 `Storage.getCookies` **不需要** `Target.attachToTarget`/`sessionId`，
`--remote-allow-origins=*` + 独立 profile 的组合在真实 Chromium 上成立。

### 7.5 路由（loopback 围栏对每一条都生效）

| 路径 | 方法 | 响应里允许出现的字段 |
|---|---|---|
| `/api/dsh-codehub/oauth` | POST(start/cancel/complete) / GET(status) / DELETE(cancel) | `ok/flowId/kind/userCode/verificationUri/expiresIn/interval/status/reason/credentialConfigured` |
| `/api/dsh-codehub/oauth/callback` | GET | 一段自关闭 HTML（无任何凭据） |
| `/api/dsh-codehub/probe` | POST | 每个操作 `reachable/statusCode/requiresLogin/evidence/probedAt` + 行身份 `source/label/operation/authenticated` |
| `/api/dsh-codehub/cookies` | POST | `count/names/hosts` |

两处需要写明的取舍（都是实现时定的，不是遗漏）：

- **`verificationUri` 就是「浏览器要打开的那个 URL」，两种流程共用**。设备码流程它是
  `https://github.com/login/device`；授权码流程它是 Gitee 的 `/oauth/authorize?...`。白名单里
  没有单独的 `authorizeUrl` 键，而多一个键就多一处可以漂移（客户端两种都读，只是兼容）。
- **`/probe` 的行身份键**（`source/label/operation/authenticated`）不在「发现」字段里，但 §7.6 的
  三行面板必须能按 `source` 定位并给出「本次实测」，否则只能靠数组顺序 —— 那是脆弱契约。凭据值
  仍然没有任何字段可以承载。
- **自检（`/smoke`）不再为每个源另跑一遍操作级探测**：`capabilities` 由本次自检已经发出的三个匿名
  请求**派生**（每源一行 + contract 里的实测文案）。理由是可测量的：操作级探测会让「点一次自检」
  从 3 个请求变成 11 个，既慢又对 CSDN 这种已声明 `Disallow: /` 的主机不礼貌。想要操作级读数时，
  用户点「用已保存凭据验证」或 `/probe`，那是显式动作。

### 7.6 连通性面板的展示契约（第 4 条要求）

- 恒定渲染 `CONNECTIVITY_ROW_ORDER`（= GitHub / Gitee / CSDN）三行，**不依赖返回顺序**；没有探测结果
  的行显示「未检测」。
- 每行 = 源名 + 状态（`CONNECTIVITY_STATUSES`：未检测 / 检测中 / 连通 / 失败，颜色 + 文案双通道）+
  成功时的 `HTTP <code> · <延迟>ms · <通道>`；**失败行的下一行直接给失败原因**（`reason`，按
  `CONNECTIVITY_MAX_REASON_LINES` 截断，可一键复制）。
- **禁止渲染原始报文**：客户端不得对 `/smoke`、`/probe` 的返回做 `JSON.stringify` 展示；排障只提供
  「复制失败原因」。该卡不承载学习结果，因此不挂 `LEARNING_ONLY_BANNER`（banner 的适用范围是学习
  结果出口：工具 `render` 与结果展示面）。

### 7.7 向导的排版契约（用户反馈后定稿）

用户的两条反馈直接变成了契约：

1. **一个窗口装不下 → 正文滚动、页脚固定**。`.guideScroll` 是有界高度（`max-height: min(62vh, 520px)`）
   且 `overflow-y: auto` 的盒子；`.modalFooter` 在它**之外**，所以「关闭」永远不需要滚动才能点到。
   测试同时断言「滚动区存在」「footer 在滚动区之后」「样式表里 `.guideScroll` 真的有 `max-height` 与
   `overflow-y`」——只写一个 class 名不算数。
2. **OAuth 与令牌 / Cookie 必须明显区分**。分组是**数据**（`LOGIN_METHOD_FAMILIES` +
   `LOGIN_METHOD_FAMILY` + `loginMethodsOf()`），不是视图里的三个 `if`：向导、测试与任何后续界面
   对「某个方式属于哪一族」只有一个答案。界面表现为：两个带徽标的族标题（① 浏览器登录（OAuth）②
   令牌 / Cookie 手动导入）、各方式一张可选卡片（带「令牌 / Cookie」种类徽标）、点一下就地切换
   （不关窗），并在源没有 OAuth 时**明说**（`guide.family.noOauth`），而不是只显示一半。
   分组不得丢方式：测试断言两族并集 == `SOURCE_LOGIN_METHODS[source]`。

## 8. 设置页反馈设计

**问题**：旧版把「尚未决定的选项」（`DecisionsField`）放在设置页**最顶部**，于是用户点完保存、
看到的第一眼是「你还缺什么」，而不是「你保存了什么」。用户明确要求改掉。

**结论（依据下表）**：设置界面的第一屏永远是**当前值**；「未配置」只在两种情况下才值得单独列出来
——容器真的是空的（空状态），或者这一项会**阻塞用户马上要做的事**（action-required）。本插件的四个
决策点属于后者（未决策 → 工具直接拒绝且零网络请求），但它的**位置和时机**错了：应该在「保存栏
上方」，而不是保存后第一眼看到的地方。

| 依据 | 用到的结论 | 来源 |
|---|---|---|
| NN/g 状态可见性（heuristic #1） | 有后果的动作之后必须给出恰当反馈 —— 保存成功要说清保存了什么 | https://www.nngroup.com/articles/visibility-system-status/ |
| NN/g 自动保存与预期 | 显式 Save 符合多数用户预期；但成功反馈要**点名内容**，自动消失的 toast 不能是唯一证据 | https://www.nngroup.com/articles/efficiency-vs-expectations/ |
| GOV.UK Check answers | 「逐项列当前值 + 每行可改」是让用户核对系统记了什么的成熟模式；跳过项用中性的「Not provided」 | https://design-system.service.gov.uk/patterns/check-answers/ |
| Home Assistant Repairs | 只有「会阻塞目标动作、数量少、一点即解决、解决后消失」的清单才值得常驻；偏好项混进去就是噪音 | https://www.home-assistant.io/integrations/repairs |
| Material 3 Snackbar | 无动作的 toast 4–10s 自动消失，「Web 上避免只用自动消失 snackbar，除非同时有内联反馈」 | https://m3.material.io/components/snackbar/guidelines |
| NN/g 空状态 | 空状态用于「容器没内容且有办法填满」，不要把已有内容的表单当空状态 | https://www.nngroup.com/articles/empty-state-interface-design/ |

落地为四条：

1. **保存成功后第一眼 = `SavedSummaryField`**（顶部，占据原 `DecisionsField` 的位置）。数据取
   **host 回读值**（`saveConfig` 已经把 host 返回的 payload 归一化进 store，UI 之前只是没展示）；
   行 = 字段 → 当前值，本次改动过的行标「本次修改」（由 `buildPatch(before, after)` 的键算出）；
   没有改动时显示「没有改动需要保存」，而不是复用含糊的「已保存」。
2. **`DecisionsField` 下沉**到 `SaveBar` 正上方，改为可折叠的「开始使用前还差 N 项」；N=0 时压缩成
   一行 `4/4 已就绪，learn_code_from_web 可直接执行`（保持状态可见），不弹庆祝。每条带「现在就定」。
3. **措辞描述系统要求，不描述用户缺失**：用「还差 2 项」「未提供」，不用「你还没有…」。
4. **可选未配项不进入任何清单**：token / 镜像 / 代理 / CSDN 登录这些「没配也能跑」的东西，只在各自
   控件旁内联显示「未配置」。混进「未完成」清单就是把它当成了必答项。

被拒绝的那一刻才是完整四问清单最好的落点：`gating.ts` 已经返回 `unresolved_decisions[]` 与
`ask_user`，`tool.ts` 的 `renderOutcome()` 会把它们渲染成可转述的问题 —— 那是用户**真的需要**的时机。

### 8.1 自动保存（用户反馈后**两次**修正的设计）

第一次反馈：「每次改个选项点保存太麻烦，能不能用户每改一处自动保存或保存随时可见」。

**第一版做错了**：自动保存写死开启、又没有开关，于是每次编辑都在用户看向保存栏之前就写完了 ——
「保存到 host」恒为 disabled，保存栏等于装饰。用户随即指出了这一点（「那底部的保存到host无法点击，
你做的保存栏有什么用」）。第二版：

- **防抖自动写入**（`ui.autoSave`，默认开）：`updateDraft()` 排期一次写入，安静期
  `AUTO_SAVE_DELAY_MS = 700ms` 后发出。一次连续编辑 = 一次写入，patch 覆盖全部改动，
  `lastSaveReason: 'auto'` 如实标记。不逐键写的理由：每字符一次 PATCH 会让「本次修改」的行数变成
  噪音，还会让座位注册在每次选择里反复重建。
- **开关就在保存栏里**（`.saveBarToggle`）：用户是在这里找它的，所以它在这里，而不是藏在某个设置
  分组深处。关掉它本身也是一次编辑（会被保存），并且**取消已排期的写入** —— 不能出现「刚关掉却还是
  写了一次」。关闭后的状态文案是「有未保存的改动（自动保存已关闭）」。
- **按钮在两种模式下都有用**：开着时是「立即保存」，`canWrite = (dirty || autoSavePending) && !saving`
  —— 待保存即可点，点了走 `autoSaveNow()` 立刻落地（把排期的那次合并进这次点击）；关着时是
  「保存到 host」。**置灰只剩一种含义：确实没有东西要写。**
- **常驻位置**：`.saveBarSticky`（`position: sticky; bottom: 0`）让状态与按钮在任何滚动位置都可见
  —— 这才是「保存随时可见」。
- **失败不吞改动**：写入失败时草稿保留、`autoSavePending` 保持为真、错误就地显示，手动保存可重试。
- **撤销取消排期**：`resetDraft()` 先 `cancelAutoSave()`，不会「撤销之后又偷偷写一次」。
- **改回原样不算改动**：`updateDraft` 只在 `isDirty()` 为真时排期，否则取消。

与 §8 引用的「显式 Save 更符合多数用户预期」的张力，取舍是**用户明确要求优先**：既要自动保存，也要
让「系统实际做了什么」继续可见（常驻保存栏 + 可关的开关），而不是取消可见性。

### 8.2 向导里必须能打开它自己要用的开关（并且能把浏览器起起来）

第一批反馈：CDP 开关原先只在面板的「CSDN 抓取选项」里，于是向导里那个「读取 Cookie」按钮会在用户完全
不知情的情况下永久 403。现在向导自带这个开关：关着时**明说**（`guide.cdpDisabledNotice`）并给出
「启用 CDP 抓取并保存」，而且走 `autoSaveNow()` **立即落地** —— 只靠防抖排期的话 host 还没拿到标记，
用户的下一次点击必然失败。启用后再要求一次同意（`guide.cdpConsent`），未启用时读取按钮直接禁用。

第二批反馈：「『启动调试浏览器』可以做到登录向导里，主界面到向导的操作太割裂」。对 —— 一个连续动作不该
让用户在两个界面之间来回走。整个 CDP 路径现在都在**同一块面板里**，按真正的执行顺序排列：

```
① （关着时）启用 CDP 抓取并保存
② CSDN → ② 令牌 / Cookie 手动导入 → CDP 抓取
   ├─ 「启动调试浏览器」（未启用时禁用，并说明原因）
   ├─ 在弹出的窗口里登录 CSDN
   └─ 勾「我已了解风险」→ 读取 Cookie（未启用时禁用）
```

启动结果就地显示（launcher 的 reason 只陈述事实：「已启动 Microsoft Edge（独立配置：…）。请在打开的窗口里
登录 CSDN，再回到这里点『读取 Cookie』」），并且把 `LOGIN_URLS.csdnLogin` 作为初始页一起打开 —— 独立配置
目录一开始是未登录的，这一步必须顺手做掉。面板里那个按钮保留：两个入口指向同一个 action。

**文案约定（这一轮学到的）**：界面文案只写**事实与下一步**，不写「我在替你省事」这类自述。
反例（已删除）：`③ 启动调试浏览器（就在这一步完成，不用回主界面）` —— 它把一条操作步骤变成了一句旁白，
还自带编号。正例：`启动调试浏览器` + `端口上已有可调试的浏览器时会直接复用，不会重复启动。`

## 9. CSDN / Gitee 连通性与登录要求

### 9.1 CSDN 的「不通」是三个独立原因，不能混成一句

| 现象 | 实测（2026-10-04） | 处理 |
|---|---|---|
| 搜索接口本身 | 匿名 HTTP 200，30 条命中 | 可用，不是故障 |
| 搜索结果里没有正文 | 30 条里只有 **6** 条带非空 `body`；且**没有 `originalType` 字段** | 结果是「抽不到代码」而不是「连不上」；`originalType` 缺失按**未知**处理，不再无谓降权 |
| 文章页被反爬拦 | 缺 UA/Referer 时 **HTTP 521**；带上 UA + `Referer: https://so.csdn.net/` 后 200，且含真实 `<pre>` 代码块（实测 19 个） | 文章页请求固定带浏览器 UA + Referer；失败时 reason 说明是反爬而非网络 |
| 站点策略 | `so.csdn.net/robots.txt` = `Disallow: /`；`blog.csdn.net` = `Allow: /` | **披露**，并声明只在用户显式操作下发起单次请求，不爬取 |

因此 CSDN 源现在会：在 `limits.maxDepth` 预算内（默认 1，即最多补抓一篇）为「命中但没有代码」的
条目抓一次文章页并抽代码，`reason` 标注「代码来自文章页」；抓不到就如实说明，**不伪造代码**。

### 9.2 Gitee 的说法必须纠正

旧文案说「Gitee 代码搜索需要 token」——**错的**：`GET /api/v5/search/code` 实测 **HTTP 404
（HTML 页面不存在）**，没有 token 也救不了它。真实情况是：v5 只有 `/search/repositories`
（匿名返回 `[]`，需要 token），公开仓库文件内容匿名可读，网页版代码搜索（search.gitee.com，
客户端渲染）需要登录。适配器不再为该端点构造任何请求，reason 直接引用
`GITEE_LOGIN_REQUIREMENT` 常量。

### 9.3 连通性面板（用户明确要求：GUI，不是 JSON）

- 恒定三行（`CONNECTIVITY_ROW_ORDER` = GitHub / Gitee / CSDN），与返回顺序无关；没测过显示「未检测」。
- 每行：源名 + 状态（未检测/检测中/连通/失败，颜色与文案双通道）+ 成功时的 `HTTP <code> · 延迟 · 通道`；
  **失败行的下一行直接给失败原因**（截断 + 可复制）。
- **禁止渲染原始报文**：不再有 `<pre>{JSON.stringify(smoke)}</pre>`，客户端也不得对 `/smoke`、
  `/probe` 的返回做 JSON 展示。
- 两个动作分离：`运行匿名自检`（token-free，沿用旧约定）与 `用已保存凭据验证`（只有用户点它才带
  凭据，且响应仍然只有状态码/布尔/计数）。

> 备注③（防搬运横幅）的适用范围在这里被明确了一次：banner 属于**学习结果出口**（工具 `render` 与
> 结果展示面）。连通性卡不承载学习结果，因此不带 banner；反过来，任何渲染 `code` / `learned_summary`
> 的地方都必须带它 —— 这条由测试断言「面板中没有绕过 banner 的结果渲染」。`/detect` 的环境探测
> 保留独立的 kv 卡片，与连通性卡分开。

---

### 已知限制（非缺陷）

- **本机代理不作用于 `dsh-web` 通道**（备注①）—— 见 §3
- **`raw.githubusercontent.com` 在本机不可直连** —— 必须配 raw 镜像
- **Gitee 搜索端点匿名行为未完全确定** —— 实现为「真实端点 + 空结果降级 HTML」，不伪造字段
- **Gitee v5 没有代码搜索端点**（实测 404）—— 见 §7.1；网页版代码搜索需要登录
- **CSDN 没有 OAuth** —— 登录态只有 cookie；文章页抓取受反爬影响（缺 UA/Referer 时 521）
- **`github.com` 主域在本机不可达**（TCP 443 超时）—— GitHub 的 OAuth/令牌页在本机打不开，
  必须走运行期预检并给出替代路径
- **`types/dsh/index.d.ts` 是手写垫片**，非官方类型；集中存放，DSH 升级后需按实测复核
