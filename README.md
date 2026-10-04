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
pnpm test            # vitest —— 291 例
pnpm run verify      # 交付验收：先查真实运行时的 SDK 表面，再查产物与两端座位
pnpm run verify:sdk  # 单独查：src/ 里每个「值」导入在真机运行时是否真的存在
pnpm run boot-check  # 真实启动一个 profile，确认插件真的挂上（见下）
pnpm run smoke       # 真实端点连通性读数（需网络，刻意不进 test）
```

各命令的分工不要混：

| 命令 | 回答的问题 | 会漏掉什么 |
|---|---|---|
| `typecheck` | 类型对不对 | 运行期行为；**手写的 SDK shim 写错时它也会跟着错** |
| `test` | 行为对不对（291 例，**零网络**） | **类型错误**（vitest 只转译不做类型检查） |
| `verify:sdk` | 导入的 SDK 名字在**真机运行时**存不存在 | 语义（名字在但行为变了） |
| `verify` | **产物**里该有的东西在不在、两端座位能不能注册并渲染 | 逻辑正确性 |
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
- **Gitee** —— 官方 v5 REST，稳定；但搜索端点**需要登录**才返回数据（匿名返回空数组）。

---

## 本机代理

- 本机代理 / SOCKS5 设置的作用范围：**仅 Node 直连传输生效**。
- 走 DSH 自带 web 通道时由 Harness 负责出网，本插件无法为其注入代理。

插件有两条出网通道，代理地址只能左右其中一条：

| 通道 | 是什么 | 受本机代理设置影响 |
|---|---|---|
| `dsh-web` | Harness 自带的 web 服务（**默认优先**） | **否** —— 出网由 DSH 负责 |
| `node` | 本插件进程内的 `fetch` | **是** —— 代理在这里生效 |

> **注意作用域的实际后果**：在**当前这台机器**上，`node` 通道完全出不了网（见「已验证事实」），
> 所以本机代理设置在这里**不会产生任何效果**。它只在 `node` 通道可用的环境下才有意义。

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

## 目录结构

```
src/
├─ contract.ts           契约常量（插件身份、三条备注文案、统一返回类型、决策点定义）
├─ index.ts              host 半边入口（service + tool + routes + 提示词段）
├─ config.ts             schemastery 配置 schema（设置表单由此自动派生）
├─ gating.ts             决策点门禁：未决策 → 拒答 + 零网络请求
├─ tool.ts               learn_code_from_web
├─ service.ts            ctx.codeSource
├─ routes.ts             /api/dsh-codehub/*（loopback 围栏）
├─ net.ts                统一网络出口（双通道 + 错误分类 + 代理适用性）
├─ store.ts              $DSH_HOME/dsh-codehub.json（0600）
├─ detect.ts             系统代理 / SOCKS5 / Watt / hosts 探测
├─ prompt.ts             系统提示词段
├─ sources/              GitHub / Gitee / CSDN 适配器 + 降级链
└─ learn/                摘要 / 深读 / 去重 / 打分
types/dsh/index.d.ts     DSH SDK 契约垫片（官方 SDK 不在磁盘上，见下）
scripts/wrap-client.mjs  把客户端半边包进 DSH 的模块加载器工厂
docs/DESIGN.md           设计说明（边界、决策点、数据流、已知限制）
test/                    vitest
```

### 关于 `types/dsh/index.d.ts`

`@deepseek-ai/*` 官方 SDK 在本机**不在磁盘上**（打包在 DSH 的运行体内、不可作为目录读取），
所以没有上游 `.d.ts` 可 import。该文件是**按实测运行时形状手写的契约垫片**，tsconfig 已把它
include 进程序。DSH 升级后需要按实测复核。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE)。
