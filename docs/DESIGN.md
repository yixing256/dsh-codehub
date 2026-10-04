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
4. `git status` 模拟检查：`.env` / `*.local.yml` / `*.token` / token / 代理地址均不出现在待提交列表
5. 三种 `entryPlacement` 均能落位

### 已知限制（非缺陷）

- **本机代理不作用于 `dsh-web` 通道**（备注①）—— 见 §3
- **`raw.githubusercontent.com` 在本机不可直连** —— 必须配 raw 镜像
- **Gitee 搜索端点匿名行为未完全确定** —— 实现为「真实端点 + 空结果降级 HTML」，不伪造字段
- **`types/dsh/index.d.ts` 是手写垫片**，非官方类型；集中存放，DSH 升级后需按实测复核
