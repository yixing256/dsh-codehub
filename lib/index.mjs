import { once } from "node:events";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { connect } from "node:net";
import { connect as connect$1 } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import Schema from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
//#region src/contract.ts
/**
* dsh-codehub — frozen contract surface.
*
* OWNER: lead. This file is LOCKED once opened for parallel work: every other
* module (host half, source adapters, learn layer, client half, tests) imports
* its names from here instead of re-spelling literals. Changing a value here
* changes it everywhere, which is the point.
*
* Why the anti-copy strings live here and are exported as single constants:
* 备注③ requires the anti-plagiarism statement to be written into BOTH the
* `learn_code_from_web` tool description AND the system-prompt section. Two
* hand-maintained copies would drift; one constant plus a test that asserts
* both surfaces reference it cannot.
*
* Plugin identity is fixed by the user and must never be aliased or renamed:
* package name, cordis.patch.yml row name, README title and this service all
* spell `dsh-codehub`.
*/
/** Cordis plugin name. */
const name = "dsh-codehub";
/** npm package name; also the cordis.patch.yml insert row `name`. */
const PACKAGE_NAME = "dsh-codehub";
/** The host service key this plugin provides, consumed as `ctx.codeSource`. */
const SERVICE_KEY = "codeSource";
/** The single agent tool this plugin registers. */
const TOOL_NAME = "learn_code_from_web";
/** Settings namespace. Matches the profile entry id (the loader keys forms by it). */
const SETTINGS_NAMESPACE = "dsh-codehub";
/** Host plugin context this plugin requires before any surface mounts. */
const inject = [
	"tools",
	"webServer",
	"systemPrompt"
];
/** Loopback-fenced route family served by the host half. */
const API_PREFIX = "/api/dsh-codehub";
/**
* CSDN search endpoint base. Non-official internal interface — see
* CSDN_API_NOTE. Response fields consumed: `result_vos[].title` (contains
* `<em>` markup), `.body`, `.description`, `.url`, `.originalType`, `.create_time`.
*/
const CSDN_SEARCH_BASE = "https://so.csdn.net/api/v3/search";
/**
* Provenance note for the CSDN endpoint. 备注② requires exactly three facts —
* non-official, probe date, may break — and a test asserts all three survive in
* every place this string is rendered.
*/
const CSDN_API_NOTE = "CSDN v3 搜索接口为非官方内部接口（非公开 API），实测日期 2026-10-03，字段与可用性可能随时失效；失效时请改用 CSDN 网页搜索或关闭该源。";
/** Gitee v5 API base. */
const GITEE_API_BASE = "https://gitee.com/api/v5";
/**
* Endpoints the brief named for Gitee DO NOT EXIST — and neither does the one
* this constant used to name as a code search.
*
* `https://gitee.com/api/v5/projects?q=...` was probed live and returned 404.
* `GET /api/v5/search/code` was probed live on 2026-10-04 and returned **404
* with an HTML "页面不存在" page** — the mock-like code search this plugin used
* to claim is not a real v5 endpoint at all, so the adapter must never build a
* request for it again. The only real search endpoint is the repositories one,
* which answers `[]` for anonymous callers (a token is required for data).
*
* `GITEE_CODE_SEARCH_SUPPORTED` makes that a fact the UI, the tool `reason` and
* the tests can all read instead of each re-stating it.
*/
const GITEE_SEARCH_REPOSITORIES = "/search/repositories";
/** GitHub API base. Probed live: reachable directly (HTTP 200). */
const GITHUB_API_BASE = "https://api.github.com";
/**
* Raw-content origin. Probed live: NOT reachable from this host. Kept as the
* default value of the configurable raw-mirror list so the UI can show what a
* mirror is a mirror *of*; requests go through the user's mirror bases instead.
*/
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
/** The exact phrase 备注① requires on the local-proxy control. */
const LOCAL_PROXY_SCOPE_NOTE = "仅 Node 直连传输生效";
/** Local-proxy control label, carrying the scope note. */
const LOCAL_PROXY_LABEL = "本机代理 / SOCKS5 地址";
/** Local-proxy help text, carrying the scope note plus the reason. */
const LOCAL_PROXY_HELP = "形如 127.0.0.1:7890。该设置（仅 Node 直连传输生效）：仅当传输通道为 Node 直连时应用；走 DSH 自带 web 通道时由 Harness 负责出网，本插件无法为其注入代理。";
/** The three supported learning sources, in the user's canonical reading order. */
const SOURCES = [
	"github",
	"gitee",
	"csdn"
];
/** Human-facing source names for prompts and rendered output. */
const SOURCE_LABELS = {
	github: "GitHub",
	gitee: "Gitee",
	csdn: "CSDN"
};
const GITHUB_ACCESS = [
	"direct",
	"token",
	"ghproxy",
	"raw-mirror",
	"local-proxy",
	"watt",
	"hosts",
	"third-party-mirror"
];
/** Strategies that must never carry a token, enforced at request-build time. */
const TOKEN_FORBIDDEN_ACCESS = [
	"ghproxy",
	"raw-mirror",
	"third-party-mirror"
];
/**
* Failure taxonomy the user specified. Every adapter failure maps to exactly
* one of these; the category (not the raw error) drives failover and the
* `reason` the agent sees.
*/
const FAILURE_KINDS = [
	"network",
	"timeout",
	"empty",
	"rate-limited",
	"auth-required",
	"parse-failed",
	"not-code"
];
/** Failure kinds a failover chain may advance past. */
const RETRYABLE_FAILURES = [
	"network",
	"timeout",
	"rate-limited",
	"auth-required"
];
const CONFIDENCE_LEVELS = [
	"high",
	"medium",
	"low"
];
/** The banner every rendered result carries. */
const LEARNING_ONLY_BANNER = "【仅学习参考 · 不得直接粘贴进用户项目】";
/** The core boundary statement, shared by the tool and the prompt. */
const ANTI_COPY_STATEMENT = "本插件是「代码用法学习源」，不是代码搬运器。通过本插件拿到的结果只能用于：总结实现思路、提炼 API 用法、对比不同实现取舍、记录踩坑笔记。严禁把远端抓到的代码片段原样粘贴进用户项目，不允许生成「直接抄来的函数 / 文件」作为交付物。若用户确实需要某段逻辑，只能基于学到的思路、按用户项目既有风格重新手写，并主动说明「这是参考 <来源 URL> 思路重写的，非直接复制」。返回结构中的 is_verbatim_copy 恒为 false，code 字段仅作学习参考展示，不得作为交付物转述。";
/** System-prompt section text. */
const PROMPT_SECTION_TEXT = "本机已安装 dsh-codehub 插件（DSH 代码用法学习源）。" + ANTI_COPY_STATEMENT;
const DECISION_KEYS = [
	"sourcePriority",
	"githubAccessPriority",
	"failoverEnabled",
	"mergeSources"
];
const DECISION_GUIDE = {
	sourcePriority: {
		key: "sourcePriority",
		detail: "尚未决定三个源的查询优先级（当前为空）。",
		ask: "你想按 GitHub→Gitee→CSDN 还是别的顺序查？",
		control: "侧边栏面板 / 设置页 → 源优先级（拖拽排序）"
	},
	githubAccessPriority: {
		key: "githubAccessPriority",
		detail: "尚未选择 GitHub 的访问方式（当前为空）。",
		ask: "你本机开了 Watt Toolkit 还是配了代理？我按哪种方式访问 GitHub？",
		control: "侧边栏面板 / 设置页 → GitHub 访问方式"
	},
	failoverEnabled: {
		key: "failoverEnabled",
		detail: "尚未确认是否开启失败自动降级。",
		ask: "某个源失败时要自动降级到下一个源吗？",
		control: "侧边栏面板 / 设置页 → 失败自动降级（开关）"
	},
	mergeSources: {
		key: "mergeSources",
		detail: "尚未确认是否多源合并。",
		ask: "多个源都命中时，要我合并去重后再给你，还是只用最高优先级的那个源？",
		control: "侧边栏面板 / 设置页 → 多源合并（开关）"
	}
};
/** Render the refusal payload's human-readable instruction. */
function decisionPrompt(unresolved) {
	return unresolved.map((item) => item.ask).join("\n");
}
const DEEP_READ_TARGETS = [
	"readme",
	"entry",
	"core",
	"tests"
];
/** Hard caps. The user may lower them in settings; they may not be raised past these. */
const HARD_LIMITS = {
	timeoutMs: 12e4,
	retries: 5,
	maxDepth: 3,
	maxItems: 20,
	maxCodeChars: 2e4
};
/** Schema defaults. Deliberately independent of the decision-gated fields. */
const DEFAULT_LIMITS = {
	timeoutMs: 15e3,
	retries: 2,
	maxDepth: 1,
	maxItems: 8,
	maxCodeChars: 4e3
};
const TOOL_PARAMS = [
	"query",
	"sources",
	"deepRead",
	"maxItems"
];
/**
* GitHub: repo search and file reads are anonymous; CODE search is not.
*
* Measured 2026-10-04: anonymous `GET https://api.github.com/search/code?q=vue`
* answers **HTTP 401 `Requires authentication`**. A token is therefore
* mandatory for code search. `github.com` itself was TCP-unreachable from this
* machine in the same probe (see `GITHUB_HTML_ORIGIN`), which is why the OAuth
* preflight reports reachability instead of assuming it.
*/
const GITHUB_LOGIN_REQUIREMENT = "查代码必须登录：实测 2026-10-04 匿名调用 api.github.com/search/code 返回 HTTP 401 Requires authentication。仓库搜索与读取公开文件无需登录。";
/**
* Gitee: the v5 code-search endpoint does not exist; repository search needs a
* token; public file contents are readable anonymously.
*
* Measured 2026-10-04: `GET https://gitee.com/api/v5/search/code?q=vue` → HTTP
* 404 HTML「页面不存在」; `GET /api/v5/search/repositories?q=vue` → HTTP 200
* with `[]` for an anonymous caller; `GET /api/v5/repos/{owner}/{repo}/contents/…`
* → HTTP 200 anonymously. The web code search (search.gitee.com) renders
* client-side and needs a logged-in session.
*/
const GITEE_LOGIN_REQUIREMENT = "查代码要登录，但方式不同：实测 2026-10-04 Gitee v5 没有 /search/code 端点（返回 HTTP 404 页面不存在），网页版代码搜索需要登录；仓库搜索匿名返回空数组（需要 token），公开仓库文件内容匿名可读。";
/**
* CSDN: search is reachable anonymously, but the payload rarely carries code;
* the article page does, and it is rate-limited/anti-bot gated without a
* logged-in cookie.
*
* Measured 2026-10-04: `https://so.csdn.net/api/v3/search` → HTTP 200, 30 rows,
* only **6** of them carrying a non-empty `body`, and **no `originalType`
* field at all**; `blog.csdn.net` article pages → HTTP 200 with real `<pre>`
* blocks when a browser-like User-Agent + Referer are sent, and **HTTP 521**
* without them on some articles. A logged-in cookie raises the success rate;
* CSDN exposes no OAuth and no token API.
*/
const CSDN_LOGIN_REQUIREMENT = "CSDN 没有 OAuth：实测 2026-10-04 搜索接口匿名可用（HTTP 200，30 条中仅 6 条带正文），正文代码需要打开文章页；文章页缺 UA / Referer 时会被 HTTP 521 反爬拦截，登录 cookie 可提高成功率。";
/**
* The robots position, stated rather than hidden.
*
* `https://so.csdn.net/robots.txt` is exactly `User-agent: *` +
* `Disallow: /`; `blog.csdn.net/robots.txt` is `Allow: /`. This plugin issues
* ONE request per user-triggered action and never crawls, which is the position
* the UI and the README must state next to the endpoint.
*/
const CSDN_ROBOTS_DISCLOSURE = "so.csdn.net/robots.txt 声明 Disallow: /（该主机不允许自动抓取）。本插件只在你的显式操作下发起单次请求，不做爬取、不批量遍历。";
/** Per-source login requirement, keyed by the source id used everywhere else. */
const LOGIN_REQUIREMENTS = {
	github: GITHUB_LOGIN_REQUIREMENT,
	gitee: GITEE_LOGIN_REQUIREMENT,
	csdn: CSDN_LOGIN_REQUIREMENT
};
/** Which methods each source actually supports, in the order the UI lists them. */
const SOURCE_LOGIN_METHODS = {
	github: ["oauth-device", "pat"],
	gitee: ["oauth-code", "pat"],
	csdn: ["cookie-paste", "cookie-cdp"]
};
/** One page the wizard offers to open, so no URL is re-typed in the UI. */
const LOGIN_URLS = {
	/** GitHub: create an OAuth App. Device Flow must be ticked inside it. */
	githubOAuthApp: "https://github.com/settings/applications/new",
	/** GitHub: where the device flow sends the user to type `user_code`. */
	githubDeviceVerification: "https://github.com/login/device",
	/** GitHub: fine-grained PAT, prefilled for read-only public content. */
	githubFineGrainedToken: "https://github.com/settings/personal-access-tokens/new?name=dsh-codehub&description=dsh-codehub+read-only+public+code+access",
	/** GitHub: classic PAT (no scope can still read public information). */
	githubClassicToken: "https://github.com/settings/tokens/new",
	/** Gitee: create a 第三方应用 (callback URL must be registered here). */
	giteeOAuthApp: "https://gitee.com/oauth/applications",
	/** Gitee: personal access token page. */
	giteeToken: "https://gitee.com/profile/personal_access_tokens",
	/** CSDN: where the user signs in before copying the cookie. */
	csdnLogin: "https://passport.csdn.net/login",
	/** CSDN: the search page the cookie is being pasted for. */
	csdnSearch: "https://so.csdn.net/so/search"
};
const GITHUB_DEVICE_GUIDE = {
	method: "oauth-device",
	title: "GitHub 浏览器登录（设备码流程）",
	why: "GitHub 的代码搜索必须带 token。设备码流程让你在浏览器里点一次授权，插件自己把 token 存进凭据服务——不需要手抄 token，也不需要 client_secret。",
	steps: [
		{
			title: "1. 建一个属于你的 OAuth App",
			detail: "打开 GitHub 的 OAuth App 创建页（需要已登录 GitHub）。Application name 随意；Homepage URL 填 https://github.com 即可；Authorization callback URL 对设备码流程不使用，随便填一个 https 地址即可。",
			url: LOGIN_URLS.githubOAuthApp,
			openInBrowser: true
		},
		{
			title: "2. 勾选 Enable Device Flow",
			detail: "创建后回到该 App 的编辑页，勾上 Enable Device Flow 并保存。没有这一步，授权会以 device_flow_disabled 失败——这是 GitHub 的硬性要求。"
		},
		{
			title: "3. 复制 Client ID",
			detail: "只复制 Client ID（形如 Ov23li…，20 位左右）。Client secrets 不需要，也不要填到这里。",
			fields: [{
				slot: "clientId",
				label: "Client ID",
				hint: "Ov23li…"
			}]
		},
		{
			title: "4. 回到插件点「浏览器登录」",
			detail: "插件会显示一个 8 位用户码并打开 https://github.com/login/device，输入该码并授权即可；token 由插件直接写入 DSH 凭据服务，页面只显示「已配置」。",
			url: LOGIN_URLS.githubDeviceVerification,
			openInBrowser: true
		}
	]
};
const GITHUB_PAT_GUIDE = {
	method: "pat",
	title: "GitHub 个人访问令牌（PAT）",
	why: "设备码流程需要一个 OAuth App，且本机必须能连上 github.com；PAT 不需要注册应用，是这两条都不满足时的兜底。",
	steps: [
		{
			title: "1. 打开令牌创建页",
			detail: "推荐 fine-grained（细粒度）令牌：打开下面的预填链接，只读公开仓库内容即可。若打开的是经典令牌页，不勾任何 scope 也能读公开信息。",
			url: LOGIN_URLS.githubFineGrainedToken,
			openInBrowser: true
		},
		{
			title: "2. 生成并复制令牌",
			detail: "令牌形如 github_pat_… 或 ghp_…，只在生成时显示一次，请立刻复制。",
			fields: [{
				slot: "token",
				label: "GitHub Token",
				hint: "github_pat_… 或 ghp_…"
			}]
		},
		{
			title: "3. 粘贴并验证",
			detail: "粘回下面的输入框并保存；插件会立刻用 api.github.com/user 校验一次，返回 200 才算有效。"
		}
	]
};
const GITEE_OAUTH_GUIDE = {
	method: "oauth-code",
	title: "Gitee 浏览器登录（授权码流程）",
	why: "Gitee 不支持设备码，也不支持 PKCE：必须有一个第三方应用（client_id + client_secret），并且回调地址要事先登记。",
	steps: [
		{
			title: "1. 建一个 Gitee 第三方应用",
			detail: "打开「第三方应用」页面并创建应用。应用主页可填 https://gitee.com；回调地址必须与插件显示的回调地址完全一致（下一步会给出可复制的那一串）。",
			url: LOGIN_URLS.giteeOAuthApp,
			openInBrowser: true
		},
		{
			title: "2. 把回调地址登记进应用",
			detail: "插件下方会显示形如 http://127.0.0.1:<端口>/api/dsh-codehub/oauth/callback 的回调地址，点「复制回调地址」后原样粘进 Gitee 应用的回调地址栏。端口变化后需要重新登记。"
		},
		{
			title: "3. 复制 Client ID 与 Client Secret",
			detail: "Client ID 存进配置；Client Secret 只进 DSH 凭据服务（不写配置文件、不进 git、不回显）。",
			fields: [{
				slot: "clientId",
				label: "Gitee Client ID",
				hint: "32–64 位十六进制"
			}, {
				slot: "clientSecret",
				label: "Gitee Client Secret",
				hint: "只存进凭据服务"
			}]
		},
		{
			title: "4. 回到插件点「浏览器登录」",
			detail: "插件会打开 Gitee 授权页；授权后浏览器会跳回本机回调地址并自动完成。若回调没回来（端口被改过/浏览器拦截），把地址栏里 code= 后面那串粘回插件的手动输入框即可。"
		}
	]
};
LOGIN_URLS.giteeToken;
/** Every guide, keyed by method. The wizard renders these verbatim. */
const LOGIN_GUIDES = {
	"oauth-device": GITHUB_DEVICE_GUIDE,
	"oauth-code": GITEE_OAUTH_GUIDE,
	pat: GITHUB_PAT_GUIDE,
	"cookie-paste": {
		method: "cookie-paste",
		title: "CSDN Cookie（手动粘贴）",
		why: "CSDN 没有 OAuth，登录态只有 cookie。匿名也能搜，但正文代码经常拿不到；带上登录 cookie 成功率更高。",
		steps: [
			{
				title: "1. 在浏览器里登录 CSDN",
				detail: "用你平常的浏览器打开并登录即可，插件不接触你的浏览器。",
				url: LOGIN_URLS.csdnLogin,
				openInBrowser: true
			},
			{
				title: "2. 复制 Cookie 请求头（不要用 document.cookie）",
				detail: "F12 → Network → 刷新一次 csdn.net 的请求 → 点任意一个请求 → Headers → Request Headers → 复制 Cookie: 后面那一整串。以分号分隔的 name=value; name=value。注意：HttpOnly 的 cookie 在控制台 document.cookie 里看不到，所以必须从 Network 面板复制。",
				url: LOGIN_URLS.csdnSearch,
				openInBrowser: true
			},
			{
				title: "3. 粘贴并验证",
				detail: "粘回输入框保存。插件会做一次匿名/带 cookie 的结果抽样对比，并如实告诉你是否观察到改善。",
				fields: [{
					slot: "cookie",
					label: "CSDN Cookie",
					hint: "name=value; name=value; …"
				}]
			}
		]
	},
	"cookie-cdp": {
		method: "cookie-cdp",
		title: "CSDN Cookie（实验性：从本机浏览器读取）",
		why: "如果你不想手动复制，可以让插件通过浏览器的调试端口读一次 cookie——包括 HttpOnly 的那些。代价是本机会多出一个本地进程可访问的调试端口。",
		steps: [
			{
				title: "1. 确认安全代价",
				detail: "开启浏览器调试端口后，本机上的任何程序都能通过该端口读取你浏览器的会话。请看完这一步再决定；插件默认关闭这个能力，只在本次操作里使用，且只取 csdn.net 的 cookie。"
			},
			{
				title: "2. 用调试端口启动浏览器",
				detail: "先完全退出浏览器，再用带 --remote-debugging-port=9222 的参数启动（用你原来的用户目录，登录态才在）。示例（Windows，Edge/Chrome）：msedge.exe --remote-debugging-port=9222   或   chrome.exe --remote-debugging-port=9222。"
			},
			{
				title: "3. 在那个浏览器里登录 CSDN，然后回到插件点「读取 Cookie」",
				detail: "插件连 http://127.0.0.1:9222 读一次 cookie 并直接写进凭据服务；结果只显示 cookie 名称与数量，不显示值。",
				url: LOGIN_URLS.csdnLogin,
				openInBrowser: true
			}
		]
	}
};
const GITHUB_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITEE_OAUTH_AUTHORIZE_ENDPOINT = "https://gitee.com/oauth/authorize";
const GITEE_OAUTH_TOKEN_ENDPOINT = "https://gitee.com/oauth/token";
/** The loopback path the Gitee authorization code comes back to. */
const OAUTH_CALLBACK_PATH = "/api/dsh-codehub/oauth/callback";
/** One flow lives at most this long; both providers expire around here too. */
const OAUTH_FLOW_TTL_MS = 9e5;
/** `slow_down` means: wait at least this much longer before the next poll. */
const OAUTH_SLOW_DOWN_STEP_MS = 5e3;
/** Credential ref holding the user's own Gitee OAuth client secret. */
const GITEE_OAUTH_SECRET_REF = "DSH_CODEHUB_GITEE_OAUTH_CLIENT_SECRET";
/** Default browser debug port for the experimental CDP cookie capture. */
const CDP_DEFAULT_PORT = 9222;
/**
* Chromium rejects a CDP websocket whose `Origin` it does not allow (Chrome 111+),
* so the launcher passes this flag — the user asked for it explicitly, and without
* it attaching from a non-browser client can fail with a 403 during the handshake.
* The cost is stated in the UI: it lets any origin that can reach the loopback port
* talk to the debugger, which is why the port stays on 127.0.0.1 and the whole
* capability is opt-in twice over.
*/
const CDP_REMOTE_ALLOW_ORIGINS_FLAG = "--remote-allow-origins=*";
/** The only hosts the CDP cookie capture is ever allowed to read for. */
const CDP_COOKIE_HOSTS = [
	"https://www.csdn.net",
	"https://so.csdn.net",
	"https://blog.csdn.net"
];
/** Largest `err.message` we keep, so a chatty stack cannot flood a `reason`. */
const MAX_MESSAGE_CHARS = 400;
/**
* `Bearer <token>` / `Basic <blob>` auth-scheme forms.
*
* Needed in addition to the key/value rule: `Authorization: Bearer sk-live-…`
* would otherwise be reduced to `Authorization: **** sk-live-…`, because the
* key/value rule stops at the space and only eats the scheme word — leaving the
* actual secret in the log. Reported by tests-verify.
*/
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{6,})/gi;
/** `key=value` / `key: value` forms, including quoted values. */
const KEY_VALUE_PATTERN = /(authorization|cookie|set-cookie|token|access_token|refresh_token|private_token|api[_-]?key|apikey|secret|password|passwd)\s*([=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi;
/** `token sk-live-…` — a keyword separated from its value by whitespace only. */
const SPACED_VALUE_PATTERN = /\b(token|apikey|api[_-]?key|secret|password|passwd)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
/** `scheme://user:pass@host` — proxy / URL credentials. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/**
* Replace every credential-shaped substring with `****`.
*
* Rule order matters: the auth-scheme rule runs FIRST so the whole
* `Bearer <value>` pair is consumed before the key/value rule can match the
* keyword alone and strand the value. Sharing these `/g` literals between calls
* is safe — `String.prototype.replace` resets `lastIndex` for a global regexp.
*/
function scrubSecrets(text) {
	return text.replace(AUTH_SCHEME_PATTERN, "$1 ****").replace(KEY_VALUE_PATTERN, "$1$2****").replace(SPACED_VALUE_PATTERN, "$1 ****").replace(URL_USERINFO_PATTERN, "$1****@");
}
/** `socks5://user:pass@127.0.0.1:7890` -> `socks5://127.0.0.1:****`. */
function redactAddress(value) {
	if (typeof value !== "string" || value.trim().length === 0) return "(未配置)";
	const spec = parseProxyAddress(value);
	if (spec === void 0) return "****";
	return `${spec.scheme}://${spec.host}:****`;
}
/** A loggable URL label: scheme + host + path. No query, no userinfo. */
function safeUrlLabel(value) {
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "(无法解析的地址)";
	}
}
function messageOf$4(error) {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const candidate = error.message;
		if (typeof candidate === "string") return candidate;
	}
	try {
		return String(error);
	} catch {
		return "无法读取的错误对象";
	}
}
function shortMessage(error) {
	const text = scrubSecrets(messageOf$4(error)).replace(/\s+/g, " ").trim();
	if (text.length === 0) return "传输层未给出错误信息";
	return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}
/**
* Console logger.
*
* The shim exposes no `ctx.logger` (types/dsh/index.d.ts lists the observed
* `Context` surface: `effect` / `get` / `inject` / `on`), and reaching for an
* un-injected service property throws — so `console` it is. Every payload is
* scrubbed, and the happy path logs nothing at all.
*/
function createConsoleLogger(prefix = "[dsh-codehub]") {
	return (event, detail) => {
		let suffix = "";
		if (detail !== void 0) try {
			suffix = ` ${scrubSecrets(JSON.stringify(detail))}`;
		} catch {
			suffix = " (detail 无法序列化)";
		}
		console.warn(`${prefix} ${scrubSecrets(event)}${suffix}`);
	};
}
/**
* A failure with no HTTP answer behind it.
*
* `name` mirrors the cause (`AbortError` / `TimeoutError`) when there is one, so
* a downstream `err.name === 'AbortError'` check keeps working even without
* reading `kind`.
*/
var TransportError = class extends Error {
	kind;
	failure;
	statusCode;
	constructor(kind, message, options) {
		super(message, options?.cause === void 0 ? void 0 : { cause: options.cause });
		this.kind = kind;
		this.failure = kind;
		if (options?.statusCode !== void 0) this.statusCode = options.statusCode;
		this.name = options?.name ?? "TransportError";
	}
};
/**
* Map an HTTP status onto the taxonomy. See the precedence table in the header.
*
* `hasToken` is part of the signature (the token policy and the caller both know
* it) but does NOT change the classification: a 403 is the anonymous-quota
* answer on GitHub, so it is `rate-limited` whether or not a credential rode
* along. The credential hint is a separate sentence — `classifyStatusHint()` —
* because one FailureKind cannot carry two meanings.
*/
function classifyStatus(statusCode, hasToken) {
	if (statusCode >= 200 && statusCode < 300) return void 0;
	if (statusCode === 401) return "auth-required";
	if (statusCode === 403) return "rate-limited";
	if (statusCode === 429) return "rate-limited";
	if (statusCode === 408) return "timeout";
	if (statusCode === 404 || statusCode === 410) return "not-code";
	if (statusCode >= 500) return "network";
	if (statusCode >= 400) return "parse-failed";
	return "empty";
}
/** Classify anything thrown by a socket / fetch / proxy handshake. */
function classifyThrown(error) {
	if (error instanceof TransportError) return error.kind;
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError") return "timeout";
	const text = messageOf$4(error).toLowerCase();
	if (/timed?\s?out|etimedout|timeout|超时/.test(text)) return "timeout";
	if (/aborted|aborterror|cancell?ed|已取消/.test(text)) return "timeout";
	if (/429|too many requests|rate ?limit|限流/.test(text)) return "rate-limited";
	if (/401|403|unauthorized|forbidden|bad credentials|凭据/.test(text)) return "auth-required";
	if (/unexpected token|json|parse|解析/.test(text)) return "parse-failed";
	return "network";
}
/**
* Kinds worth re-issuing the SAME request for, derived from the contract.
*
* `auth-required` is subtracted on purpose: retrying cannot conjure a
* credential, and spending the retry budget on it only delays the failover
* chain, which is the layer that owns that case.
*/
const TRANSPORT_RETRY_KINDS = RETRYABLE_FAILURES.filter((kind) => kind !== "auth-required");
function isTransportRetryable(kind) {
	return TRANSPORT_RETRY_KINDS.includes(kind);
}
/** Transient HTTP answers the transport may re-issue by itself. */
function shouldRetryStatus(statusCode) {
	return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}
function clampRetries(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMITS.retries;
	return Math.min(Math.max(Math.floor(value), 0), HARD_LIMITS.retries);
}
function clampTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_LIMITS.timeoutMs;
	return Math.min(Math.floor(value), HARD_LIMITS.timeoutMs);
}
/** Wrap anything thrown into a `TransportError`, keeping 备注① wording. */
function toTransportError(error, context) {
	const name = error instanceof Error ? error.name : "";
	let base;
	if (error instanceof TransportError) base = error;
	else if (name === "AbortError") base = new TransportError("timeout", "请求已取消。", {
		cause: error,
		name: "AbortError"
	});
	else if (name === "TimeoutError") base = new TransportError("timeout", "请求超时。", {
		cause: error,
		name: "TimeoutError"
	});
	else base = new TransportError(classifyThrown(error), shortMessage(error), { cause: error });
	const reason = scrubSecrets(context?.reason ?? "");
	if (reason.length === 0 || base.message.includes(reason)) return base;
	return new TransportError(base.kind, `${base.message}（${reason}）`, {
		statusCode: base.statusCode,
		cause: base,
		name: base.name
	});
}
/**
* `AbortSignal.any([...])` over the signals that actually exist.
*
* `exec.signal` is optional in `ToolExecutionInput`, and passing `undefined`
* into `AbortSignal.any` throws, so the list is filtered first. A manual
* controller stands in for runtimes without `any` (Node < 20.3), which keeps
* the composed timeout working instead of silently dropping it.
*/
function composeSignal(signals) {
	const usable = signals.filter((item) => item !== void 0);
	if (usable.length === 0) return void 0;
	if (usable.length === 1) return usable[0];
	const anyOf = AbortSignal.any;
	if (typeof anyOf === "function") return anyOf.call(AbortSignal, usable);
	const controller = new AbortController();
	for (const item of usable) {
		if (item.aborted) {
			controller.abort(item.reason);
			break;
		}
		item.addEventListener("abort", () => controller.abort(item.reason), { once: true });
	}
	return controller.signal;
}
/** `AbortSignal.timeout(ms)`, with a manual fallback. */
function timeoutSignal(timeoutMs) {
	const factory = AbortSignal.timeout;
	if (typeof factory === "function") return factory.call(AbortSignal, timeoutMs);
	const controller = new AbortController();
	setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	return controller.signal;
}
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		let timer;
		function cleanup() {
			if (timer !== void 0) clearTimeout(timer);
			if (signal !== void 0) signal.removeEventListener("abort", onAbort);
		}
		function onAbort() {
			cleanup();
			reject(new TransportError("timeout", "请求在重试等待期间被取消。", { name: "AbortError" }));
		}
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		if (signal !== void 0) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
function backoffMs(attempt) {
	return Math.min(200 * 2 ** attempt, 2e3);
}
/**
* Parse `127.0.0.1:7890`, `http://host:port`, `socks5://user:pass@host:port`.
*
* A bare `host:port` is read as an HTTP proxy, which is what Clash / V2Ray /
* Watt expose by default. Returns `undefined` for anything unparseable;
* `planRequest()` then REFUSES the request rather than guessing — a configured
* proxy that silently fails open would send traffic the user meant to tunnel.
*/
function parseProxyAddress(value) {
	if (typeof value !== "string") return void 0;
	const raw = value.replace(/\s+/g, "").trim();
	if (raw.length === 0) return void 0;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return;
	}
	const protocol = url.protocol.replace(/:$/, "").toLowerCase();
	let scheme;
	if (protocol === "http" || protocol === "https" || protocol === "socks5" || protocol === "socks4") scheme = protocol;
	else if (protocol === "socks5h") scheme = "socks5";
	else if (protocol === "socks4a") scheme = "socks4";
	else return;
	const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
	if (host.length === 0) return void 0;
	const port = url.port.length > 0 ? Number(url.port) : scheme === "socks5" || scheme === "socks4" ? 1080 : 8080;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return void 0;
	const auth = url.username.length > 0 ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : void 0;
	return auth === void 0 ? {
		scheme,
		host,
		port,
		raw
	} : {
		scheme,
		host,
		port,
		auth,
		raw
	};
}
/** SOCKS4 is parsed (so it can be reported) but not implemented. */
function proxySupport(spec) {
	if (spec.scheme === "socks4") return {
		supported: false,
		reason: "暂不支持 SOCKS4 代理（仅支持 HTTP / HTTPS / SOCKS5）。请改用 socks5://host:port 或 http://host:port；本次不发起请求，也不会绕过代理直连。"
	};
	return { supported: true };
}
function hasHeader(headers, name) {
	const wanted = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}
/**
* Decide the channel, the token policy and the proxy application for one request.
*
* Order of operations:
*   1. **Token policy re-check.** `TOKEN_FORBIDDEN_ACCESS` strategies lose the
*      token HERE, at request-build time, even if a caller already stripped it.
*      Handing a long-lived credential to a third-party relay is a leak, not a
*      tradeoff.
*   2. **Channel choice.** A caller-provided `transport` wins. Otherwise
*      `dsh-web` is preferred when the harness web service exists and no proxy
*      is configured; a configured proxy (or a credential) forces `node`,
*      because that is the only channel either can use.
*   3. **Proxy application.** `node` -> applied. `dsh-web` -> explicitly NOT
*      applied, with a 备注① sentence in `reason` + `notes`.
*/
function planRequest(input) {
	const notes = [];
	let token = typeof input.token === "string" && input.token.trim().length > 0 ? input.token.trim() : void 0;
	let tokenStripped = false;
	const forbidden = input.access !== void 0 && TOKEN_FORBIDDEN_ACCESS.includes(input.access);
	if (token !== void 0 && forbidden) {
		token = void 0;
		tokenStripped = true;
		notes.push(`访问方式「${input.access}」在 TOKEN_FORBIDDEN_ACCESS 名单里，已在请求构造阶段强制剥离 token（第三方转发不得接触长期凭据）。`);
	}
	const headers = { ...input.headers ?? {} };
	if (token !== void 0 && !hasHeader(headers, "authorization")) headers.authorization = `Bearer ${token}`;
	const configuredProxy = typeof input.localProxy === "string" ? input.localProxy.trim() : "";
	const proxy = parseProxyAddress(configuredProxy);
	const proxyConfigured = proxy !== void 0;
	const support = proxy === void 0 ? void 0 : proxySupport(proxy);
	const hasWeb = input.hasWebService === true;
	let transport;
	if (input.transport !== void 0) transport = input.transport;
	else if (hasWeb && proxy === void 0) transport = "dsh-web";
	else {
		transport = "node";
		if (hasWeb && proxy !== void 0) notes.push(`检测到本机代理配置，已选择 Node 直连传输以便应用它（${LOCAL_PROXY_SCOPE_NOTE}）。`);
	}
	if (token !== void 0 && transport === "dsh-web") {
		transport = "node";
		notes.push("本次请求需要携带凭据，而 DSH 自带 web 通道无法附加请求头，已改走 Node 直连传输。");
	}
	if (input.access === "local-proxy" && transport === "dsh-web") {
		transport = "node";
		notes.push(`访问方式选择了「本机代理」，该方式${LOCAL_PROXY_SCOPE_NOTE}，已改走 node 通道。`);
	}
	let headersDroppedNote;
	let headersForcedNode = false;
	if (Object.keys(headers).length > 0 && transport === "dsh-web") {
		if (nodeChannelAvailable()) {
			transport = "node";
			headersForcedNode = true;
			notes.push("本次请求带有自定义请求头（如 User-Agent / Referer / Cookie），而 DSH 自带 web 通道只接收 { url } 并会丢弃它们；已改走 Node 直连传输。");
		} else {
			headersDroppedNote = "本进程没有可用的 fetch，无法把请求改走 Node 直连传输：本次请求头会被丢弃，CSDN 文章页可能被 HTTP 521 反爬拦截。";
			notes.push(headersDroppedNote);
		}
	}
	let proxyApplied = false;
	let reason;
	let blocked = false;
	if (configuredProxy.length > 0 && proxy === void 0) {
		reason = "本机代理地址无法解析（形如 127.0.0.1:7890、http://host:port 或 socks5://host:port）。本次不发起请求，也不会绕过代理静默直连。";
		blocked = true;
	} else if (proxy !== void 0 && support !== void 0 && !support.supported) {
		reason = support.reason;
		blocked = true;
	} else if (input.access === "local-proxy" && proxy === void 0) {
		reason = "访问方式选择了「本机代理 / SOCKS5」，但配置里没有代理地址；按设计「未填 = 该方式不可用」，本次不发起请求（不会静默改走直连）。";
		blocked = true;
	} else if (proxy !== void 0) {
		if (transport === "node") {
			proxyApplied = true;
			notes.push(`已应用本机代理（${LOCAL_PROXY_SCOPE_NOTE}）：本次走 Node 直连传输。`);
		} else reason = `已配置本机代理，但本次请求走 DSH 自带 web 通道（${LOCAL_PROXY_SCOPE_NOTE}）：出网由 Harness 负责，本插件无法为其注入代理，因此该代理未被应用。如需它生效，请让本插件改走 Node 直连传输。`;
	}
	if (reason === void 0 && headersDroppedNote !== void 0) reason = headersDroppedNote;
	if (reason !== void 0) notes.push(reason);
	return {
		url: input.url,
		transport,
		timeoutMs: clampTimeoutMs(input.timeoutMs),
		headers,
		...token === void 0 ? {} : { token },
		tokenStripped,
		...proxy === void 0 ? {} : { proxy },
		proxyConfigured,
		proxyApplied,
		headersForcedNode,
		...reason === void 0 ? {} : { reason },
		notes,
		blocked
	};
}
function defaultFetch() {
	const candidate = globalThis.fetch;
	if (typeof candidate !== "function") throw new TransportError("network", "本进程没有可用的 fetch（需要 Node ^22.19.0 || >=24.0.0）。");
	return candidate;
}
/**
* Can THIS process open its own connection (the `node` channel)?
*
* `planRequest()` is pure apart from this check, and it needs the answer for one
* decision: a request that carries headers cannot use the harness channel (which
* accepts `{ url }` only). When there is no local `fetch` the request still goes
* out — over the harness channel, with its headers dropped — and the `reason`
* says so instead of failing silently.
*/
function nodeChannelAvailable() {
	return typeof globalThis.fetch === "function";
}
/**
* Build the one `Transport` the adapters receive.
*
* Retries live in a bounded `for` loop (no recursion, so no depth to exhaust):
* they apply to thrown `network` / `timeout` failures and to the transient HTTP
* statuses in `shouldRetryStatus()`, never to `auth-required`. The budget comes
* from `limits.retries`, clamped by `HARD_LIMITS.retries`.
*
* CHANNEL FALLBACK (task requirement: 默认优先 dsh-web，不可用时回退 node): when
* the harness web service exists but the request dies at the network layer, the
* transport re-plans onto the `node` channel ONCE. That re-plan matters — it
* re-runs the 备注① logic, so if a local proxy is configured it is actually
* applied on the channel that can honour it, instead of being silently ignored.
* A caller that pinned `deps.transport` explicitly is never second-guessed.
*/
function createTransport(deps = {}) {
	const logger = deps.logger ?? createConsoleLogger();
	const retryBudget = clampRetries(deps.retries);
	return async function transport(request) {
		const planInput = {
			url: request.url,
			token: request.token,
			headers: request.headers,
			transport: deps.transport,
			access: deps.access,
			localProxy: deps.localProxy,
			hasWebService: deps.web !== void 0,
			timeoutMs: request.timeoutMs ?? deps.timeoutMs
		};
		let plan = planRequest(planInput);
		if (plan.blocked) throw new TransportError("network", plan.reason ?? "本机配置阻止了本次请求。");
		/** True once the harness channel has been abandoned for the node channel. */
		let fellBackToNode = false;
		/** True once a header-carrying node request has been handed to the web channel. */
		let fellBackToWeb = false;
		let attempt = 0;
		let lastFailure;
		for (let guard = 0; guard <= retryBudget + 2; guard += 1) try {
			const response = await send(plan, deps, request.signal);
			if (shouldRetryStatus(response.statusCode) && attempt < retryBudget) {
				lastFailure = new TransportError(classifyStatus(response.statusCode, plan.token !== void 0) ?? "network", `HTTP ${response.statusCode}，准备重试。`, { statusCode: response.statusCode });
				logger("传输遇到可重试状态码", {
					status: response.statusCode,
					attempt: attempt + 1,
					transport: plan.transport,
					host: safeUrlLabel(plan.url)
				});
				await delay(backoffMs(attempt), request.signal);
				attempt += 1;
				continue;
			}
			return response;
		} catch (error) {
			const failure = toTransportError(error, plan);
			lastFailure = failure;
			if (plan.transport === "dsh-web" && !fellBackToNode && deps.transport === void 0 && failure.kind === "network") {
				fellBackToNode = true;
				plan = replanOnNode(planInput, failure);
				logger("DSH web 通道不可用，回退到 Node 直连传输", {
					kind: failure.kind,
					host: safeUrlLabel(plan.url)
				});
				if (plan.blocked) throw new TransportError("network", plan.reason ?? "本机配置阻止了本次请求。");
				continue;
			}
			if (plan.transport === "node" && plan.headersForcedNode && !fellBackToWeb && deps.transport === void 0 && deps.web !== void 0 && plan.token === void 0 && plan.proxyConfigured === false && failure.kind === "network") {
				fellBackToWeb = true;
				plan = replanOnWeb(planInput, failure);
				logger("Node 直连传输不可用，回退到 DSH web 通道（请求头会被丢弃）", {
					kind: failure.kind,
					host: safeUrlLabel(plan.url)
				});
				continue;
			}
			if (!isTransportRetryable(failure.kind) || attempt >= retryBudget) throw failure;
			logger("传输失败，重试中", {
				kind: failure.kind,
				attempt: attempt + 1,
				transport: plan.transport,
				host: safeUrlLabel(plan.url)
			});
			await delay(backoffMs(attempt), request.signal);
			attempt += 1;
		}
		throw lastFailure ?? new TransportError("network", "传输在重试后仍未成功。");
	};
}
/** Note attached when the harness channel is abandoned for the node channel. */
const WEB_CHANNEL_FALLBACK_NOTE = "DSH 自带 web 通道请求失败（network），已回退到 Node 直连传输重试一次；本机代理若已配置，将在该通道上生效。";
function replanOnNode(planInput, failure) {
	const replanned = planRequest({
		...planInput,
		transport: "node"
	});
	const detail = failure.message.trim().length > 0 ? `（通道错误：${failure.message}）` : "";
	const note = `${WEB_CHANNEL_FALLBACK_NOTE}${detail}`;
	return {
		...replanned,
		notes: [...replanned.notes, note],
		reason: replanned.reason ?? note
	};
}
/** Note attached when a header-carrying request loses its headers on `dsh-web`. */
const WEB_CHANNEL_HEADER_LOSS_NOTE = "Node 直连传输不可用（network），已回退到 DSH 自带 web 通道重试一次：该通道只接收 { url }，本次请求头（User-Agent / Referer 等）会被丢弃，CSDN 文章页可能被 HTTP 521 反爬拦截。";
function replanOnWeb(planInput, failure) {
	const replanned = planRequest({
		...planInput,
		headers: void 0,
		transport: "dsh-web"
	});
	const detail = failure.message.trim().length > 0 ? `（通道错误：${failure.message}）` : "";
	const note = `${WEB_CHANNEL_HEADER_LOSS_NOTE}${detail}`;
	return {
		...replanned,
		notes: [...replanned.notes, note],
		reason: note
	};
}
async function send(plan, deps, signal) {
	if (plan.transport === "dsh-web") {
		const web = deps.web;
		if (web === void 0) throw new TransportError("network", "本次计划选用 dsh-web 通道，但当前上下文没有可用的 web 服务。");
		return sendViaWeb(web, plan, signal);
	}
	if (plan.proxyApplied && plan.proxy !== void 0) return sendViaProxy(plan, plan.proxy, signal);
	return sendDirect(plan, deps, signal);
}
/** 备注①: the harness channel. `{ url }` only — no headers, no credentials. */
async function sendViaWeb(web, plan, signal) {
	const notes = [...plan.notes];
	const result = await web.fetch({ url: plan.url }, signal);
	const body = typeof result.body?.content === "string" ? result.body.content : "";
	if (result.truncated === true) notes.push("DSH 自带 web 通道返回的内容被截断（truncated），解析结果可能不完整。");
	return {
		statusCode: typeof result.statusCode === "number" ? result.statusCode : 0,
		body,
		finalUrl: typeof result.url === "string" && result.url.length > 0 ? result.url : plan.url,
		...plan.reason === void 0 ? {} : { note: plan.reason },
		notes
	};
}
/** The plain `node` channel: this process's own fetch. */
async function sendDirect(plan, deps, signal) {
	const response = await (deps.fetchImpl ?? defaultFetch())(plan.url, {
		method: "GET",
		headers: plan.headers,
		redirect: "follow",
		...signal === void 0 ? {} : { signal }
	});
	const body = await response.text();
	return {
		statusCode: response.status,
		body,
		finalUrl: typeof response.url === "string" && response.url.length > 0 ? response.url : plan.url,
		...plan.reason === void 0 ? {} : { note: plan.reason },
		notes: plan.notes
	};
}
async function sendViaProxy(plan, proxy, signal) {
	let current;
	try {
		current = new URL(plan.url);
	} catch {
		throw new TransportError("parse-failed", "无法解析目标地址，已放弃经代理请求。");
	}
	if (current.protocol !== "http:" && current.protocol !== "https:") throw new TransportError("network", `不支持经代理访问 ${current.protocol} 目标。`);
	for (let hop = 0; hop <= 3; hop += 1) {
		const answer = await proxyRequestOnce(current, plan, proxy, signal, plan.timeoutMs);
		const location = answer.location;
		if (answer.statusCode >= 300 && answer.statusCode < 400 && typeof location === "string" && location.length > 0) {
			let next;
			try {
				next = new URL(location, current);
			} catch {
				throw new TransportError("parse-failed", "代理返回了无法解析的跳转地址。");
			}
			if (next.protocol !== "http:" && next.protocol !== "https:") throw new TransportError("network", `代理把请求跳转到了不支持的协议：${next.protocol}`);
			if (hop === 3) throw new TransportError("network", `经代理的请求跳转次数超过上限（3）。`);
			current = next;
			continue;
		}
		return {
			statusCode: answer.statusCode,
			body: answer.body,
			finalUrl: current.toString(),
			...plan.reason === void 0 ? {} : { note: plan.reason },
			notes: plan.notes
		};
	}
	throw new TransportError("network", "经代理的请求未能完成。");
}
/**
* One request/answer over a fresh tunnel.
*
* `init` exists for the OAuth POST seam: the tunnel, the header plumbing and the
* error classification are identical for GET and POST, so the method and the
* body are the only things the caller ever varies.
*/
async function proxyRequestOnce(url, plan, proxy, signal, timeoutMs, init) {
	const tls = url.protocol === "https:";
	const target = {
		host: url.hostname,
		port: url.port.length > 0 ? Number(url.port) : tls ? 443 : 80,
		tls
	};
	const options = {
		method: init?.method ?? "GET",
		host: target.host,
		port: target.port,
		path: `${url.pathname}${url.search}`,
		headers: plan.headers,
		setHost: true,
		createConnection: (_options, oncreate) => {
			openTunnel(proxy, target, timeoutMs, signal).then((socket) => oncreate(null, socket), (error) => oncreate(toTransportError(error, plan), void 0));
		}
	};
	if (signal !== void 0) options.signal = signal;
	return new Promise((resolve, reject) => {
		let active;
		function onResponse(res) {
			const chunks = [];
			res.on("data", (chunk) => {
				chunks.push(chunk);
			});
			res.on("error", (error) => {
				active?.destroy();
				reject(toTransportError(error, plan));
			});
			res.on("end", () => {
				const raw = decodeContentEncoding(Buffer.concat(chunks), res.headers["content-encoding"]);
				resolve({
					statusCode: res.statusCode ?? 0,
					body: raw.toString("utf8"),
					...typeof res.headers.location === "string" ? { location: res.headers.location } : {}
				});
			});
		}
		try {
			active = tls ? request$1(options, onResponse) : request(options, onResponse);
		} catch (error) {
			reject(toTransportError(error, plan));
			return;
		}
		active?.setTimeout(timeoutMs, () => {
			active?.destroy(new TransportError("timeout", `经代理的请求超时（${timeoutMs} ms）。`, { name: "TimeoutError" }));
		});
		active?.on("error", (error) => {
			reject(toTransportError(error, plan));
		});
		active?.end(init?.body);
	});
}
function decodeContentEncoding(raw, header) {
	const value = Array.isArray(header) ? header[0] : header;
	const kind = typeof value === "string" ? value.toLowerCase().trim() : "";
	try {
		if (kind === "gzip" || kind === "x-gzip") return gunzipSync(raw);
		if (kind === "deflate") return inflateSync(raw);
		if (kind === "br") return brotliDecompressSync(raw);
	} catch {
		return raw;
	}
	return raw;
}
function noop() {}
/** A permanent no-op error sink, so a stray socket error can never crash DSH. */
function attachErrorSink(socket) {
	socket.on("error", noop);
}
async function dialProxy(proxy, timeoutMs, signal) {
	const socket = connect({
		host: proxy.host,
		port: proxy.port
	});
	attachErrorSink(socket);
	function onAbort() {
		socket.destroy(new TransportError("timeout", "请求已取消。", { name: "AbortError" }));
	}
	try {
		if (signal !== void 0) {
			if (signal.aborted) throw new TransportError("timeout", "请求已取消。", { name: "AbortError" });
			signal.addEventListener("abort", onAbort, { once: true });
		}
		socket.setTimeout(timeoutMs, () => {
			socket.destroy(new TransportError("timeout", `连接代理超时（${timeoutMs} ms）。`, { name: "TimeoutError" }));
		});
		await once(socket, "connect");
	} catch (error) {
		socket.destroy();
		throw toTransportError(error, { reason: `代理地址 ${redactAddress(proxy.raw)}` });
	} finally {
		if (signal !== void 0) signal.removeEventListener("abort", onAbort);
	}
	socket.setTimeout(0);
	return socket;
}
function waitReadable(socket, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		function cleanup() {
			if (timer !== void 0) clearTimeout(timer);
			socket.off("readable", onReadable);
			socket.off("error", onError);
			socket.off("close", onClose);
		}
		function settle(error) {
			if (settled) return;
			settled = true;
			cleanup();
			if (error === void 0) resolve();
			else reject(error);
		}
		function onReadable() {
			settle();
		}
		function onError(error) {
			settle(toTransportError(error));
		}
		function onClose() {
			settle(new TransportError("network", "代理在握手完成前关闭了连接。"));
		}
		timer = setTimeout(() => {
			settle(new TransportError("timeout", `代理握手超时（${timeoutMs} ms）。`, { name: "TimeoutError" }));
		}, timeoutMs);
		socket.on("readable", onReadable);
		socket.on("error", onError);
		socket.on("close", onClose);
		if (socket.readableLength > 0) settle();
	});
}
async function readExact(socket, size, timeoutMs) {
	const chunks = [];
	let total = 0;
	while (total < size) {
		const chunk = socket.read();
		if (chunk === null) {
			await waitReadable(socket, timeoutMs);
			continue;
		}
		chunks.push(chunk);
		total += chunk.length;
	}
	const joined = Buffer.concat(chunks);
	if (joined.length > size) socket.unshift(joined.subarray(size));
	return joined.subarray(0, size);
}
async function readHead(socket, delimiter, timeoutMs) {
	const chunks = [];
	let total = 0;
	for (;;) {
		const chunk = socket.read();
		if (chunk === null) {
			await waitReadable(socket, timeoutMs);
			continue;
		}
		chunks.push(chunk);
		total += chunk.length;
		const joined = Buffer.concat(chunks);
		const index = joined.indexOf(delimiter);
		if (index >= 0) {
			const rest = joined.subarray(index + delimiter.length);
			if (rest.length > 0) socket.unshift(rest);
			return joined.subarray(0, index).toString("latin1");
		}
		if (total > 8192) throw new TransportError("parse-failed", "代理握手响应过大，已放弃。");
	}
}
async function httpProxyConnect(socket, target, proxy, timeoutMs) {
	const authority = `${target.host}:${target.port}`;
	const lines = [
		`CONNECT ${authority} HTTP/1.1`,
		`Host: ${authority}`,
		"Proxy-Connection: keep-alive"
	];
	if (proxy.auth !== void 0) lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth, "utf8").toString("base64")}`);
	socket.write(`${lines.join("\r\n")}\r\n\r\n`);
	const statusLine = (await readHead(socket, "\r\n\r\n", timeoutMs)).split("\r\n", 1)[0] ?? "";
	const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
	if (match === null) throw new TransportError("parse-failed", "HTTP 代理返回了无法解析的握手响应。");
	const status = Number(match[1]);
	if (status === 407) throw new TransportError("auth-required", "HTTP 代理要求认证（407）；请在代理地址里带上 user:pass。");
	if (status !== 200) throw new TransportError("network", `HTTP 代理拒绝建立隧道（HTTP ${status}）。`);
}
async function socks5Connect(socket, target, proxy, timeoutMs) {
	const auth = typeof proxy.auth === "string" && proxy.auth.length > 0 ? proxy.auth : void 0;
	socket.write(auth === void 0 ? Buffer.from([
		5,
		1,
		0
	]) : Buffer.from([
		5,
		2,
		0,
		2
	]));
	const method = await readExact(socket, 2, timeoutMs);
	if (method[0] !== 5) throw new TransportError("network", "SOCKS5 代理返回了无法识别的协议版本。");
	if (method[1] === 255) throw new TransportError("auth-required", "SOCKS5 代理拒绝了所有可用的认证方式。");
	if (method[1] === 2) {
		if (auth === void 0) throw new TransportError("auth-required", "SOCKS5 代理要求用户名/密码认证，但代理地址里没有凭据。");
		const separator = auth.indexOf(":");
		const user = separator >= 0 ? auth.slice(0, separator) : auth;
		const password = separator >= 0 ? auth.slice(separator + 1) : "";
		const userBuffer = Buffer.from(user, "utf8");
		const passwordBuffer = Buffer.from(password, "utf8");
		socket.write(Buffer.concat([
			Buffer.from([1, userBuffer.length]),
			userBuffer,
			Buffer.from([passwordBuffer.length]),
			passwordBuffer
		]));
		if ((await readExact(socket, 2, timeoutMs))[1] !== 0) throw new TransportError("auth-required", "SOCKS5 用户名/密码认证被拒绝。");
	} else if (method[1] !== 0) throw new TransportError("auth-required", `SOCKS5 代理要求不支持的认证方式（0x${method[1].toString(16)}）。`);
	const hostBuffer = Buffer.from(target.host, "utf8");
	const portBuffer = Buffer.alloc(2);
	portBuffer.writeUInt16BE(target.port);
	socket.write(Buffer.concat([
		Buffer.from([
			5,
			1,
			0,
			3,
			hostBuffer.length
		]),
		hostBuffer,
		portBuffer
	]));
	const reply = await readExact(socket, 4, timeoutMs);
	if (reply[1] !== 0) throw new TransportError("network", `SOCKS5 代理拒绝建立隧道（状态码 0x${reply[1].toString(16)}）。`);
	const addressType = reply[3];
	if (addressType === 1) await readExact(socket, 6, timeoutMs);
	else if (addressType === 4) await readExact(socket, 18, timeoutMs);
	else if (addressType === 3) await readExact(socket, (await readExact(socket, 1, timeoutMs))[0] + 2, timeoutMs);
	else throw new TransportError("parse-failed", "SOCKS5 代理返回了无法识别的地址类型。");
}
function startTls(socket, servername, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const tlsSocket = connect$1({
			socket,
			servername
		});
		attachErrorSink(tlsSocket);
		function settle(error) {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			if (error === void 0) resolve(tlsSocket);
			else {
				tlsSocket.destroy();
				reject(error);
			}
		}
		function onError(error) {
			if (settled) return;
			settle(error instanceof TransportError ? error : toTransportError(error));
		}
		tlsSocket.once("secureConnect", () => settle());
		tlsSocket.on("error", onError);
		timer = setTimeout(() => {
			settle(new TransportError("timeout", `经代理的 TLS 握手超时（${timeoutMs} ms）。`, { name: "TimeoutError" }));
		}, timeoutMs);
	});
}
async function openTunnel(proxy, target, timeoutMs, signal) {
	const socket = await dialProxy(proxy, timeoutMs, signal);
	try {
		if (proxy.scheme === "socks5") await socks5Connect(socket, target, proxy, timeoutMs);
		else await httpProxyConnect(socket, target, proxy, timeoutMs);
		if (!target.tls) return socket;
		return await startTls(socket, target.host, timeoutMs);
	} catch (error) {
		socket.destroy();
		throw toTransportError(error);
	}
}
/**
* The official hosts (and their subdomains) the POST seam may talk to.
*
* `github.com` / `gitee.com` are the OAuth hosts; `api.` / `login.` / `oauth.`
* only ever appear as SUBDOMAINS or paths of those two, so a suffix match is the
* correct test — and it is checked before any socket is opened.
*/
const POST_ALLOWED_HOSTS = ["github.com", "gitee.com"];
/** True when `host` is one of the official provider hosts (or a subdomain). */
function isOfficialPostHost(host) {
	const lower = host.trim().toLowerCase();
	return POST_ALLOWED_HOSTS.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}
/**
* Build the OAuth POST transport.
*
* `deps.localProxy` is read on EVERY request rather than captured, so a getter
* (or a later edit of the object) is honoured: the proxy address is a live user
* setting, and pinning a stale snapshot here would send a credential exchange
* outside the tunnel the user asked for.
*/
function createPostTransport(deps = {}) {
	return async function post(request) {
		let url;
		try {
			url = new URL(request.url);
		} catch {
			throw new TransportError("parse-failed", "OAuth 端点地址无法解析，未发起请求。");
		}
		if (url.protocol !== "https:") throw new TransportError("network", `OAuth 的 POST 只允许 https，收到 ${url.protocol}，已拒绝。`);
		if (!isOfficialPostHost(url.hostname)) throw new TransportError("network", `OAuth 的 POST 只允许官方主机（${POST_ALLOWED_HOSTS.join(" / ")}），收到 ${url.hostname}，已拒绝：带凭据的请求绝不经过镜像或第三方转发。`);
		const timeoutMs = clampTimeoutMs(request.timeoutMs);
		const signal = composeSignal([request.signal, timeoutSignal(timeoutMs)]);
		const headers = {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
			...request.headers ?? {}
		};
		const body = new URLSearchParams({ ...request.form }).toString();
		const proxyText = (request.proxy ?? deps.localProxy ?? "").trim();
		const proxy = parseProxyAddress(proxyText);
		if (proxyText.length > 0 && proxy === void 0) throw new TransportError("network", "本机代理地址无法解析（形如 127.0.0.1:7890、http://host:port 或 socks5://host:port）。本次不发起请求，也不会绕过代理静默直连。");
		if (proxy !== void 0) {
			const support = proxySupport(proxy);
			if (!support.supported) throw new TransportError("network", support.reason ?? "本机代理不受支持，未发起请求。");
		}
		if (proxy !== void 0) {
			const plan = planRequest({
				url: url.toString(),
				headers,
				transport: "node",
				localProxy: proxyText,
				timeoutMs
			});
			return postViaProxy(url, plan, proxy, signal, timeoutMs, body);
		}
		const impl = deps.fetchImpl ?? defaultFetch();
		try {
			const response = await impl(url.toString(), {
				method: "POST",
				headers,
				body,
				redirect: "error",
				...signal === void 0 ? {} : { signal }
			});
			return {
				statusCode: response.status,
				body: await response.text()
			};
		} catch (error) {
			throw toTransportError(error, { reason: "OAuth 表单 POST 失败。" });
		}
	};
}
/** POST over the hand-rolled tunnel. One hop, no redirect following. */
async function postViaProxy(url, plan, proxy, signal, timeoutMs, body) {
	if (plan.blocked) throw new TransportError("network", plan.reason ?? "本机配置阻止了本次请求。");
	const answer = await proxyRequestOnce(url, plan, proxy, signal, timeoutMs, {
		method: "POST",
		body
	});
	return {
		statusCode: answer.statusCode,
		body: answer.body
	};
}
//#endregion
//#region src/oauth.ts
/**
* dsh-codehub — browser-login (OAuth) flow engine.
*
* INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). Implementations of the
* stubs below must keep these signatures: `src/routes.ts` and `src/index.ts`
* wire them, and `test/oauth-flow.test.ts` crosses this same seam with a fake
* `PostLike`.
*
* WHAT PROBLEM THIS SOLVES
* ------------------------
* "Click a button, log in in the browser, and end up with a token in the
* credential service" is three different flows behind one idea:
*
*   • GitHub — RFC 8628 device flow: POST /login/device/code, show the user
*     code, poll POST /login/oauth/access_token. No client secret, but the
*     user's OAuth App must have Device Flow enabled.
*   • Gitee — authorization code: redirect the browser to /oauth/authorize,
*     receive `?code=` on the LOOPBACK callback, exchange it at /oauth/token
*     with client_id + client_secret. Gitee supports neither device flow nor
*     PKCE, so a secret is unavoidable — it lives in `ctx.credentials` only.
*
* INVARIANTS (asserted by tests, not just documented)
* ---------------------------------------------------
* 1. **A credential value never leaves this module.** The only place a token is
*    handed to is `writeCredential()`; no result object, `reason` string or log
*    line may contain it. Responses to the browser carry booleans and status
*    codes only.
* 2. **No second request after a failed preflight.** If the provider host is
*    unreachable, `start()` answers `unavailable` and issues nothing else.
* 3. **Only official hosts.** The injected `post` seam is called with
*    github.com / gitee.com URLs exclusively; mirrors and third-party forwards
*    are never used for a credential exchange.
* 4. **Flow state is memory-only.** No file, no store, no settings namespace:
*    a flow is a process-local, time-boxed, single-use record. The Gitee client
*    secret is the one sensitive value that record holds (the callback exchange
*    happens later, after the browser returns), so it lives exactly as long as
*    the flow does and dies with it.
* 5. **`state` is checked.** A callback whose `state` does not match the live
*    flow is refused (`400`) and writes nothing.
*/
const SUCCESS_HTML = "<!doctype html><meta charset=\"utf-8\"><title>登录成功</title><p>登录成功，可关闭本窗口。</p><script>window.close()<\/script>";
const FAILURE_HTML = "<!doctype html><meta charset=\"utf-8\"><title>登录失败</title><p>登录失败，请回到插件重试。</p><script>window.close()<\/script>";
const ERROR_PROVIDER = "授权服务返回了错误，已中止本次流程。";
const ERROR_CANCELLED = "流程已被取消。";
const ERROR_TIMEOUT = "流程等待超时（15 分钟），请重新发起登录。";
/** A token that arrived but could not be stored — not a network failure. */
const ERROR_CREDENTIAL_WRITE = "已取到 token，但写入 DSH 凭据服务失败；请确认 credentials 服务可用后重试。";
const PROVIDER_TIMEOUT_MS = 15e3;
/** Poll floor: never hammer the provider faster than this, whatever it says. */
const MIN_INTERVAL_MS = 1e3;
const DEFAULT_INTERVAL_MS = 5e3;
/** Value-free network failure text; the thrown error message is provider-free. */
const NETWORK_REASON = "与授权服务的请求失败（网络不可达或超时），请稍后重试或改用 PAT。";
/** Parse a token response that may be JSON or form-encoded (GitHub does both). */
function parseTokenBody(body) {
	const text = body.trim();
	if (text.startsWith("{")) try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") {
			const out = {};
			for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
			else if (typeof value === "number") out[key] = String(value);
			return out;
		}
	} catch {}
	const out = {};
	for (const [key, value] of new URLSearchParams(text)) out[key] = value;
	return out;
}
/**
* The default README asks the user to register the loopback callback, so the
* plugin must build the same absolute URL from the initiating request's Host
* header when the caller did not pin one.
*/
function defaultRedirectUri(requestHost) {
	const host = (requestHost ?? "").trim().replace(/\/+$/, "");
	if (host === "") return OAUTH_CALLBACK_PATH;
	return `${/^https?:\/\//i.test(host) ? host : `http://${host}`}${OAUTH_CALLBACK_PATH}`;
}
/**
* Phase 0 stub replaced by W1: the real device-flow / authorization-code state
* machines. Signatures and invariants above are what is fixed.
*/
function createOAuthService(deps) {
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ?? defaultSleep$1;
	const logger = deps.logger ?? (() => {});
	const flows = /* @__PURE__ */ new Map();
	const newFlowId = () => `flow_${randomBytes(9).toString("hex")}`;
	const newState = () => randomBytes(16).toString("hex");
	/** Drop finished flows long after their TTL: the map must not grow forever. */
	const reclaim = () => {
		const at = now();
		for (const [key, flow] of flows) if (flow.ended && at - flow.createdAt > 9e5) flows.delete(key);
	};
	const finish = (flow, state, reason) => {
		flow.stateValue = state;
		flow.reason = reason;
		flow.ended = true;
	};
	/**
	* A redirect flow has no background poller to notice the deadline, so the
	* TTL is enforced lazily wherever the flow is observed.
	*/
	const expireIfDue = (flow) => {
		if (flow.ended || now() <= flow.deadline) return;
		finish(flow, "expired", ERROR_TIMEOUT);
		logger("oauth.flow.expired", {
			flowId: flow.flowId,
			source: flow.source
		});
	};
	const statusOf = (flow) => ({
		flowId: flow.flowId,
		state: flow.stateValue,
		credentialConfigured: flow.credentialConfigured,
		reason: flow.reason,
		intervalMs: flow.intervalMs
	});
	const activate = (flow, outer) => {
		const abort = () => flow.controller.abort();
		if (outer === void 0) return;
		if (outer.aborted) abort();
		else outer.addEventListener("abort", abort, { once: true });
	};
	/** One POST on the official-host seam; every failure is value-free. */
	const postForm = async (url, form, headers, signal) => {
		return await deps.post({
			url,
			form,
			headers,
			timeoutMs: PROVIDER_TIMEOUT_MS,
			signal
		});
	};
	/**
	* Exchange an authorization code. The returned token is written to the
	* credential service here and is never returned, logged or embedded in a
	* reason string (invariant 1).
	*/
	const exchangeAuthorizationCode = async (input, source, ref) => {
		const signal = input.signal;
		try {
			signal?.throwIfAborted();
		} catch {
			return {
				ok: false,
				credentialConfigured: false,
				reason: ERROR_CANCELLED
			};
		}
		const form = {
			grant_type: "authorization_code",
			code: input.code,
			client_id: input.clientId,
			redirect_uri: input.redirectUri
		};
		if (input.clientSecret !== void 0 && input.clientSecret !== "") form.client_secret = input.clientSecret;
		let response;
		try {
			response = await postForm(GITEE_OAUTH_TOKEN_ENDPOINT, form, { accept: "application/json" }, signal ?? new AbortController().signal);
		} catch {
			logger("oauth.exchange.failed", {
				source,
				host: "gitee.com"
			});
			return {
				ok: false,
				credentialConfigured: false,
				reason: NETWORK_REASON
			};
		}
		const payload = parseTokenBody(response.body);
		if (response.statusCode !== 200 || payload.access_token === void 0 || payload.access_token === "") {
			logger("oauth.exchange.rejected", {
				source,
				host: "gitee.com",
				statusCode: response.statusCode
			});
			return {
				ok: false,
				credentialConfigured: false,
				reason: `授权码换取凭据失败（HTTP ${response.statusCode}）：请检查 client_id / client_secret 与回调地址是否与 Gitee 应用一致。`
			};
		}
		const token = payload.access_token;
		try {
			signal?.throwIfAborted();
		} catch {
			return {
				ok: false,
				credentialConfigured: false,
				reason: ERROR_CANCELLED
			};
		}
		await deps.writeCredential(ref, token);
		logger("oauth.exchange.done", {
			source,
			host: "gitee.com",
			statusCode: 200
		});
		return {
			ok: true,
			credentialConfigured: true,
			reason: "凭据已写入 DSH 凭据服务。"
		};
	};
	const startGithubDevice = async (input, flow, ref) => {
		const probe = await deps.probeHost("github.com", flow.controller.signal);
		if (!probe.reachable) {
			logger("oauth.preflight.failed", {
				source: "github",
				host: "github.com"
			});
			return {
				ok: false,
				reason: `无法连接 github.com：${probe.detail}。设备码流程需要本机直连 github.com，请改用个人访问令牌（PAT）。`,
				fallback: ["pat"]
			};
		}
		let codeResponse;
		try {
			codeResponse = await postForm(GITHUB_DEVICE_CODE_ENDPOINT, {
				client_id: input.clientId,
				scope: ""
			}, { accept: "application/json" }, flow.controller.signal);
		} catch {
			logger("oauth.device_code.failed", {
				source: "github",
				host: "github.com"
			});
			return {
				ok: false,
				reason: NETWORK_REASON,
				fallback: ["pat"]
			};
		}
		const payload = parseTokenBody(codeResponse.body);
		const deviceCode = payload.device_code;
		const userCode = payload.user_code;
		if (codeResponse.statusCode !== 200 || deviceCode === void 0 || userCode === void 0) {
			logger("oauth.device_code.rejected", {
				source: "github",
				host: "github.com",
				statusCode: codeResponse.statusCode
			});
			return {
				ok: false,
				reason: payload.error === "device_flow_disabled" ? "你的 OAuth App 没有开启设备码流程：请在该 App 的编辑页勾选 Enable Device Flow 后重试。" : `设备码申请失败（HTTP ${codeResponse.statusCode}）：请确认 Client ID 来自你自己的 OAuth App。`,
				fallback: ["pat"]
			};
		}
		const expiresInMs = clampFinite(Number(payload.expires_in), OAUTH_FLOW_TTL_MS / 1e3, 0, OAUTH_FLOW_TTL_MS / 1e3) * 1e3;
		const intervalMs = Math.max(MIN_INTERVAL_MS, clampFinite(Number(payload.interval), DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, 6e4));
		flow.intervalMs = intervalMs;
		flow.userCode = userCode;
		flow.verificationUri = payload.verification_uri ?? "https://github.com/login/device";
		flow.reason = "等待你在浏览器中完成授权。";
		pollDeviceToken(flow, deviceCode, ref);
		return {
			ok: true,
			kind: "device",
			flowId: flow.flowId,
			userCode,
			verificationUri: flow.verificationUri,
			expiresInMs,
			intervalMs
		};
	};
	/** The RFC 8628 polling loop. Never emits the device code or the token. */
	const pollDeviceToken = async (flow, deviceCode, ref) => {
		const signal = flow.controller.signal;
		try {
			while (!flow.ended && !signal.aborted) {
				if (now() > flow.deadline) {
					finish(flow, "expired", ERROR_TIMEOUT);
					logger("oauth.device.expired", {
						source: "github",
						host: "github.com"
					});
					return;
				}
				if (now() + flow.intervalMs > flow.deadline) {
					finish(flow, "expired", ERROR_TIMEOUT);
					logger("oauth.device.expired", {
						source: "github",
						host: "github.com"
					});
					return;
				}
				try {
					await sleep(flow.intervalMs, signal);
				} catch {
					return;
				}
				if (signal.aborted || flow.ended) return;
				let response;
				try {
					response = await postForm(GITHUB_DEVICE_TOKEN_ENDPOINT, {
						client_id: flow.clientId,
						device_code: deviceCode,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code"
					}, { accept: "application/json" }, signal);
				} catch {
					if (signal.aborted) return;
					finish(flow, "error", NETWORK_REASON);
					logger("oauth.device.network_failed", {
						source: "github",
						host: "github.com"
					});
					return;
				}
				const payload = parseTokenBody(response.body);
				if (response.statusCode === 200 && payload.access_token !== void 0 && payload.access_token !== "") {
					const token = payload.access_token;
					if (signal.aborted) return;
					try {
						await deps.writeCredential(ref, token);
					} catch {
						finish(flow, "error", ERROR_CREDENTIAL_WRITE);
						logger("oauth.device.credential_write_failed", { source: "github" });
						return;
					}
					flow.credentialConfigured = true;
					finish(flow, "done", "凭据已写入 DSH 凭据服务。");
					logger("oauth.device.done", {
						source: "github",
						host: "github.com",
						statusCode: 200
					});
					return;
				}
				switch (payload.error ?? "") {
					case "authorization_pending":
						flow.reason = "等待你在浏览器中完成授权。";
						continue;
					case "slow_down":
						flow.intervalMs += OAUTH_SLOW_DOWN_STEP_MS;
						flow.stateValue = "slow_down";
						flow.reason = "授权服务要求放慢轮询，已自动延长间隔。";
						logger("oauth.device.slow_down", {
							source: "github",
							host: "github.com",
							intervalMs: flow.intervalMs
						});
						continue;
					case "expired_token":
						finish(flow, "expired", "设备码已过期，请重新发起登录。");
						logger("oauth.device.expired", {
							source: "github",
							host: "github.com"
						});
						return;
					case "access_denied":
						finish(flow, "error", "你在浏览器中拒绝了本次授权。若这是误操作，请重新发起登录。");
						logger("oauth.device.denied", {
							source: "github",
							host: "github.com"
						});
						return;
					case "device_flow_disabled":
						finish(flow, "error", "你的 OAuth App 没有开启设备码流程：请在该 App 的编辑页勾选 Enable Device Flow 并保存后重试。");
						logger("oauth.device.flow_disabled", {
							source: "github",
							host: "github.com"
						});
						return;
					case "incorrect_client_credentials":
						finish(flow, "error", "Client ID 不正确：请核对插件里填写的 GitHub OAuth App Client ID。");
						logger("oauth.device.bad_client", {
							source: "github",
							host: "github.com"
						});
						return;
					case "unsupported_grant_type":
						finish(flow, "error", "GitHub 不接受该授权类型，请确认该 App 已启用设备码流程。");
						logger("oauth.device.bad_grant", {
							source: "github",
							host: "github.com"
						});
						return;
					case "incorrect_device_code":
						finish(flow, "error", "设备码不正确或已被使用，请重新发起登录。");
						logger("oauth.device.bad_code", {
							source: "github",
							host: "github.com"
						});
						return;
					default:
						finish(flow, "error", `授权失败（HTTP ${response.statusCode}）：请回到插件重新发起登录，或改用个人访问令牌（PAT）。`);
						logger("oauth.device.unknown_error", {
							source: "github",
							host: "github.com",
							statusCode: response.statusCode
						});
						return;
				}
			}
		} catch {
			if (!flow.ended) finish(flow, "error", NETWORK_REASON);
		}
	};
	const startGiteeCode = async (input, flow) => {
		const probe = await deps.probeHost("gitee.com", flow.controller.signal);
		if (!probe.reachable) {
			logger("oauth.preflight.failed", {
				source: "gitee",
				host: "gitee.com"
			});
			return {
				ok: false,
				reason: `无法连接 gitee.com：${probe.detail}。授权码流程需要本机直连 gitee.com，请改用个人访问令牌（PAT）。`,
				fallback: ["pat"]
			};
		}
		const redirectUri = input.redirectUri ?? defaultRedirectUri(input.requestHost);
		const authorizeUrl = new URL(GITEE_OAUTH_AUTHORIZE_ENDPOINT);
		authorizeUrl.searchParams.set("client_id", input.clientId);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("state", flow.state ?? "");
		flow.reason = "等待你在浏览器中完成授权。";
		return {
			ok: true,
			kind: "redirect",
			flowId: flow.flowId,
			authorizeUrl: authorizeUrl.toString(),
			redirectUri,
			expiresInMs: OAUTH_FLOW_TTL_MS
		};
	};
	const refFor = (source) => deps.credentialRefFor(source);
	return {
		async start(input) {
			reclaim();
			if (input.method === "oauth-device" && input.source !== "github") return {
				ok: false,
				reason: "只有 GitHub 支持设备码流程。",
				fallback: ["pat"]
			};
			if (input.method === "oauth-code" && input.source !== "gitee") return {
				ok: false,
				reason: "只有 Gitee 支持授权码流程。",
				fallback: ["pat"]
			};
			const flow = {
				flowId: newFlowId(),
				source: input.source,
				method: input.method,
				clientId: input.clientId,
				createdAt: now(),
				deadline: now() + OAUTH_FLOW_TTL_MS,
				intervalMs: DEFAULT_INTERVAL_MS,
				stateValue: "pending",
				reason: "流程已创建，等待你在浏览器中完成授权。",
				credentialConfigured: false,
				ended: false,
				controller: new AbortController()
			};
			if (input.clientSecret !== void 0) flow.clientSecret = input.clientSecret;
			activate(flow, input.signal);
			flows.set(flow.flowId, flow);
			logger("oauth.start", {
				source: input.source,
				method: input.method,
				flowId: flow.flowId
			});
			if (input.method === "oauth-device") return await startGithubDevice(input, flow, refFor("github"));
			const redirectUri = input.redirectUri ?? defaultRedirectUri(input.requestHost);
			const state = newState();
			const withState = {
				...flow,
				state,
				redirectUri
			};
			flows.set(flow.flowId, withState);
			return await startGiteeCode(input, withState);
		},
		/**
		* `state` decides which flow a callback belongs to, so the lookup is by
		* state and never by "the newest flow".
		*/
		async handleCallback(params) {
			reclaim();
			const state = params.state ?? "";
			const flow = state === "" ? void 0 : [...flows.values()].find((candidate) => candidate.state === state);
			if (flow === void 0) {
				logger("oauth.callback.rejected", { reason: "state-mismatch" });
				return {
					status: 400,
					html: FAILURE_HTML
				};
			}
			if (params.error !== void 0 && params.error !== "") {
				finish(flow, "error", ERROR_PROVIDER);
				logger("oauth.callback.provider_error", { source: flow.source });
				return {
					status: 400,
					html: FAILURE_HTML
				};
			}
			if (flow.ended) {
				logger("oauth.callback.rejected", { reason: "replayed" });
				return {
					status: 400,
					html: FAILURE_HTML
				};
			}
			expireIfDue(flow);
			if (flow.ended) {
				logger("oauth.callback.rejected", { reason: "expired" });
				return {
					status: 400,
					html: FAILURE_HTML
				};
			}
			if (params.code === void 0 || params.code === "") {
				logger("oauth.callback.missing_code", { source: flow.source });
				return {
					status: 400,
					html: FAILURE_HTML
				};
			}
			flow.ended = true;
			const secret = flow.clientSecret ?? await deps.readCredential?.(refFor("gitee")) ?? "";
			const outcome = await exchangeAuthorizationCode({
				code: params.code,
				clientId: flow.clientId,
				clientSecret: secret,
				redirectUri: flow.redirectUri ?? defaultRedirectUri(void 0)
			}, "gitee", refFor("gitee"));
			flow.credentialConfigured = outcome.credentialConfigured;
			finish(flow, outcome.ok ? "done" : "error", outcome.reason);
			return outcome.ok ? {
				status: 200,
				html: SUCCESS_HTML
			} : {
				status: 400,
				html: FAILURE_HTML
			};
		},
		async completeWithCode(input) {
			return await exchangeAuthorizationCode(input, "gitee", refFor("gitee"));
		},
		async status(flowId) {
			reclaim();
			const flow = flows.get(flowId);
			if (flow === void 0) return {
				flowId,
				state: "error",
				credentialConfigured: false,
				reason: "没有这个流程：它可能已过期，或插件重启过。请重新发起登录。",
				intervalMs: 0
			};
			expireIfDue(flow);
			return statusOf(flow);
		},
		cancel(flowId) {
			const flow = flows.get(flowId);
			if (flow === void 0) return;
			finish(flow, "error", ERROR_CANCELLED);
			flow.controller.abort();
			logger("oauth.cancel", { flowId });
		}
	};
}
function clampFinite(value, fallback, min, max) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
/** Real sleep; aborts promptly so `cancel()` never waits out a full interval. */
function defaultSleep$1(ms, signal) {
	if (signal?.aborted === true) return Promise.reject(/* @__PURE__ */ new Error("aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/config.ts
/**
* dsh-codehub — configuration schema, decision resolution and hard-cap clamping.
*
* OWNER: `host-core`. Read-only consumers: `service.ts`, `routes.ts`, `index.ts`.
*
* WHY A SCHEMA AND NOT A HAND-BUILT FORM
* --------------------------------------
* The `settings` service on this runtime has NO `installSection` and NO
* `register` (see types/dsh/index.d.ts). The settings form is derived
* AUTOMATICALLY from the schemastery schema this module exports as `Config`.
* That schema is therefore the settings UI, and every `.description()` below is
* user-visible copy.
*
* THREE THINGS THIS MODULE GUARANTEES
* ----------------------------------
* 1. **No secret is representable.** There is no `token` / `cookie` field
*    anywhere in the schema: credentials live in `ctx.credentials` only, and
*    `isSecretKey()` additionally rejects any patch key that even looks like a
*    secret, so a malformed PATCH cannot smuggle one into the profile patch or
*    into `$DSH_HOME/dsh-codehub.json`.
* 2. **An unanswered decision stays unanswered.** `failover.enabled` and
*    `mergeSources` are booleans WITHOUT a default, so they resolve to
*    `undefined` until the user touches them. `false` is a decided answer
*    ("do not degrade") and is kept distinct from `undefined` ("never asked").
*    `sourcePriority` / `github.accessPriority` default to the EMPTY array,
*    which is likewise read as undecided by `gating.ts` — never as "all".
* 3. **Hard caps are the ceiling.** Every number goes through `resolveLimits()`,
*    which clamps into `HARD_LIMITS`. A user may lower a limit; nothing,
*    including the CLI or a hand-edited patch, can raise it.
*
* 备注① lives here too: the local-proxy field's description is built from
* `LOCAL_PROXY_LABEL` + `LOCAL_PROXY_HELP`, so the phrase 仅 Node 直连传输生效
* reaches the derived settings form without a second hand-written copy.
*/
/**
* `@deepseek-ai/schemastery`, NOT the unscoped `schemastery`.
*
* They are different packages: upstream `schemastery` tops out at 3.18.0, while
* DSH publishes its own fork at 3.18.2 — and that fork is what
* `@deepseek-ai/dsh-tools` depends on. Importing the unscoped package made this
* plugin's schema a DIFFERENT `Schema` type from the one the SDK uses, so
* TypeScript resolved the schema's inferred type through the fork's pnpm store
* path and declaration emit failed with TS2742 ("cannot be named without a
* reference to .pnpm/@deepseek-ai+schemastery@3.18.2/...").
*
* Shipping host plugins import the fork (`dsh-context` does), and it is also the
* package carrying the `role(...)` secret-field support DSH's settings surface
* understands. Declared as a peer dependency: the host provides it.
*/
const ENTRY_PLACEMENTS = [
	"both",
	"sidebar",
	"settings"
];
/** Defaults the schema declares, kept in one object so copy and code agree. */
const SCHEMA_DEFAULTS = {
	enabled: true,
	/**
	* Kept for schema compatibility, and now always true.
	*
	* It used to gate a first-run dialog that asked the user where the plugin
	* should appear. That dialog is gone: both surfaces are on by default and the
	* choice is an ordinary setting (`entryPlacement`) the user changes in the
	* plugin's settings page. Nothing asks on startup.
	*/
	onboarded: true,
	entryPlacement: "both",
	announceToAgent: true,
	htmlFallback: true,
	banner: true,
	/**
	* CSDN article pages carry the code blocks, so the second fetch is on by
	* default; it is a switch rather than a silent behaviour so a user can trade
	* one extra request per hit for fewer requests.
	*/
	articleFetch: true,
	/** CDP cookie capture is a real security trade: opt-in, never on by default. */
	cdpEnabled: false,
	cdpPort: CDP_DEFAULT_PORT,
	/**
	* Auto-save the settings form. ON by default because the user asked for it
	* ("每改一处自动保存"), and switchable because the first version was not — which
	* left the manual button permanently disabled and the save bar useless.
	*/
	autoSave: true
};
/**
* 备注① — the description of the local-proxy control.
*
* Built by concatenation, never re-typed: it must contain BOTH
* `LOCAL_PROXY_LABEL` (本机代理 / SOCKS5 地址) and `LOCAL_PROXY_HELP` (which
* carries `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效).
*/
const LOCAL_PROXY_FIELD_DESCRIPTION = `${LOCAL_PROXY_LABEL}：${LOCAL_PROXY_HELP}`;
/**
* `Schema.union([...])` over a readonly tuple of literals is the documented
* schemastery enum form and is used for every closed vocabulary here, so the
* derived form renders a select rather than a free-text box. The resolver
* filters against the same contract arrays anyway (`readStringList()`), which is
* what makes an unknown value from a hand-edited patch harmless.
*/
const Config = Schema.object({
	enabled: Schema.boolean().default(SCHEMA_DEFAULTS.enabled).description("是否启用 dsh-codehub。关闭后工具仍可被调用，但会直接拒绝并且不发任何网络请求。"),
	onboarded: Schema.boolean().default(SCHEMA_DEFAULTS.onboarded).description("历史字段，保留兼容。首次选择对话框已移除，默认即为「侧边栏 + 设置页」，不再询问。"),
	entryPlacement: Schema.union(ENTRY_PLACEMENTS).default(SCHEMA_DEFAULTS.entryPlacement).description("插件显示在哪里：both=侧边栏面板+设置页（默认）；sidebar=仅侧边栏；settings=仅设置页。侧边栏入口是顶部的 GitHub 猫标 + codehub。改完在插件设置里点「保存显示位置」生效。"),
	announceToAgent: Schema.boolean().default(SCHEMA_DEFAULTS.announceToAgent).description("是否把防搬运声明写入系统提示词段（plugin:dsh-codehub）。备注③要求该声明同时出现在工具描述与提示词段里，默认开启。"),
	sourcePriority: Schema.array(Schema.union(SOURCES)).default([]).description("三个源的查询优先级，数组顺序即优先级。留空 = 尚未决定：工具会先问用户，且不发任何网络请求。"),
	github: Schema.object({
		accessPriority: Schema.array(Schema.union(GITHUB_ACCESS)).default([]).description("GitHub 访问方式优先级，数组顺序即尝试顺序。留空 = 尚未决定。注意 ghproxy / raw-mirror / third-party-mirror 三条路径会被强制剥离 token。"),
		apiBase: Schema.string().default("").description("覆盖 GitHub API 基址（留空 = 内置 https://api.github.com）。与 raw 文件基址是两条独立路径。"),
		webProxyBases: Schema.array(Schema.string()).default([]).description("网页 / API 代理基址（ghproxy、ghfast.top 等），按序尝试。不预填任何数据；空 = 该方式不可用，不兜底。"),
		rawMirrorBases: Schema.array(Schema.string()).default([]).description("raw 文件镜像基址。本机实测 raw.githubusercontent.com 不可直连，必须依赖此项；空 = raw 下载不可用。"),
		localProxy: Schema.string().default("").description(LOCAL_PROXY_FIELD_DESCRIPTION),
		oauthClientId: Schema.string().default("").description("你的 GitHub OAuth App 的 Client ID（公开值，不是 secret）。在 https://github.com/settings/developers 新建 OAuth App 后获得。设备码流程不需要 client_secret，但必须在该 App 里勾选 Enable Device Flow，否则 https://github.com/login/device/code 会直接报错。留空 = 不使用 GitHub 浏览器登录，仍可粘贴 Personal Access Token。")
	}).description("GitHub 访问方式与镜像基址（docs/DESIGN.md §3）。"),
	gitee: Schema.object({
		apiBase: Schema.string().default("").description(`覆盖 Gitee v5 API 基址（留空 = 内置 ${GITEE_API_BASE}）。只使用真实存在的 v5 端点。`),
		htmlFallback: Schema.boolean().default(SCHEMA_DEFAULTS.htmlFallback).description("JSON 端点返回空结果时，是否允许回退抓取 HTML 页面；回退结果会标注来源并降低置信度。"),
		oauthClientId: Schema.string().default("").description(`你的 Gitee 第三方应用的 Client ID（公开值）。在 https://gitee.com/oauth/applications 创建应用后获得；Gitee 没有设备码、也不支持 PKCE，只能走授权码流程，因此必须同时提供 client secret —— secret 绝不写进本配置，它只存在凭据服务里（${GITEE_OAUTH_SECRET_REF}）。留空 = 不使用 Gitee 浏览器登录。`),
		oauthRedirectUri: Schema.string().default("").description(`Gitee 授权回调地址，必须与你在 Gitee 应用里登记的地址完全一致（Gitee 不做模糊匹配，多一个斜杠都会失败）。留空 = 运行时按本机请求头推导为 http://<host>${OAUTH_CALLBACK_PATH}，适用于直接用 127.0.0.1 打开设置页的常见情形；只有当你从别的主机 / 端口访问设置页，或应用里登记的是另一个地址时才需要手填。`)
	}).description("Gitee 访问设置。无 token 时仍允许只打公开端点，空结果标为 empty（不伪造数据）。"),
	csdn: Schema.object({
		apiBase: Schema.string().default("").description(`覆盖 CSDN 搜索基址（留空 = 内置 ${CSDN_SEARCH_BASE}）。${CSDN_API_NOTE}`),
		htmlFallback: Schema.boolean().default(SCHEMA_DEFAULTS.htmlFallback).description("搜索接口返回空结果时，是否允许回退抓取 HTML 页面；回退结果会标注来源并降低置信度。"),
		articleFetch: Schema.boolean().default(SCHEMA_DEFAULTS.articleFetch).description("是否允许为命中的搜索结果再抓一次文章页。为什么默认开：实测搜索接口 30 条里只有 6 条带正文，代码通常只在文章页的 <pre> 里。文章页必须带浏览器 UA / Referer，否则会被 HTTP 521 反爬拦截 —— 本插件会自动带上这两个头，代价是这类请求强制走 Node 直连传输（harness 通道不接受请求头）。"),
		cdpEnabled: Schema.boolean().default(SCHEMA_DEFAULTS.cdpEnabled).description("实验性：允许通过浏览器调试端口（CDP）读取 CSDN 登录 cookie。默认关闭，因为代价是真实的：你必须用 --remote-debugging-port 启动浏览器，该端口对本机任何进程开放。本插件不打包浏览器、不读 cookie 数据库（不碰 DPAPI / App-Bound）、不装根证书、不起代理；即使开启，也只有收到显式带 consent 的请求时才会连 127.0.0.1。"),
		cdpPort: Schema.number().default(SCHEMA_DEFAULTS.cdpPort).description(`浏览器调试端口。默认 ${CDP_DEFAULT_PORT}，即 Chrome / Edge 的 --remote-debugging-port 常用值。取值收敛到 1..65535，越界会被夹回边界值而不是让请求失败。`)
	}).description("CSDN 访问设置。CSDN 权重最低，只作补充。"),
	/**
	* Browser-half behaviour. Not a decision (nothing here blocks the tool), just a
	* preference the user owns — which is exactly why it must be switchable rather
	* than baked into the writer.
	*/
	ui: Schema.object({ autoSave: Schema.boolean().default(SCHEMA_DEFAULTS.autoSave).description("改完设置后是否自动保存（默认开启，改完约 0.7 秒写入 host，连续编辑合并成一次）。关闭后改动只会留在草稿里，需要你点「保存到 host」；想临时手动落地时，保存栏的按钮在待保存状态下也能点。") }).description("界面行为。与工具能否运行无关，纯偏好。"),
	failover: Schema.object({
		enabled: Schema.boolean().description("某个源失败（network / timeout / rate-limited / auth-required）时，是否自动降级到下一个源。留空 = 尚未决定，工具会先问用户。"),
		chain: Schema.array(Schema.union(GITHUB_ACCESS)).default([]).description("可选的显式降级顺序（GitHub 访问方式）。留空 = 沿用 accessPriority 的顺序。")
	}).description("失败自动降级（docs/DESIGN.md §3）。降级本身是需要用户确认的动作。"),
	mergeSources: Schema.boolean().description("多个源都命中时是否合并去重后返回；false = 只用最高优先级的那个源。留空 = 尚未决定，工具会先问用户。"),
	limits: Schema.object({
		timeoutMs: Schema.number().min(1).max(HARD_LIMITS.timeoutMs).default(DEFAULT_LIMITS.timeoutMs).description(`单次请求超时（毫秒）。默认 ${DEFAULT_LIMITS.timeoutMs}，硬顶 ${HARD_LIMITS.timeoutMs}，只可下调。`),
		retries: Schema.number().min(0).max(HARD_LIMITS.retries).default(DEFAULT_LIMITS.retries).description(`传输层重试次数。默认 ${DEFAULT_LIMITS.retries}，硬顶 ${HARD_LIMITS.retries}，只可下调。`),
		maxDepth: Schema.number().min(0).max(HARD_LIMITS.maxDepth).default(DEFAULT_LIMITS.maxDepth).description(`递归 / 降级深度。默认 ${DEFAULT_LIMITS.maxDepth}，硬顶 ${HARD_LIMITS.maxDepth}，防无限递归。`),
		maxItems: Schema.number().min(1).max(HARD_LIMITS.maxItems).default(DEFAULT_LIMITS.maxItems).description(`单次返回条目上限。默认 ${DEFAULT_LIMITS.maxItems}，硬顶 ${HARD_LIMITS.maxItems}，只可下调。`),
		maxCodeChars: Schema.number().min(1).max(HARD_LIMITS.maxCodeChars).default(DEFAULT_LIMITS.maxCodeChars).description(`代码节选上限（字符）。默认 ${DEFAULT_LIMITS.maxCodeChars}，硬顶 ${HARD_LIMITS.maxCodeChars}。超出即截断并置 codeTruncated。`)
	}).description("超时 / 重试 / 深度 / 条目上限。属用户偏好，不是决策点；只能下调，不能超过硬顶。"),
	marking: Schema.object({ banner: Schema.boolean().default(SCHEMA_DEFAULTS.banner).description("渲染时是否附加「仅学习参考 · 不得直接粘贴进用户项目」横幅。备注③的结构性约束不可关闭：解析时强制为 true。") }).description("防搬运标注（备注③）。"),
	deepRead: Schema.object({ targets: Schema.array(Schema.union(DEEP_READ_TARGETS)).default([]).description("深度阅读目标（readme / entry / core / tests）。留空 = 只做浅搜索，不做深度阅读。") }).description("深度阅读设置。产物是思路笔记 LearnNote，不是文件副本。")
});
function isRecord$6(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** `undefined` unless the value is literally a boolean — `false` is preserved. */
function readBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function readBooleanOr(value, fallback) {
	const parsed = readBoolean(value);
	return parsed === void 0 ? fallback : parsed;
}
function readString(value, fallback = "") {
	return typeof value === "string" ? value.trim() : fallback;
}
/** Trimmed, de-duplicated, order-preserving string list, optionally filtered. */
function readStringList(value, allowed) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length === 0) continue;
		if (allowed !== void 0 && !allowed.includes(trimmed)) continue;
		if (!out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}
/** Base URL without a trailing slash; empty string means "use the built-in". */
function readBase(value) {
	const raw = readString(value);
	return raw.endsWith("/") ? raw.replace(/\/+$/, "") : raw;
}
function clampNumber(value, min, max, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}
/** Clamp every limit into `HARD_LIMITS`. Exported so tests can assert the caps. */
function resolveLimits(raw) {
	const source = isRecord$6(raw) ? raw : {};
	return {
		timeoutMs: clampNumber(source.timeoutMs, 1, HARD_LIMITS.timeoutMs, DEFAULT_LIMITS.timeoutMs),
		retries: clampNumber(source.retries, 0, HARD_LIMITS.retries, DEFAULT_LIMITS.retries),
		maxDepth: clampNumber(source.maxDepth, 0, HARD_LIMITS.maxDepth, DEFAULT_LIMITS.maxDepth),
		maxItems: clampNumber(source.maxItems, 1, HARD_LIMITS.maxItems, DEFAULT_LIMITS.maxItems),
		maxCodeChars: clampNumber(source.maxCodeChars, 1, HARD_LIMITS.maxCodeChars, DEFAULT_LIMITS.maxCodeChars)
	};
}
/** Normalise one config layer (already merged) into the shape the host uses. */
function resolveConfig(settings, local) {
	const input = isRecord$6(settings) ? settings : {};
	const localInput = isRecord$6(local) ? local : {};
	const github = isRecord$6(input.github) ? input.github : {};
	const gitee = isRecord$6(input.gitee) ? input.gitee : {};
	const csdn = isRecord$6(input.csdn) ? input.csdn : {};
	const failover = isRecord$6(input.failover) ? input.failover : {};
	const deepRead = isRecord$6(input.deepRead) ? input.deepRead : {};
	const ui = isRecord$6(input.ui) ? input.ui : {};
	const placement = readString(input.entryPlacement);
	const entryPlacement = ENTRY_PLACEMENTS.includes(placement) ? placement : SCHEMA_DEFAULTS.entryPlacement;
	const localProxy = readString(localInput.localProxy) || readString(github.localProxy);
	return {
		enabled: readBooleanOr(input.enabled, SCHEMA_DEFAULTS.enabled),
		onboarded: readBooleanOr(input.onboarded, SCHEMA_DEFAULTS.onboarded),
		entryPlacement,
		announceToAgent: readBooleanOr(input.announceToAgent, SCHEMA_DEFAULTS.announceToAgent),
		sourcePriority: readStringList(input.sourcePriority, SOURCES),
		github: {
			accessPriority: readStringList(github.accessPriority, GITHUB_ACCESS),
			apiBase: readBase(github.apiBase),
			webProxyBases: readStringList(github.webProxyBases),
			rawMirrorBases: readStringList(github.rawMirrorBases),
			localProxy,
			oauthClientId: readString(github.oauthClientId)
		},
		gitee: {
			apiBase: readBase(gitee.apiBase),
			htmlFallback: readBooleanOr(gitee.htmlFallback, SCHEMA_DEFAULTS.htmlFallback),
			oauthClientId: readString(gitee.oauthClientId),
			oauthRedirectUri: readString(gitee.oauthRedirectUri)
		},
		csdn: {
			apiBase: readBase(csdn.apiBase),
			htmlFallback: readBooleanOr(csdn.htmlFallback, SCHEMA_DEFAULTS.htmlFallback),
			articleFetch: readBooleanOr(csdn.articleFetch, SCHEMA_DEFAULTS.articleFetch),
			cdpEnabled: readBooleanOr(csdn.cdpEnabled, SCHEMA_DEFAULTS.cdpEnabled),
			cdpPort: clampNumber(csdn.cdpPort, 1, 65535, SCHEMA_DEFAULTS.cdpPort)
		},
		ui: { autoSave: readBooleanOr(ui.autoSave, SCHEMA_DEFAULTS.autoSave) },
		failover: {
			enabled: readBoolean(failover.enabled),
			chain: readStringList(failover.chain, GITHUB_ACCESS)
		},
		mergeSources: readBoolean(input.mergeSources),
		limits: resolveLimits(input.limits),
		marking: { banner: true },
		deepRead: { targets: readStringList(deepRead.targets, DEEP_READ_TARGETS) }
	};
}
const TOP_LEVEL_KEYS = [
	"enabled",
	"onboarded",
	"entryPlacement",
	"announceToAgent",
	"sourcePriority",
	"github",
	"gitee",
	"csdn",
	"failover",
	"mergeSources",
	"limits",
	"marking",
	"deepRead",
	"ui"
];
const GITHUB_KEYS = [
	"accessPriority",
	"apiBase",
	"webProxyBases",
	"rawMirrorBases",
	"localProxy",
	"oauthClientId"
];
/**
* Gitee and CSDN no longer share one key list.
*
* They used to, which meant `csdn` accepted a `oauthRedirectUri` and `gitee`
* accepted `cdpPort` — harmless-looking, but the split is what keeps the two
* credential stories (authorization code vs cookie) from bleeding into each
* other. Nested keys that are not listed are rejected BY NAME, which is also how
* a nested `oauthClientSecret` is refused.
*/
const GITEE_KEYS = [
	"apiBase",
	"htmlFallback",
	"oauthClientId",
	"oauthRedirectUri"
];
const CSDN_KEYS = [
	"apiBase",
	"htmlFallback",
	"articleFetch",
	"cdpEnabled",
	"cdpPort"
];
const FAILOVER_KEYS = ["enabled", "chain"];
const LIMITS_KEYS = [
	"timeoutMs",
	"retries",
	"maxDepth",
	"maxItems",
	"maxCodeChars"
];
const MARKING_KEYS = ["banner"];
const DEEP_READ_KEYS = ["targets"];
const UI_KEYS = ["autoSave"];
/**
* A key that must never be persisted by this plugin, anywhere.
*
* Credentials belong to `ctx.credentials`; a PATCH naming one is a caller
* mistake, and it is dropped (and reported) rather than written to a profile
* patch or to the 0600 store file.
*/
const SECRET_KEY_PATTERN = /(token|secret|cookie|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)/i;
function isSecretKey(key) {
	return SECRET_KEY_PATTERN.test(key);
}
function pickKeys(source, allowed, rejected) {
	const out = {};
	for (const [key, value] of Object.entries(source)) {
		if (allowed.includes(key)) {
			out[key] = value;
			continue;
		}
		rejected.push(key);
	}
	return out;
}
/** Deep merge (top level + one nested group) with `null` meaning "unset". */
function mergeConfigInput(base, patch) {
	const left = isRecord$6(base) ? { ...base } : {};
	const right = isRecord$6(patch) ? patch : {};
	const out = { ...left };
	for (const [key, value] of Object.entries(right)) {
		if (value === void 0) continue;
		const current = out[key];
		if (isRecord$6(current) && isRecord$6(value)) {
			out[key] = {
				...current,
				...value
			};
			continue;
		}
		out[key] = value;
	}
	return out;
}
/**
* Split an incoming PATCH into "goes to the 0600 store" and "goes to settings".
*
* Only `github.localProxy` is stored locally (docs/DESIGN.md §4: a proxy address
* is sensitive but is not a credential). Everything else is a normal setting.
* Unknown and secret-looking keys are dropped and reported — never persisted.
*/
function splitConfigPatch(patch) {
	if (!isRecord$6(patch)) return {
		ok: false,
		rejected: [],
		local: {},
		settings: {},
		error: "请求体必须是一个 JSON 对象。"
	};
	const rejected = [];
	const settings = {};
	const local = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) continue;
		if (!TOP_LEVEL_KEYS.includes(key) || isSecretKey(key)) {
			rejected.push(key);
			continue;
		}
		if (key === "github") {
			if (value === null) {
				settings.github = null;
				continue;
			}
			if (!isRecord$6(value)) {
				rejected.push("github");
				continue;
			}
			const group = pickKeys(value, GITHUB_KEYS, rejected);
			if ("localProxy" in group) {
				const proxy = group.localProxy;
				delete group.localProxy;
				if (proxy === null) local.localProxy = "";
				else if (typeof proxy === "string") local.localProxy = proxy.trim();
				else rejected.push("github.localProxy");
			}
			settings.github = group;
			continue;
		}
		if (key === "gitee" || key === "csdn") {
			const allowed = key === "gitee" ? GITEE_KEYS : CSDN_KEYS;
			settings[key] = isRecord$6(value) ? pickKeys(value, allowed, rejected) : value;
			continue;
		}
		if (key === "failover") {
			settings.failover = isRecord$6(value) ? pickKeys(value, FAILOVER_KEYS, rejected) : value;
			continue;
		}
		if (key === "limits") {
			settings.limits = isRecord$6(value) ? pickKeys(value, LIMITS_KEYS, rejected) : value;
			continue;
		}
		if (key === "marking") {
			settings.marking = isRecord$6(value) ? pickKeys(value, MARKING_KEYS, rejected) : value;
			continue;
		}
		if (key === "deepRead") {
			settings.deepRead = isRecord$6(value) ? pickKeys(value, DEEP_READ_KEYS, rejected) : value;
			continue;
		}
		if (key === "ui") {
			settings.ui = isRecord$6(value) ? pickKeys(value, UI_KEYS, rejected) : value;
			continue;
		}
		settings[key] = value;
	}
	return {
		ok: true,
		rejected,
		local,
		settings
	};
}
/** `undefined` -> `null`, so "undecided" survives JSON serialisation. */
function toJsonView(config) {
	return {
		enabled: config.enabled,
		onboarded: config.onboarded,
		entryPlacement: config.entryPlacement,
		announceToAgent: config.announceToAgent,
		sourcePriority: [...config.sourcePriority],
		github: {
			...config.github,
			mirrors: [...config.github.webProxyBases],
			rawMirrors: [...config.github.rawMirrorBases]
		},
		gitee: { ...config.gitee },
		csdn: { ...config.csdn },
		failover: {
			enabled: config.failover.enabled === void 0 ? null : config.failover.enabled,
			chain: [...config.failover.chain]
		},
		mergeSources: config.mergeSources === void 0 ? null : config.mergeSources,
		limits: { ...config.limits },
		marking: { banner: true },
		deepRead: { targets: [...config.deepRead.targets] },
		ui: { ...config.ui }
	};
}
/** The only credential-shaped fields the schema will ever expose: booleans. */
const CREDENTIAL_TARGETS = [
	"github",
	"gitee",
	"csdn"
];
//#endregion
//#region src/store.ts
/**
* dsh-codehub — local store: `$DSH_HOME/dsh-codehub.json` (0600).
*
* WHAT LIVES HERE, AND WHY
* ------------------------
* Exactly one class of value: things that are sensitive but are NOT credentials.
* Today that is the local proxy address (备注① target, docs/DESIGN.md §4) plus a
* fallback configuration snapshot used while the settings RPC cannot persist our
* namespace.
*
* Credentials never come near this file. `ctx.credentials` owns them, and this
* module enforces that structurally rather than by convention:
*
*   - only three top-level keys are ever written (`localProxy`,
*     `fallbackConfig`, `updatedAt`);
*   - every nested key is passed through `isSecretKey()` from `config.ts`, so a
*     value that reached the store under a name like `giteeToken`,
*     `csdnCookie` or `authorization` is DROPPED on both write and read;
*   - the scrubber is depth- and size-bounded, so a hostile or buggy caller
*     cannot use the store as an unbounded blob either.
*
* Hence the counter-example in docs/DESIGN.md §4 — `dsh-ssh` writing an SSH
* password in plaintext next to its config — is not repeatable here even by
* accident: there is no code path that copies an arbitrary object into the file.
*
* PERMISSIONS
* -----------
* Directory `0700`, file `0600`, applied at creation AND re-applied after the
* atomic rename (`rename` keeps the temp file's mode, but a pre-existing target
* on some filesystems would otherwise win). Windows ignores POSIX mode bits for
* anything but the read-only flag, so `chmod` is best-effort and never fatal.
*/
/** File name inside `$DSH_HOME`. */
const STORE_FILE_NAME = "dsh-codehub.json";
/** Bounds of the scrubber. Anything larger is truncated rather than trusted. */
const SCRUB_LIMITS = {
	maxDepth: 4,
	maxArrayItems: 64,
	maxStringChars: 512
};
/** `$DSH_HOME`, else `$XDG_CONFIG_HOME/dsh`, else `~/.dsh`. */
function resolveDshHome() {
	const configured = process.env.DSH_HOME;
	if (typeof configured === "string" && configured.trim().length > 0) return resolve(configured.trim());
	const xdg = process.env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.trim().length > 0) return join(resolve(xdg.trim()), "dsh");
	return join(homedir(), ".dsh");
}
function resolveStorePath(home = resolveDshHome()) {
	return join(home, STORE_FILE_NAME);
}
/**
* Depth- and size-bounded, secret-key-dropping JSON scrubber.
*
* Exported so tests can prove a token cannot round-trip through the store.
*/
function scrubValue(value, depth = 0) {
	if (value === null) return null;
	const kind = typeof value;
	if (kind === "boolean" || kind === "number") return value;
	if (kind === "string") {
		const text = value;
		return text.length > SCRUB_LIMITS.maxStringChars ? text.slice(0, SCRUB_LIMITS.maxStringChars) : text;
	}
	if (kind !== "object" || depth >= SCRUB_LIMITS.maxDepth) return void 0;
	if (Array.isArray(value)) {
		const out = [];
		for (const item of value.slice(0, SCRUB_LIMITS.maxArrayItems)) {
			const scrubbed = scrubValue(item, depth + 1);
			if (scrubbed !== void 0) out.push(scrubbed);
		}
		return out;
	}
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (isSecretKey(key)) continue;
		const scrubbed = scrubValue(item, depth + 1);
		if (scrubbed !== void 0) out[key] = scrubbed;
	}
	return out;
}
/** Trim a proxy address; drop control characters and absurd lengths. */
function normalizeLocalProxy(value) {
	if (typeof value !== "string") return void 0;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (cleaned.length === 0) return void 0;
	if (/\s/.test(cleaned)) return void 0;
	return cleaned.slice(0, SCRUB_LIMITS.maxStringChars);
}
function readTimestamp(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/**
* Whitelist-and-scrub a parsed store file into `LocalConfig`.
*
* Unknown top-level keys are dropped, so a hand-edited file cannot introduce a
* field this plugin would then start trusting.
*/
function sanitizeLocalConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const source = value;
	const out = {};
	const proxy = normalizeLocalProxy(source.localProxy);
	if (proxy !== void 0) out.localProxy = proxy;
	if (typeof source.fallbackConfig === "object" && source.fallbackConfig !== null) {
		const scrubbed = scrubValue(source.fallbackConfig);
		if (typeof scrubbed === "object" && scrubbed !== null && !Array.isArray(scrubbed)) out.fallbackConfig = scrubbed;
	}
	const updatedAt = readTimestamp(source.updatedAt);
	if (updatedAt !== void 0) out.updatedAt = updatedAt;
	return out;
}
function messageOf$3(error) {
	return error instanceof Error ? error.message : String(error);
}
async function chmodBestEffort(target, mode) {
	try {
		await chmod(target, mode);
	} catch {}
}
/**
* Serialised, atomic, permission-tight access to the store file.
*
* `write()` merges into whatever is already on disk (so two independent fields
* cannot clobber each other) and is queued in-process, which makes concurrent
* PATCH requests from the browser panel safe without a lock file.
*/
var LocalConfigStore = class {
	filePath;
	queue = Promise.resolve();
	constructor(filePath = resolveStorePath()) {
		this.filePath = filePath;
	}
	/** Never throws: a missing or corrupt file reads as `{}`. */
	async read() {
		try {
			const text = await readFile(this.filePath, "utf8");
			return sanitizeLocalConfig(JSON.parse(text));
		} catch {
			return {};
		}
	}
	/** Merge `patch` on top of the current file, scrub, then write atomically. */
	async write(patch) {
		const run = this.queue.then(async () => {
			const merged = sanitizeLocalConfig({
				...await this.read(),
				...patch.localProxy !== void 0 ? { localProxy: patch.localProxy } : {},
				...patch.fallbackConfig !== void 0 ? { fallbackConfig: patch.fallbackConfig } : {},
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return this.persist(merged);
		});
		this.queue = run.then(() => void 0, () => void 0);
		return run;
	}
	/** Diagnostics for the `detect` route. Never returns stored values. */
	async diagnostics() {
		const directory = dirname(this.filePath);
		try {
			const text = await readFile(this.filePath, "utf8");
			try {
				JSON.parse(text);
				return {
					path: this.filePath,
					directory,
					exists: true,
					readable: true
				};
			} catch (error) {
				return {
					path: this.filePath,
					directory,
					exists: true,
					readable: false,
					error: messageOf$3(error)
				};
			}
		} catch (error) {
			if (error.code === "ENOENT") return {
				path: this.filePath,
				directory,
				exists: false,
				readable: false
			};
			return {
				path: this.filePath,
				directory,
				exists: false,
				readable: false,
				error: messageOf$3(error)
			};
		}
	}
	async persist(value) {
		const target = this.filePath;
		const directory = dirname(target);
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		try {
			await mkdir(directory, {
				recursive: true,
				mode: 448
			});
			await chmodBestEffort(directory, 448);
			const body = `${JSON.stringify(value, null, 2)}\n`;
			await writeFile(temporary, body, {
				encoding: "utf8",
				mode: 384
			});
			await chmodBestEffort(temporary, 384);
			await rename(temporary, target);
			await chmodBestEffort(target, 384);
			return {
				ok: true,
				path: target,
				value
			};
		} catch (error) {
			try {
				await unlink(temporary);
			} catch {}
			return {
				ok: false,
				path: target,
				value,
				error: messageOf$3(error)
			};
		}
	}
};
//#endregion
//#region src/launcher.ts
/**
* dsh-codehub — launch a debuggable Chromium so the CDP cookie capture can work.
*
* WHY THIS MODULE EXISTS
* ----------------------
* The experimental capture needs `http://127.0.0.1:<port>/json/version` to answer,
* which the user can only get by starting a browser with
* `--remote-debugging-port=…`. Telling the user to do that by hand is where the
* feature died in practice: they open their normal browser, the flag is ignored
* (an already-running instance owns the profile), and the plugin reports 'timeout'
* forever. So the plugin does it: probe first, and if nothing is listening, find a
* Chromium, start it on its OWN profile with the right flags, and wait for the
* debugger URL to appear.
*
* WHY A SEPARATE `--user-data-dir`
* --------------------------------
* Chromium refuses to open a debug port on a profile that another process already
* owns, and on some builds it refuses on the *default* profile at all. A dedicated
* directory under `$DSH_HOME` therefore always works — at the cost that it starts
* empty, which is why the caller opens the CSDN login page in it.
*
* WHAT THIS MODULE DELIBERATELY DOES NOT DO
* -----------------------------------------
* - It never touches the user's normal profile: no reading, no copying, no locking.
* - It never downloads a browser, and refuses when it cannot find one.
* - It does not inject anything into the page, and it holds no credential: the
*   cookie capture reads browser state over CDP in `cdp.ts`, and what it finds goes
*   straight to the credential service.
*
* The profile directory IS sensitive (it holds the logged-in session), so it lives
* under `$DSH_HOME` with mode 0700 and is never inside a repository.
*/
/** The port the probe and the default launch use. Kept in sync with config. */
const DEFAULT_TIMEOUT_MS$1 = 2e4;
const POLL_INTERVAL_MS = 400;
/**
* Windows install locations, **Edge first**.
*
* THE ORDER IS AN INTERNAL DECISION, NOT A SWITCH TO EXPOSE: Edge ships with
* Windows, so it is the browser a user is most likely to already have; Chrome is
* the fallback. `launch()` takes the first candidate that exists and nothing in the
* UI offers a picker — one more question between the user and a cookie is exactly
* what this feature was meant to remove.
*/
function windowsCandidates(env) {
	const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
	const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = env["LOCALAPPDATA"] ?? join(env["USERPROFILE"] ?? "C:\\Users\\Default", "AppData", "Local");
	return [
		{
			id: "edge",
			label: "Microsoft Edge",
			path: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
		},
		{
			id: "edge",
			label: "Microsoft Edge",
			path: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
		},
		{
			id: "brave",
			label: "Brave",
			path: join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
		}
	];
}
/** POSIX / macOS locations, same Edge-first order. */
function posixCandidates(platform) {
	if (platform === "darwin") return [
		{
			id: "edge",
			label: "Microsoft Edge",
			path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		},
		{
			id: "brave",
			label: "Brave",
			path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
		},
		{
			id: "chromium",
			label: "Chromium",
			path: "/Applications/Chromium.app/Contents/MacOS/Chromium"
		}
	];
	return [
		{
			id: "edge",
			label: "Microsoft Edge",
			path: "/usr/bin/microsoft-edge"
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: "/usr/bin/google-chrome"
		},
		{
			id: "chrome",
			label: "Google Chrome",
			path: "/usr/bin/google-chrome-stable"
		},
		{
			id: "chromium",
			label: "Chromium",
			path: "/usr/bin/chromium"
		},
		{
			id: "chromium",
			label: "Chromium",
			path: "/usr/bin/chromium-browser"
		}
	];
}
function defaultSleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
function globalFetch$1() {
	const candidate = globalThis.fetch;
	return typeof candidate === "function" ? candidate : void 0;
}
/**
* Build the launcher.
*
* The interface is three methods on purpose: `listBrowsers()` for the UI's picker,
* `launch()` for the action, and `userDataDir()` so the copy can say where the
* session lives. Everything else (paths, flags, polling) stays inside.
*/
function createBrowserLauncher(deps = {}) {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const spawnImpl = deps.spawnImpl ?? spawn;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? (() => Date.now());
	const fetchImpl = deps.fetchImpl ?? globalFetch$1();
	/**
	* The dedicated profile for ONE browser family.
	*
	* Per-browser on purpose: Edge and Chrome both write a Chromium profile, but they
	* are different products and sharing one directory across them invites a profile
	* reset the first time the order changes. The suffix also makes it obvious in the
	* filesystem which browser owns a logged-in session.
	*/
	const profileDir = (browserId = "edge") => deps.userDataDir ?? join(deps.dshHome ?? resolveDshHome(), `dsh-codehub-browser-${browserId}`);
	function listBrowsers() {
		const raw = platform === "win32" ? windowsCandidates(env) : posixCandidates(platform);
		const found = [];
		for (const candidate of raw) {
			if (!exists(candidate.path)) continue;
			if (found.some((item) => item.id === candidate.id)) continue;
			found.push(candidate);
		}
		return found;
	}
	/** Ask /json/version once. Returns the debugger URL, or nothing. */
	async function probe(port, timeoutMs) {
		if (fetchImpl === void 0) return void 0;
		try {
			const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
				method: "GET",
				signal: AbortSignal.timeout(Math.min(timeoutMs, 3e3))
			});
			if (response.status !== 200) return void 0;
			const parsed = JSON.parse(await response.text());
			if (parsed === null || typeof parsed !== "object") return void 0;
			const url = parsed.webSocketDebuggerUrl;
			return typeof url === "string" && url.length > 0 ? url : void 0;
		} catch {
			return;
		}
	}
	return {
		listBrowsers,
		/** The profile the PREFERRED (first) browser would use; see `profileDir`. */
		userDataDir: () => profileDir(),
		async launch(input) {
			const port = input.port;
			if (!Number.isInteger(port) || port < 1 || port > 65535) return {
				ok: false,
				failure: "bad-port",
				reason: "调试端口必须是 1–65535 的整数。"
			};
			if (fetchImpl === void 0) return {
				ok: false,
				failure: "unsupported",
				reason: "当前进程没有可用的 fetch，无法探测调试端口。"
			};
			const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS$1;
			const existing = await probe(port, timeoutMs);
			if (existing !== void 0) return {
				ok: true,
				launched: false,
				browser: null,
				port,
				userDataDir: profileDir(),
				debuggerUrl: existing,
				reason: `端口 ${port} 上已经有一个可调试的浏览器，直接复用它（没有启动新的）。`
			};
			const candidates = listBrowsers();
			if (candidates.length === 0) return {
				ok: false,
				failure: "no-browser",
				reason: "没有找到 Chrome / Edge / Brave / Chromium。请先安装其中一个，或用 --remote-debugging-port 自行启动浏览器。",
				searched: platform === "win32" ? windowsCandidates(env).map((item) => item.path) : posixCandidates(platform).map((item) => item.path)
			};
			const browser = input.browserId === void 0 ? candidates[0] : candidates.find((item) => item.id === input.browserId) ?? candidates[0];
			const userDataDir = input.userDataDir ?? profileDir(browser.id);
			try {
				(deps.mkdirp ?? ((dir) => mkdirSync(dir, {
					recursive: true,
					mode: 448
				})))(userDataDir);
			} catch {
				return {
					ok: false,
					failure: "spawn-failed",
					reason: `无法创建浏览器专用配置目录：${userDataDir}`
				};
			}
			const args = [
				`--remote-debugging-port=${port}`,
				CDP_REMOTE_ALLOW_ORIGINS_FLAG,
				`--user-data-dir=${userDataDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-features=Translate,InfiniteSessionRestore",
				...input.url === void 0 || input.url.length === 0 ? [] : [input.url]
			];
			let pid = 0;
			try {
				const child = spawnImpl(browser.path, args, {
					detached: true,
					stdio: "ignore",
					windowsHide: false
				});
				pid = typeof child.pid === "number" ? child.pid : 0;
				child.unref?.();
			} catch (error) {
				return {
					ok: false,
					failure: "spawn-failed",
					reason: `启动 ${browser.label} 失败：${error instanceof Error ? error.message : String(error)}`
				};
			}
			const deadline = now() + timeoutMs;
			let debuggerUrl;
			while (now() < deadline) {
				debuggerUrl = await probe(port, 2e3);
				if (debuggerUrl !== void 0) break;
				await sleep(POLL_INTERVAL_MS);
			}
			if (debuggerUrl === void 0) return {
				ok: false,
				failure: "timeout",
				reason: `已启动 ${browser.label}（pid ${pid}），但 ${timeoutMs / 1e3} 秒内端口 ${port} 没有响应。常见原因：该浏览器已在用同一个配置目录运行（调试端口被忽略）、端口被别的程序占用，或安全软件拦截。可以换一个端口，或先完全退出调试浏览器再重试。`
			};
			return {
				ok: true,
				launched: true,
				browser,
				port,
				userDataDir,
				debuggerUrl,
				reason: `已启动 ${browser.label}（独立配置：${userDataDir}）。请在打开的窗口里登录 CSDN，然后回来点「读取 Cookie」。`
			};
		}
	};
}
//#endregion
//#region src/prompt.ts
/**
* dsh-codehub — system-prompt section (备注③, docs/DESIGN.md §5).
*
* The anti-plagiarism statement has to reach the model through TWO surfaces:
* the `learn_code_from_web` tool description (`ANTI_COPY_TOOL_CLAUSE`) and this
* prompt section (`PROMPT_SECTION_TEXT`). Both are derived from the single
* `ANTI_COPY_STATEMENT` constant in `src/contract.ts`; this file imports the
* text and NEVER re-spells it. A test asserts both surfaces contain that same
* constant, which is only meaningful because there is exactly one copy.
*
* REGISTRATION DISCIPLINE
* -----------------------
* `systemPrompt.section()` is keyed by name: registering `plugin:dsh-codehub`
* twice throws. `config.announceToAgent` can therefore not be a naive
* `if (enabled) register()` — toggling it would either throw or leak the old
* registration. The controller below keeps a SINGLE disposer, tears the old
* section down before building the new one, and is idempotent when the desired
* state has not changed. That is the "拆旧的再建新的" pattern the brief asks for.
*/
/** Stable section name. The `plugin:` prefix keeps it in the plugin band. */
const PROMPT_SECTION_NAME = `plugin:${PACKAGE_NAME}`;
/** The exact section this plugin contributes, built from contract constants. */
const PROMPT_SECTION = {
	name: PROMPT_SECTION_NAME,
	order: 150,
	text: PROMPT_SECTION_TEXT
};
/**
* Owns at most one live prompt section.
*
* Construct it with `undefined` when the service is missing: `apply()` then
* reports `false` and logs instead of throwing, so a missing optional service
* cannot fail the plugin mount.
*/
var PromptSectionController = class {
	service;
	log;
	/** The live registration's disposer. Named `disposer` so the public method
	*  `dispose()` below does not collide with it. */
	disposer;
	state;
	constructor(service, log) {
		this.service = service;
		this.log = log;
	}
	/** True while a section is registered. */
	get registered() {
		return this.disposer !== void 0;
	}
	/**
	* Make the live registration match `enabled`.
	*
	* Returns true when a section is registered afterwards. Safe to call
	* repeatedly; a no-op when the state already matches.
	*/
	apply(enabled) {
		if (this.state === enabled && this.registered === enabled) return this.registered;
		this.teardown();
		if (!enabled) {
			this.state = false;
			return false;
		}
		if (this.service === void 0) {
			this.state = true;
			this.log?.("systemPrompt 服务不可用，防搬运声明段未注册（工具描述里的声明仍然生效）");
			return false;
		}
		try {
			const disposer = this.service.section({ ...PROMPT_SECTION });
			this.disposer = typeof disposer === "function" ? disposer : void 0;
			this.state = true;
			return this.disposer !== void 0;
		} catch (error) {
			this.state = true;
			this.log?.("注册 systemPrompt 段失败", {
				section: PROMPT_SECTION_NAME,
				reason: error instanceof Error ? error.message : String(error)
			});
			return false;
		}
	}
	/** Unregister without changing the desired state tracking. */
	teardown() {
		const disposer = this.disposer;
		this.disposer = void 0;
		if (disposer === void 0) return;
		try {
			disposer();
		} catch (error) {
			this.log?.("注销 systemPrompt 段失败", {
				section: PROMPT_SECTION_NAME,
				reason: error instanceof Error ? error.message : String(error)
			});
		}
	}
	/** Idempotent. Call from the owning `ctx.effect` disposer. */
	dispose() {
		this.teardown();
		this.state = false;
	}
};
/**
* Register (or skip) the section and return the controller that owns it.
*
* The caller threads this through `ctx.effect` so unloading the plugin removes
* the section.
*/
function createPromptSection(service, options = {}) {
	const controller = new PromptSectionController(service, options.log);
	controller.apply(options.enabled !== false);
	return controller;
}
//#endregion
//#region src/cdp.ts
/**
* dsh-codehub — experimental cookie capture over the browser debug port (CDP).
*
* INTERFACE FROZEN IN PHASE 0 (docs/DESIGN.md §7). W1 implements the bodies;
* `src/routes.ts` (`POST /api/dsh-codehub/cookies`) and the wizard call it.
*
* WHY THIS IS OPT-IN AND OFF BY DEFAULT
* -------------------------------------
* CSDN exposes no OAuth and no token API, so a session cookie is the only
* credential — and its session cookies may be HttpOnly, which makes the common
* "run document.cookie in the console" advice useless. Reading them from the
* browser is therefore the only automated path, and it has a real cost: the
* user must start their browser with `--remote-debugging-port`, which exposes a
* port any local process can talk to. That trade is the user's to make, so:
*
*   • `csdn.cdpEnabled` must be true (default false) AND
*   • the request must carry `consent: true`, and the UI must have shown the
*     warning text — a missing consent is a refusal, not a default.
*
* WHAT IT NEVER DOES
* ------------------
* No browser is spawned or bundled; no cookie database is read (Chrome's
* DPAPI/App-Bound encryption is deliberately out of scope); no root CA is
* installed; no proxy is started. It opens one websocket to 127.0.0.1 and asks
* `Network.getCookies` for the requested origins.
*
* PRIVACY OF THE RESULT
* ---------------------
* The returned `cookieHeader` is the one value that must reach the credential
* service and nothing else: not a log line, not an HTTP response, not a thrown
* error. The response shape the browser half sees carries NAMES and COUNTS.
*/
const DEFAULT_TIMEOUT_MS = 5e3;
const DEFAULT_HOST_ORIGIN = "https://www.csdn.net";
/**
* A page the capture prefers to attach to when it must go through the page-scoped
* `Network` domain. `Storage.getCookies` (browser scope) is tried first because it
* needs no attachment at all — see `captureBrowserCookies()`.
*/
const CDP_PAGE_URL = "https://www.csdn.net/";
/** Every reason string below is a constant: none can carry a cookie value. */
const REASON_CONSENT = "需要你显式确认后再读取浏览器 cookie。";
const REASON_BAD_PORT = "调试端口必须是 1–65535 的本机端口（只允许 127.0.0.1）。";
const REASON_NO_WS = "当前运行环境没有 WebSocket，无法连接浏览器调试端口。";
const REASON_ENDPOINT = "浏览器调试端口没有响应 /json/version：请确认浏览器是以 --remote-debugging-port 启动的。";
const REASON_DEBUGGER_URL = "调试端口返回的 webSocketDebuggerUrl 不可用或不是本机地址。";
const REASON_TIMEOUT = "连接浏览器调试端口超时，未取到任何 cookie。";
/**
* A websocket that never OPENED.
*
* MEASURED LIVE against real Chrome: the first version called `send()` while the
* socket was still CONNECTING, `send()` threw, and the throw was reported as the
* timeout above — i.e. the user was told to check a port that was listening fine.
* A handshake failure is its own diagnosis, so it gets its own sentence.
*/
const REASON_HANDSHAKE = "与调试端口的 WebSocket 握手失败：端口可能没有监听、浏览器拒绝了本次来源，或进程已退出。launcher 启动的浏览器已带 --remote-allow-origins=*；如果是你自己启动的浏览器，请确认也加了该参数。";
/** A request that failed to leave an OPEN socket. Distinct from both above. */
const REASON_SEND_FAILED = "向调试端口发送请求失败：";
const REASON_EMPTY = "浏览器里没有这些站点的 cookie：请先在浏览器登录 CSDN。";
/** Prefix for a CDP-level rejection; the engine's own message is appended. */
const REASON_CDP_REJECTED = "浏览器调试端口拒绝了这次读取：";
const REASON_NO_PAGE_TARGET = "浏览器里没有可附加的页面标签（读取 cookie 需要一个页面 target）。请先在那个浏览器里打开并登录 CSDN，再重试。";
/**
* Origins are matched by Chromium against the cookie's own domain, so the
* requested URLs must be absolute; a bare host is normalised to https.
*/
function normalizeOrigin(origin) {
	const trimmed = origin.trim();
	if (trimmed === "") return DEFAULT_HOST_ORIGIN;
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function hostOf(origins) {
	const hosts = [];
	for (const origin of origins) try {
		const host = new URL(origin).host;
		if (host !== "" && !hosts.includes(host)) hosts.push(host);
	} catch {}
	return hosts;
}
/**
* First pair wins on a duplicate name (the order V8 sends is stable), so the
* same browser state always produces the same header.
*/
function joinPairs(cookies) {
	const seen = /* @__PURE__ */ new Set();
	const parts = [];
	const names = [];
	for (const cookie of cookies) {
		if (cookie.name === "" || seen.has(cookie.name)) continue;
		seen.add(cookie.name);
		names.push(cookie.name);
		parts.push(`${cookie.name}=${cookie.value}`);
	}
	return {
		cookieHeader: parts.join("; "),
		names
	};
}
function isLoopbackWsUrl(url) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname;
		return parsed.protocol === "ws:" && (host === "127.0.0.1" || host === "localhost" || host === "::1");
	} catch {
		return false;
	}
}
async function fetchDebuggerUrl(fetchImpl, port, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
			method: "GET",
			signal: controller.signal
		});
		if (response.status !== 200) return { failure: "unavailable" };
		let parsed;
		try {
			parsed = JSON.parse(await response.text());
		} catch {
			return { failure: "unavailable" };
		}
		if (parsed === null || typeof parsed !== "object") return { failure: "unavailable" };
		const url = parsed.webSocketDebuggerUrl;
		if (typeof url !== "string" || url === "") return { failure: "unavailable" };
		return { debuggerUrl: url };
	} catch {
		return { failure: "network" };
	} finally {
		clearTimeout(timer);
	}
}
/** The CDP error message, bounded and single-line: never a cookie value. */
function cdpErrorMessage(error) {
	const record = error !== null && typeof error === "object" ? error : {};
	const message = typeof record.message === "string" && record.message.trim().length > 0 ? record.message : "未知原因";
	const code = typeof record.code === "number" ? `（code ${record.code}）` : "";
	return `${message.replace(/\s+/g, " ").slice(0, 200)}${code}`;
}
/**
* The cookies a browser-wide answer is allowed to contribute.
*
* `Storage.getCookies` answers with EVERY cookie in the browser context, so the
* result is scoped to the requested hosts before it can become a credential: a
* `SENTINEL` for some unrelated site must not ride into the CSDN cookie header.
* (The page-scoped `Network.getCookies` already answers per requested URL, so it
* needs no such filter — but running it through this is harmless.)
*/
function cookieMatchesHosts(cookie, hosts) {
	const domain = (cookie.domain ?? "").replace(/^\./, "").trim().toLowerCase();
	if (domain === "") return false;
	for (const host of hosts) {
		const bare = host.split(":")[0]?.trim().toLowerCase() ?? "";
		if (bare === "") continue;
		if (bare === domain || bare.endsWith(`.${domain}`)) return true;
	}
	return false;
}
function hostOfUrl(url) {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}
/**
* Pick a page target's debugger URL out of `/json/list`.
*
* Needed because the browser-scope endpoint cannot answer `Network.getCookies`:
* that domain is per-page. A target already sitting on the CSDN origin is
* preferred, so the capture reads the cookies of the session the user actually
* logged into rather than of a blank tab.
*/
async function fetchPageTarget(fetchImpl, port, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
			method: "GET",
			signal: controller.signal
		});
		if (response.status !== 200) return {};
		let parsed;
		try {
			parsed = JSON.parse(await response.text());
		} catch {
			return {};
		}
		if (!Array.isArray(parsed)) return {};
		const preferredHost = hostOfUrl(CDP_PAGE_URL);
		const pages = parsed.filter((item) => item !== null && typeof item === "object" && item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
		const chosen = pages.find((page) => hostOfUrl(typeof page.url === "string" ? page.url : "") === preferredHost) ?? pages[0] ?? null;
		return chosen === null ? {} : { debuggerUrl: chosen.webSocketDebuggerUrl };
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
}
/**
* Ask the debugger for cookies over one websocket and resolve with a value-free
* failure instead of throwing, so a caller can render the reason straight into
* the settings page.
*
* TWO CORRECTIONS THIS FUNCTION CARRIES (both were real defects):
* 1. A CDP error frame is answered IMMEDIATELY with `unsupported` and the
*    browser's own message. Dropping it and waiting for the timeout reported
*    "connection timed out" for what was really "this method is not available
*    on this endpoint" — a lie that sends the user to the wrong fix.
* 2. The method is a parameter. The browser-scope endpoint cannot serve
*    `Network.getCookies` (the domain is per-page), so the caller tries
*    `Storage.getCookies` first and only then attaches to a page target.
*/
async function readCookies(wsFactory, debuggerUrl, origins, timeoutMs, method) {
	return await new Promise((resolve) => {
		let settled = false;
		let timer;
		let socket;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			try {
				socket?.close();
			} catch {}
			resolve(value);
		};
		timer = setTimeout(() => finish({
			failure: "network",
			reason: REASON_TIMEOUT
		}), timeoutMs);
		try {
			socket = wsFactory(debuggerUrl);
		} catch {
			finish({
				failure: "network",
				reason: REASON_TIMEOUT
			});
			return;
		}
		/** Accept only the reply to request id 1; anything else is noise. */
		const onMessageData = (raw) => {
			if (typeof raw !== "string") return;
			let message;
			try {
				message = JSON.parse(raw);
			} catch {
				return;
			}
			if (message === null || typeof message !== "object") return;
			const record = message;
			if (record.id !== 1) return;
			if (record.error !== void 0) {
				finish({
					failure: "unsupported",
					reason: `${REASON_CDP_REJECTED}${method}：${cdpErrorMessage(record.error)}`
				});
				return;
			}
			if (!Array.isArray(record.result?.cookies)) {
				finish({
					failure: "unsupported",
					reason: `${REASON_CDP_REJECTED}${method}：响应里没有 cookies 字段。`
				});
				return;
			}
			const cookies = [];
			for (const item of record.result.cookies) {
				if (item === null || typeof item !== "object") continue;
				const name = item.name;
				const value = item.value;
				const domain = item.domain;
				if (typeof name !== "string") continue;
				cookies.push({
					name,
					value: typeof value === "string" ? value : "",
					...typeof domain === "string" ? { domain } : {}
				});
			}
			finish({ cookies });
		};
		/**
		* Send the one request.
		*
		* Never before the socket is OPEN: `send()` throws while CONNECTING, and the
		* first version reported that throw as a timeout — which is a lie about a port
		* that is listening. Undici's WebSocket exposes `readyState`, so it is used when
		* present; a test double without it is treated as already open.
		*/
		const sendRequest = () => {
			try {
				socket?.send(JSON.stringify({
					id: 1,
					method,
					params: method === "Storage.getCookies" ? {} : { urls: [...origins] }
				}));
			} catch (error) {
				finish({
					failure: "network",
					reason: `${REASON_SEND_FAILED}${cdpErrorMessage(error)}`
				});
			}
		};
		if (typeof socket.addEventListener === "function") {
			socket.addEventListener("open", () => sendRequest());
			socket.addEventListener("message", (event) => {
				const raw = typeof event === "string" ? event : event?.data;
				onMessageData(raw);
			});
			socket.addEventListener("close", () => finish({
				failure: "network",
				reason: REASON_HANDSHAKE
			}));
			socket.addEventListener("error", () => finish({
				failure: "network",
				reason: REASON_HANDSHAKE
			}));
		} else if (typeof socket.on === "function") {
			socket.on("open", (() => sendRequest()));
			socket.on("message", ((event) => {
				onMessageData(event?.data);
			}));
			socket.on("close", (() => finish({
				failure: "network",
				reason: REASON_HANDSHAKE
			})));
			socket.on("error", (() => finish({
				failure: "network",
				reason: REASON_HANDSHAKE
			})));
		} else {
			finish({
				failure: "network",
				reason: REASON_HANDSHAKE
			});
			return;
		}
		if (socket.readyState === void 0 || socket.readyState === 1) sendRequest();
	});
}
function globalWebSocketFactory() {
	const candidate = globalThis.WebSocket;
	if (typeof candidate !== "function") return void 0;
	return (url) => new candidate(url);
}
/**
* Read the requested sites' cookies once, over the browser's debug port.
*
* STRATEGY (and why it is two attempts, not one):
*   1. `Storage.getCookies` on the BROWSER endpoint — needs no page attachment,
*      so it works even when the user has no CSDN tab open. Its answer covers
*      every site in the browser context, so it is filtered down to the requested
*      hosts before it can become a credential.
*   2. If the browser endpoint refuses that method (older Chromium, or a
*      WebSocket peer that only serves page sessions), attach to a PAGE target
*      from `/json/list` and ask the page-scoped `Network.getCookies` instead.
* A CDP error is reported as itself — never as a timeout.
*/
async function captureBrowserCookies(input, deps = {}) {
	if (input.consent !== true) return {
		ok: false,
		failure: "consent-required",
		reason: REASON_CONSENT
	};
	const port = input.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return {
		ok: false,
		failure: "unavailable",
		reason: REASON_BAD_PORT
	};
	const wsFactory = deps.wsFactory ?? input.wsFactory ?? globalWebSocketFactory();
	if (wsFactory === void 0) return {
		ok: false,
		failure: "unsupported",
		reason: REASON_NO_WS
	};
	const fetchImpl = deps.fetchImpl ?? input.fetchImpl ?? globalFetch();
	if (fetchImpl === void 0) return {
		ok: false,
		failure: "unsupported",
		reason: "当前进程没有可用的 fetch，无法探测浏览器调试端口。"
	};
	const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
	const origins = (input.origins ?? CDP_COOKIE_HOSTS).map(normalizeOrigin);
	const hosts = hostOf(origins);
	const probe = await fetchDebuggerUrl(fetchImpl, port, timeoutMs);
	if (probe.debuggerUrl === void 0) return {
		ok: false,
		failure: probe.failure ?? "unavailable",
		reason: probe.failure === "network" ? REASON_TIMEOUT : REASON_ENDPOINT
	};
	if (!isLoopbackWsUrl(probe.debuggerUrl)) return {
		ok: false,
		failure: "unavailable",
		reason: REASON_DEBUGGER_URL
	};
	const browserRead = await readCookies(wsFactory, probe.debuggerUrl, origins, timeoutMs, "Storage.getCookies");
	let cookies;
	if ("cookies" in browserRead) cookies = browserRead.cookies.filter((cookie) => cookieMatchesHosts(cookie, hosts));
	else if (browserRead.failure === "network") return {
		ok: false,
		failure: "network",
		reason: browserRead.reason
	};
	else {
		const page = await fetchPageTarget(fetchImpl, port, timeoutMs);
		if (page.debuggerUrl === void 0 || !isLoopbackWsUrl(page.debuggerUrl)) return {
			ok: false,
			failure: "unsupported",
			reason: `${browserRead.reason} ${REASON_NO_PAGE_TARGET}`
		};
		const pageRead = await readCookies(wsFactory, page.debuggerUrl, origins, timeoutMs, "Network.getCookies");
		if (!("cookies" in pageRead)) return {
			ok: false,
			failure: pageRead.failure,
			reason: pageRead.reason
		};
		cookies = pageRead.cookies;
	}
	const { cookieHeader, names } = joinPairs(cookies);
	if (cookieHeader === "") return {
		ok: false,
		failure: "empty",
		reason: REASON_EMPTY
	};
	return {
		ok: true,
		cookieHeader,
		names,
		hosts
	};
}
function globalFetch() {
	const candidate = globalThis.fetch;
	if (typeof candidate !== "function") return void 0;
	return candidate;
}
//#endregion
//#region src/detect.ts
/**
* dsh-codehub — environment probes for the GitHub access picker (docs/DESIGN.md §3).
*
* WHAT THIS ANSWERS, AND WHAT IT REFUSES TO CLAIM
* ----------------------------------------------
* The user must be able to see whether a system proxy, a SOCKS5 endpoint, Watt
* Toolkit or a hosts entry is already in place, because "detected" changes which
* access strategy is worth selecting. It does NOT mean "enabled": Watt Toolkit
* still has to be switched on by the user, and hosts entries still have to be
* correct. The report says what was OBSERVED and nothing more — every inference
* is spelled out in `notes`.
*
* Sources, in order of trust:
*   1. the OS environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / lowercase),
*   2. the Windows per-user Internet Settings registry keys, read with a fixed
*      `reg.exe query` invocation (fixed binary, fixed arguments, no shell, a
*      hard timeout, failures swallowed). This is a read-only local probe — it
*      is not "spawning remote code", and it is the only dependency-free way to
*      see the system proxy on Windows,
*   3. the hosts file, scanned for GitHub/Gitee/CSDN-related names,
*   4. candidate Watt Toolkit install directories.
*
* Nothing here sends a packet: a probe never touches the network, and the
* plugin still installs no proxy of its own. Addresses appear in the REPORT
* (the browser half displays them) but never in a log line — `notes` is
* deliberately address-free.
*/
/** Registry key holding the per-user proxy configuration. */
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** Hard cap on the registry probe; a slow `reg.exe` must not stall the route. */
const REGISTRY_TIMEOUT_MS = 2500;
/** Hostnames whose presence in the hosts file is worth reporting. */
const HOSTS_INTEREST = [
	"github.com",
	"githubusercontent.com",
	"githubassets.com",
	"ghproxy",
	"ghfast",
	"gitmirror",
	"gitee.com",
	"csdn.net"
];
function readEnv(names) {
	for (const name of names) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
}
function isSocksAddress(value) {
	return /^socks(4a?|5h?):\/\//i.test(value.trim());
}
function parseRegistryValue(stdout, name) {
	const match = new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ|DWORD)\\s+(.*)$`, "m").exec(stdout);
	if (match === null) return void 0;
	const value = match[1].trim();
	return value.length > 0 ? value : void 0;
}
function queryRegistryValue(name) {
	return new Promise((resolve) => {
		if (process.platform !== "win32") {
			resolve(void 0);
			return;
		}
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			execFile("reg.exe", [
				"query",
				INTERNET_SETTINGS_KEY,
				"/v",
				name
			], {
				timeout: REGISTRY_TIMEOUT_MS,
				windowsHide: true,
				maxBuffer: 65536
			}, (error, stdout) => {
				if (error) {
					finish(void 0);
					return;
				}
				finish(parseRegistryValue(String(stdout), name));
			}).on("error", () => finish(void 0));
		} catch {
			finish(void 0);
		}
	});
}
async function detectSystemProxy(pluginProxy) {
	const notes = [];
	const httpProxy = readEnv(["HTTP_PROXY", "http_proxy"]);
	const httpsProxy = readEnv(["HTTPS_PROXY", "https_proxy"]);
	const allProxy = readEnv(["ALL_PROXY", "all_proxy"]);
	const noProxy = readEnv(["NO_PROXY", "no_proxy"]);
	const envCandidates = [];
	const addEnv = (value) => {
		if (typeof value === "string" && !envCandidates.includes(value)) envCandidates.push(value);
	};
	addEnv(httpsProxy);
	addEnv(httpProxy);
	addEnv(allProxy);
	let registryServer;
	let registryEnable;
	if (process.platform === "win32") {
		registryServer = await queryRegistryValue("ProxyServer");
		registryEnable = await queryRegistryValue("ProxyEnable");
	}
	const registryEnabled = registryEnable === void 0 ? void 0 : /^0x0*1$/i.test(registryEnable);
	const base = {
		...httpProxy === void 0 ? {} : { httpProxy },
		...httpsProxy === void 0 ? {} : { httpsProxy },
		...allProxy === void 0 ? {} : { allProxy },
		...noProxy === void 0 ? {} : { noProxy }
	};
	const socks5 = [...envCandidates, ...registryServer === void 0 ? [] : [registryServer]].find((candidate) => isSocksAddress(candidate)) ?? false;
	if (envCandidates.length > 0) {
		notes.push("检测到环境变量代理设置（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），已在报告中给出原始地址。");
		return {
			...base,
			enabled: true,
			source: "env",
			systemProxy: envCandidates[0],
			configuredProxy: envCandidates[0],
			socks5,
			notes
		};
	}
	if (registryServer !== void 0) {
		const enabled = registryEnabled !== false;
		notes.push(enabled ? "检测到 Windows Internet 设置里的系统代理。检测到不等于本插件会使用它：只有在访问方式里勾选「本机代理」并填写地址后才会生效。" : "Windows Internet 设置里配置了代理地址，但 ProxyEnable 为 0（未启用）；本插件不会替你启用它。");
		return {
			...base,
			enabled,
			source: "registry",
			systemProxy: enabled ? registryServer : false,
			configuredProxy: registryServer,
			socks5,
			notes
		};
	}
	notes.push("未检测到系统代理（环境变量与 Windows Internet 设置均为空）。");
	return {
		...base,
		enabled: false,
		source: "none",
		systemProxy: false,
		configuredProxy: false,
		socks5,
		notes
	};
}
function hostsFilePath() {
	if (process.platform === "win32") {
		const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
		return join(root, "System32", "drivers", "etc", "hosts");
	}
	return "/etc/hosts";
}
async function detectHosts() {
	const path = hostsFilePath();
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {
			path,
			readable: false,
			entries: [],
			note: "hosts 文件不可读（权限或路径不同）；这不影响本插件，只是无法提示 Hosts 方式是否已生效。"
		};
	}
	const entries = [];
	for (const line of text.split(/\r?\n/).slice(0, 2e4)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const lower = trimmed.toLowerCase();
		if (!HOSTS_INTEREST.some((needle) => lower.includes(needle))) continue;
		if (entries.length < 20 && !entries.includes(trimmed)) entries.push(trimmed);
	}
	return {
		path,
		readable: true,
		entries,
		note: entries.length > 0 ? "hosts 文件里存在与本项目相关的主机名条目。请自行确认它们当前仍然有效 —— 本插件不硬编码、也不改写任何 IP。" : "hosts 文件可读，但没有与本项目相关的主机名条目。"
	};
}
/** Candidate install directories, relative to a Windows root variable. */
const WATT_INSTALL_HINTS = [
	["ProgramFiles", "Watt Toolkit"],
	["ProgramFiles(x86)", "Watt Toolkit"],
	["LOCALAPPDATA", "Watt Toolkit"],
	["ProgramFiles", "Steam++"],
	["ProgramFiles(x86)", "Steam++"],
	["LOCALAPPDATA", "Steam++"]
];
async function detectWatt() {
	const evidence = [];
	if (process.platform === "win32") for (const [variable, folder] of WATT_INSTALL_HINTS) {
		const root = process.env[variable];
		if (typeof root !== "string" || root.trim().length === 0) continue;
		const candidate = join(root, folder);
		try {
			await access(candidate);
			evidence.push(`${variable}\\${folder}`);
		} catch {}
	}
	return {
		detected: evidence.length > 0,
		evidence,
		note: "本插件不自带、也不内置任何代理。若已安装 Watt Toolkit（官网 steampp.net），请在它的「网络加速」里勾选 GitHub，再把上面检测到的系统代理地址填进「本机代理 / SOCKS5」。检测到安装目录不等于加速已启用。"
	};
}
/**
* Run every probe. Never throws: an unavailable probe reports what it could not
* see, because "unknown" is a legitimate answer for a picker to render.
*/
async function detectEnvironment(options = {}) {
	const pluginProxy = typeof options.localProxy === "string" ? options.localProxy.trim() : "";
	const [proxy, watt, hosts] = await Promise.all([
		detectSystemProxy(pluginProxy),
		detectWatt(),
		detectHosts()
	]);
	const notes = [...proxy.notes];
	if (pluginProxy.length > 0) notes.push("本插件自己配置的代理地址已记录（仅存于 $DSH_HOME/dsh-codehub.json，权限 0600），并且仅 Node 直连传输生效。");
	if (proxy.systemProxy === false && proxy.socks5 === false && pluginProxy.length > 0) notes.push("系统里没有检测到代理，但本插件自己配置了代理地址 —— 该地址按设计只在 Node 直连传输生效。");
	return {
		platform: process.platform,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		systemProxy: proxy.systemProxy,
		socks5: proxy.socks5,
		watt: watt.detected,
		hosts: hosts.entries.length > 0,
		proxyEnabled: proxy.enabled,
		proxySource: proxy.source,
		pluginProxy: pluginProxy.length > 0 ? pluginProxy : false,
		wattDetail: watt.evidence,
		hostsEntries: hosts.entries,
		hostsPath: hosts.path,
		notes: [
			...notes,
			watt.note,
			hosts.note
		]
	};
}
//#endregion
//#region src/gating.ts
/**
* dsh-codehub — 决策点门禁 (docs/DESIGN.md §2).
*
* THE INVARIANT: the plugin never decides on the user's behalf.
*
* Four decisions are owned by the user. Until each one has an answer, the tool
* refuses to run — and the refusal happens BEFORE any network access, so an
* unanswered question can never be "helpfully" pre-answered by fetching data
* first and asking afterwards. `service.search()` calls `evaluateDecisions()`
* as its first statement and returns early; `src/tool.ts` never reaches the
* transport on that path. That ordering is the whole point of this module.
*
* `undefined` IS NOT `false`
* --------------------------
* `failoverEnabled` and `mergeSources` are tri-state:
*
*   | value       | meaning                                    |
*   |-------------|--------------------------------------------|
*   | `undefined` | never asked -> REFUSE and ask the user      |
*   | `false`     | decided: "do not degrade" / "do not merge"  |
*   | `true`      | decided: "do it"                            |
*
* `false` is a perfectly good answer and MUST pass the gate. Any truthiness
* check (`if (!cfg.mergeSources) refuse`) would be a bug, which is why the
* readers below are explicit `typeof value === 'boolean'` narrowings and the
* decision state carries `boolean | undefined` rather than `boolean`.
*
* `sourcePriority` / `githubAccessPriority` use the other spelling of
* "undecided": the EMPTY LIST. An empty list must never be read as "all
* sources" or "just use the default order" — it means the user has not ranked
* them yet, and the plugin must ask.
*/
function listOf(value, allowed) {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length === 0) continue;
		if (!allowed.includes(trimmed)) continue;
		if (!out.includes(trimmed)) out.push(trimmed);
	}
	return out.length > 0 ? out : void 0;
}
/** `undefined` unless the value is literally a boolean — `false` survives. */
function boolOf(value) {
	return typeof value === "boolean" ? value : void 0;
}
function firstDefined(...values) {
	for (const value of values) if (value !== void 0) return value;
}
/**
* Normalise any acceptable input into the four tri-state values.
*
* Accepts `undefined` / `null` (an empty config) and reports everything as
* undecided rather than throwing — a missing config is the most common way to
* reach a freshly-installed plugin.
*/
function decisionState(input) {
	const source = typeof input === "object" && input !== null ? input : {};
	const github = typeof source.github === "object" && source.github !== null ? source.github : {};
	const failover = typeof source.failover === "object" && source.failover !== null ? source.failover : {};
	return {
		sourcePriority: listOf(source.sourcePriority, SOURCES),
		githubAccessPriority: firstDefined(listOf(github.accessPriority, GITHUB_ACCESS), listOf(source.githubAccessPriority, GITHUB_ACCESS)),
		failoverEnabled: firstDefined(boolOf(failover.enabled), boolOf(source.failoverEnabled)),
		mergeSources: boolOf(source.mergeSources)
	};
}
/** One frozen guide entry, copied so callers cannot mutate `DECISION_GUIDE`. */
function decisionGuideFor(key) {
	const guide = DECISION_GUIDE[key];
	return {
		key: guide.key,
		detail: guide.detail,
		ask: guide.ask,
		control: guide.control
	};
}
/** True when this decision has an answer — including the answer `false`. */
function isDecided(state, key) {
	switch (key) {
		case "sourcePriority": return state.sourcePriority !== void 0;
		case "githubAccessPriority": return state.githubAccessPriority !== void 0;
		case "failoverEnabled": return state.failoverEnabled !== void 0;
		case "mergeSources": return state.mergeSources !== void 0;
		default: return true;
	}
}
/**
* Every unresolved decision, in `DECISION_KEYS` order (stable, so the rendered
* question list does not reshuffle between calls).
*/
function unresolvedDecisions(input) {
	const state = isDecisionState(input) ? input : decisionState(input);
	const out = [];
	for (const key of DECISION_KEYS) if (!isDecided(state, key)) out.push(decisionGuideFor(key));
	return out;
}
function isDecisionState(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	return "sourcePriority" in candidate && "githubAccessPriority" in candidate && "failoverEnabled" in candidate && "mergeSources" in candidate && !("github" in candidate) && !("failover" in candidate);
}
/**
* Decide whether the tool may run.
*
* A closed gate means: zero network requests, a `ok:false` value the model can
* branch on, and one question per unresolved decision that the model is
* expected to relay to the user verbatim.
*/
function evaluateDecisions(input) {
	const unresolved = unresolvedDecisions(input);
	if (unresolved.length === 0) return { ok: true };
	return {
		ok: false,
		unresolved_decisions: unresolved,
		ask_user: decisionPrompt(unresolved)
	};
}
/**
* The message returned when the plugin itself is switched off.
*
* Deliberately separate from the decision gate: "disabled" is not an unanswered
* decision, and mixing the two would send the user to the wrong control.
*/
function disabledRefusal() {
	return {
		ok: false,
		reason: "dsh-codehub 当前处于关闭状态（config.enabled = false），未发起任何网络请求。",
		ask_user: "dsh-codehub 现在是关闭的。要我在设置里打开它再查吗？"
	};
}
//#endregion
//#region src/sources/types.ts
/**
* dsh-codehub — source-adapter surface.
*
* OWNER: `adapters`. Consumers: the host half (`src/net.ts`, `src/tool.ts`)
* builds `AdapterSearchOptions`; the three source adapters return
* `AdapterOutcome` / `AdapterDeepOutcome`.
*
* Three rules are encoded here rather than left to convention:
*
* 1. 备注① — an adapter performs NO network I/O of its own. Every request goes
*    through the injected `Transport`. Whatever note the transport attaches
*    (for example `LOCAL_PROXY_SCOPE_NOTE` — 仅 Node 直连传输生效) is collected
*    by `transportNotes()` and copied into `reason` verbatim by `joinReason()`.
*    It is never replaced by a generic message.
* 2. Failures are values, not thrown exceptions. Every adapter failure maps to
*    exactly one `FailureKind`, because `degrade.ts` decides whether to advance
*    a chain from that value alone.
* 3. Endpoint literals live in `contract.ts` only. This file imports them; it
*    never re-spells a URL.
*/
/** Per-request timeout, clamped into `(0, HARD_LIMITS.timeoutMs]`. */
function clampTimeout(timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_LIMITS.timeoutMs;
	return Math.min(Math.floor(timeoutMs), HARD_LIMITS.timeoutMs);
}
/** Row bound, clamped into `[1, HARD_LIMITS.maxItems]`. */
function clampMaxItems(maxItems) {
	if (typeof maxItems !== "number" || !Number.isFinite(maxItems) || maxItems < 1) return DEFAULT_LIMITS.maxItems;
	return Math.min(Math.floor(maxItems), HARD_LIMITS.maxItems);
}
/** Excerpt bound, clamped into `[1, HARD_LIMITS.maxCodeChars]`. */
function clampMaxCodeChars$1(maxCodeChars) {
	if (typeof maxCodeChars !== "number" || !Number.isFinite(maxCodeChars) || maxCodeChars < 1) return DEFAULT_LIMITS.maxCodeChars;
	return Math.min(Math.floor(maxCodeChars), HARD_LIMITS.maxCodeChars);
}
/** Join reason clauses with `；`, dropping empties. Order is preserved. */
function joinReason(...parts) {
	const kept = [];
	for (const part of parts) {
		if (typeof part !== "string") continue;
		const trimmed = part.trim();
		if (trimmed.length > 0 && !kept.includes(trimmed)) kept.push(trimmed);
	}
	return kept.join("；");
}
/** Narrow an unknown value to a `FailureKind`. */
function isFailureKind(value) {
	return typeof value === "string" && FAILURE_KINDS.includes(value);
}
/** Like `joinReason()`, but yields `undefined` when nothing survives. */
function optionalReason(...parts) {
	const joined = joinReason(...parts.slice());
	return joined.length > 0 ? joined : void 0;
}
/** Only failures in `RETRYABLE_FAILURES` may advance a failover chain. */
function isRetryableFailure(failure) {
	return failure !== void 0 && RETRYABLE_FAILURES.includes(failure);
}
/** Collect transport notes (备注①) in order, `note` first, then `notes`. */
function transportNotes(res) {
	if (res === void 0 || res === null) return [];
	const out = [];
	if (typeof res.note === "string" && res.note.trim().length > 0) out.push(res.note.trim());
	const list = res.notes;
	if (list !== void 0) {
		for (const item of list) if (typeof item === "string" && item.trim().length > 0 && !out.includes(item.trim())) out.push(item.trim());
	}
	return out;
}
function messageOf$2(err) {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null) {
		const candidate = err.message;
		if (typeof candidate === "string") return candidate;
	}
	try {
		return String(err);
	} catch {
		return "传输层抛出了无法读取的错误对象";
	}
}
/**
* Map a thrown transport error onto one `FailureKind`.
*
* The transport's own wording is kept verbatim (备注①): `src/net.ts` may explain
* that a setting only applies to the node channel, and that sentence must reach
* the agent unchanged. A pre-classified `failure` / `kind` property on the error
* is honoured when present.
*/
function classifyTransportError(err) {
	const message = messageOf$2(err);
	const detail = message.trim().length > 0 ? message.trim() : "传输层未给出错误信息";
	if (typeof err === "object" && err !== null) {
		const explicit = err;
		const kind = explicit.failure ?? explicit.kind;
		if (isFailureKind(kind)) return {
			failure: kind,
			reason: `传输失败（${kind}）：${detail}`
		};
	}
	const name = err instanceof Error ? err.name : "";
	const lower = message.toLowerCase();
	if (name === "AbortError" || name === "TimeoutError" || /timeout|timed out|etimedout|超时/.test(lower)) return {
		failure: "timeout",
		reason: `传输超时：${detail}`
	};
	if (/too many requests|rate ?limit|429|限流/.test(lower)) return {
		failure: "rate-limited",
		reason: `传输被限流：${detail}`
	};
	if (/unauthorized|forbidden|bad credentials|requires authentication|401|403|凭据/.test(lower)) return {
		failure: "auth-required",
		reason: `传输缺少有效凭据：${detail}`
	};
	if (/unexpected token|json|parse|解析/.test(lower)) return {
		failure: "parse-failed",
		reason: `传输返回的内容无法解析：${detail}`
	};
	return {
		failure: "network",
		reason: `网络请求失败：${detail}`
	};
}
/**
* Classify a non-2xx `TransportResponse`. Returns null for 2xx so callers can
* proceed to parse. `what` is the human subject, e.g. `GitHub 仓库搜索`.
*/
function failureFromResponse(res, what) {
	const status = res.statusCode;
	const notes = transportNotes(res);
	const suffix = notes.length > 0 ? `；${notes.join("；")}` : "";
	if (typeof status !== "number" || !Number.isFinite(status) || status <= 0) return null;
	if (status >= 200 && status < 300) return null;
	const lower = (typeof res.body === "string" ? res.body.slice(0, 400) : "").toLowerCase();
	if (status === 401) return {
		failure: "auth-required",
		reason: `${what} 需要登录或凭据无效（HTTP 401）${suffix}`
	};
	if (status === 403) return /rate limit|too many requests|abuse|限流/.test(lower) ? {
		failure: "rate-limited",
		reason: `${what} 被限流（HTTP 403）${suffix}`
	} : {
		failure: "auth-required",
		reason: `${what} 被拒绝，可能需要登录或凭据不足（HTTP 403）${suffix}`
	};
	if (status === 404) return {
		failure: "empty",
		reason: `${what} 未找到（HTTP 404）：接口路径可能已变更，或该目标不存在${suffix}`
	};
	if (status === 408) return {
		failure: "timeout",
		reason: `${what} 请求超时（HTTP 408）${suffix}`
	};
	if (status === 429) return {
		failure: "rate-limited",
		reason: `${what} 被限流（HTTP 429）${suffix}`
	};
	if (status >= 500) return {
		failure: "network",
		reason: `${what} 服务端错误（HTTP ${status}）${suffix}`
	};
	if (status >= 400) return {
		failure: "parse-failed",
		reason: `${what} 请求被拒绝（HTTP ${status}）：查询或参数不被接受${suffix}`
	};
	return {
		failure: "network",
		reason: `${what} 返回了未预期的状态码（HTTP ${status}）${suffix}`
	};
}
/**
* Token carriage gate. Mirrors listed in `TOKEN_FORBIDDEN_ACCESS` (ghproxy,
* raw-mirror, third-party-mirror) must never see a credential, so this returns
* undefined for them even when the caller passed a token.
*/
function tokenForAccess(access, token) {
	if (typeof token !== "string" || token.trim().length === 0) return void 0;
	if (access !== void 0 && TOKEN_FORBIDDEN_ACCESS.includes(access)) return;
	return token;
}
/** Truncate an excerpt to `limit` chars and report whether anything was cut. */
function boundExcerpt(text, limit) {
	const bound = clampMaxCodeChars$1(limit);
	if (text.length <= bound) return {
		code: text,
		codeTruncated: false
	};
	return {
		code: text.slice(0, bound),
		codeTruncated: true
	};
}
//#endregion
//#region src/learn/summary.ts
/** Bounds that keep a summary a summary. Exported so tests can assert them. */
const SUMMARY_LIMITS = {
	maxBulletsPerSection: 3,
	maxBulletChars: 220,
	maxTotalChars: 1200,
	minBulletChars: 6
};
const APPROACH_KEYWORDS = [
	"思路",
	"实现",
	"原理",
	"架构",
	"设计",
	"流程",
	"机制",
	"做法",
	"方案",
	"通过",
	"首先",
	"然后",
	"接着",
	"最后",
	"整体",
	"结构",
	"overview",
	"architecture",
	"approach",
	"design",
	"implementation",
	"pipeline",
	"workflow",
	"how it works",
	"structure",
	"pattern"
];
const API_KEYWORDS = [
	"接口",
	"用法",
	"参数",
	"返回值",
	"返回",
	"调用",
	"签名",
	"配置项",
	"导入",
	"依赖",
	"方法",
	"函数",
	"属性",
	"回调",
	"钩子",
	"组件",
	"字段",
	"命令",
	"usage",
	"signature",
	"parameter",
	"argument",
	"endpoint",
	"method",
	"option",
	"flag",
	"callback",
	"hook",
	"props",
	"instance",
	"export",
	"install",
	"config",
	"default"
];
const TRADEOFF_KEYWORDS = [
	"取舍",
	"权衡",
	"对比",
	"相比",
	"优点",
	"缺点",
	"优势",
	"劣势",
	"代价",
	"替代",
	"更合适",
	"推荐用",
	"性能",
	"体积",
	"兼容",
	"tradeoff",
	"trade-off",
	"versus",
	"downside",
	"upside",
	"pros",
	"cons",
	"alternative",
	"instead",
	"prefer",
	"faster",
	"slower",
	"overhead"
];
const PITFALL_KEYWORDS = [
	"坑",
	"踩坑",
	"注意",
	"警告",
	"小心",
	"避免",
	"不要",
	"不能",
	"无法",
	"报错",
	"异常",
	"失败",
	"限制",
	"缺陷",
	"坑点",
	"容易",
	"务必",
	"切记",
	"gotcha",
	"pitfall",
	"caveat",
	"warning",
	"limitation",
	"avoid",
	"fails",
	"breaks",
	"crash",
	"issue",
	"bug",
	"must not",
	"deprecated"
];
function escapeRegExp(input) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compile(keywords) {
	return keywords.map((keyword) => {
		const text = keyword.toLowerCase();
		return {
			text,
			re: /^[\x20-\x7e]+$/.test(text) ? new RegExp(`\\b${escapeRegExp(text)}\\b`) : null
		};
	});
}
const COMPILED = {
	approach: compile(APPROACH_KEYWORDS),
	apiContract: compile(API_KEYWORDS),
	tradeoffs: compile(TRADEOFF_KEYWORDS),
	pitfalls: compile(PITFALL_KEYWORDS)
};
/** Tie-break order when one sentence hits several categories. */
const PRIORITY = [
	"pitfalls",
	"tradeoffs",
	"apiContract",
	"approach"
];
/** Page chrome that must never become a "takeaway". */
const NOISE_PATTERNS = [
	/^(目录|登录|注册|首页|上一篇|下一篇|相关推荐|热门文章|最新文章|推荐文章|展开|收起|点赞|收藏|评论|分享)$/,
	/(版权声明|本文为博主原创文章|转载请注明|未经许可|扫码关注|微信公众号|订阅|广告|赞助)/,
	/(阅读量|浏览量|点赞数|收藏数|评论数|发布于|更新时间)\s*[:：]?/,
	/^(https?:\/\/\S+)$/i,
	/^\s*[|·•\-—_=+*]{3,}\s*$/
];
const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	middot: "·",
	times: "×",
	laquo: "«",
	raquo: "»",
	ldquo: "“",
	rdquo: "”",
	lsquo: "‘",
	rsquo: "’",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°"
};
function fromCodePoint(code, fallback) {
	if (!Number.isFinite(code) || code < 0 || code > 1114111) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}
/** Decode the HTML entities that appear in search payloads. */
function decodeEntities(text) {
	return text.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => fromCodePoint(Number.parseInt(hex, 16), match)).replace(/&#(\d+);/g, (match, dec) => fromCodePoint(Number.parseInt(dec, 10), match)).replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => ENTITIES[name] ?? match);
}
/** Strip markup, keeping text content. Inline `<code>` survives (API names matter). */
function stripHtml(text) {
	return decodeEntities(text.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|td|h[1-6]|section|article|blockquote|ul|ol|table)>/gi, "\n").replace(/<(pre|code|textarea|figure)\b[^>]*>/gi, "\n").replace(/<\/(pre|code|textarea|figure)>/gi, "\n")).replace(/<[^>]*>/g, " ");
}
/** Remove fenced blocks, `<pre>` blocks and indented code runs. */
function stripCodeBlocks(text) {
	const withoutFences = text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n").replace(/<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n").replace(/```[\s\S]*$/g, "\n");
	const kept = [];
	for (const rawLine of withoutFences.split(/\r?\n/)) {
		if (/^(?: {4,}|\t)/.test(rawLine)) continue;
		kept.push(rawLine);
	}
	return kept.join("\n");
}
/** True when a line is code-shaped rather than prose. */
function looksLikeCode(line) {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;
	for (const start of [
		"import ",
		"export ",
		"from ",
		"const ",
		"let ",
		"var ",
		"function ",
		"class ",
		"interface ",
		"enum ",
		"def ",
		"async def",
		"return ",
		"yield ",
		"if (",
		"for (",
		"while (",
		"switch (",
		"catch (",
		"else {",
		"try {",
		"throw ",
		"public ",
		"private ",
		"protected ",
		"static ",
		"package ",
		"#include",
		"#define",
		"using ",
		"namespace ",
		"impl ",
		"fn ",
		"pub ",
		"struct ",
		"module.exports",
		"require(",
		"console.",
		"print(",
		"fmt.",
		"<?php",
		"<!DOCTYPE"
	]) if (trimmed.startsWith(start)) return true;
	if (/^[)\]}]/.test(trimmed)) return true;
	if (/[{};]\s*$/.test(trimmed) && /[(){}=]/.test(trimmed)) return true;
	if (/^(?:sudo|npm|pnpm|yarn|npx|git|docker|curl|cargo|go|pip)\s/.test(trimmed)) return true;
	const operators = trimmed.match(/=>|->|::|\$\{|===|!==|&&|\|\||\+=|-=|\*=|\/=|!=|==|\+\+|--/g);
	if (operators !== null && operators.length >= 2) return true;
	const symbols = trimmed.match(/[(){}\[\]=;<>|&]/g);
	if (symbols !== null && trimmed.length >= 16 && symbols.length / trimmed.length > .2) return true;
	return false;
}
/** Strip markdown decorations from one prose fragment. */
function stripMarkdown(line) {
	return decodeEntities(line.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}#{1,6}\s*/, "").replace(/^\s*>\s?/, "").replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^\w])__([^_]+)__(?!\w)/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/[*_~]/g, ""));
}
function headingText(line) {
	const hash = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
	if (hash !== null) return hash[2] ?? null;
	const bold = /^\s*\*\*(.+?)\*\*\s*[:：]?\s*$/.exec(line);
	if (bold !== null) return bold[1] ?? null;
	const bracket = /^\s*【(.+?)】\s*[:：]?\s*$/.exec(line);
	if (bracket !== null) return bracket[1] ?? null;
	return null;
}
function scoreCategory(lower, category) {
	let hits = 0;
	for (const keyword of COMPILED[category]) if (keyword.re !== null ? keyword.re.test(lower) : lower.includes(keyword.text)) hits += 1;
	return hits;
}
function categoryOf(text) {
	const lower = text.toLowerCase();
	let best = null;
	let bestHits = 0;
	for (const category of PRIORITY) {
		const hits = scoreCategory(lower, category);
		if (hits > bestHits) {
			best = category;
			bestHits = hits;
		}
	}
	return best;
}
/** Split prose into sentence-ish fragments (CJK punctuation, then latin periods). */
function splitSentences(text) {
	const out = [];
	for (const chunk of text.split(/[。！？!?；;\n]+/)) {
		const trimmed = chunk.trim();
		if (trimmed.length === 0) continue;
		for (const latin of trimmed.split(/\.\s+(?=[A-Z(])/)) {
			const piece = latin.trim().replace(/\.$/, "").trim();
			if (piece.length > 0) out.push(piece);
		}
	}
	return out;
}
function letterCount(text) {
	const matched = text.match(/[\p{L}\p{N}]/gu);
	return matched === null ? 0 : matched.length;
}
function isNoise(text) {
	for (const pattern of NOISE_PATTERNS) if (pattern.test(text)) return true;
	return false;
}
/** Clean one candidate fragment, or null when it is not usable prose. */
function cleanProse(fragment) {
	const stripped = stripMarkdown(fragment).replace(/\s+/g, " ").trim();
	if (stripped.length < SUMMARY_LIMITS.minBulletChars) return null;
	if (letterCount(stripped) < SUMMARY_LIMITS.minBulletChars) return null;
	if (looksLikeCode(stripped)) return null;
	if (isNoise(stripped)) return null;
	if (/^[\s\p{P}\p{S}]+$/u.test(stripped)) return null;
	if (stripped.length > SUMMARY_LIMITS.maxBulletChars) return `${stripped.slice(0, SUMMARY_LIMITS.maxBulletChars - 1)}…`;
	return stripped;
}
function pushUnique(bucket, value) {
	if (bucket.includes(value)) return;
	bucket.push(value);
}
/**
* Extract the four takeaway buckets from raw text. Code is removed before
* reading, so no bullet can be a line of source.
*/
function extractSections(text) {
	const buckets = {
		approach: [],
		apiContract: [],
		tradeoffs: [],
		pitfalls: []
	};
	const prose = stripHtml(stripCodeBlocks(text));
	let bias = null;
	for (const rawLine of prose.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const heading = headingText(line);
		if (heading !== null) {
			bias = categoryOf(heading);
			continue;
		}
		if (looksLikeCode(line)) continue;
		for (const sentence of splitSentences(line)) {
			const clean = cleanProse(sentence);
			if (clean === null) continue;
			pushUnique(buckets[categoryOf(clean) ?? bias ?? "approach"], clean);
		}
	}
	const cap = (items) => items.slice(0, SUMMARY_LIMITS.maxBulletsPerSection);
	return {
		approach: cap(buckets.approach),
		apiContract: cap(buckets.apiContract),
		tradeoffs: cap(buckets.tradeoffs),
		pitfalls: cap(buckets.pitfalls)
	};
}
const SECTION_LABELS = {
	approach: "实现思路",
	apiContract: "API 用法",
	tradeoffs: "取舍",
	pitfalls: "坑"
};
function renderSection(category, items) {
	if (items.length === 0) return "";
	return `${SECTION_LABELS[category]}：${items.join("；")}`;
}
/** Render the four buckets as the `learned_summary` string. */
function renderSummary(sections) {
	const parts = [];
	for (const category of [
		"approach",
		"apiContract",
		"tradeoffs",
		"pitfalls"
	]) {
		const rendered = renderSection(category, sections[category]);
		if (rendered.length > 0) parts.push(rendered);
	}
	if (parts.length === 0) return "未能从该来源文本中抽取出可读的思路要点（原文可能以代码为主）。";
	const joined = parts.join("\n");
	if (joined.length <= SUMMARY_LIMITS.maxTotalChars) return joined;
	return `${joined.slice(0, SUMMARY_LIMITS.maxTotalChars - 1)}…`;
}
/** Summarize a mixed payload: title / description / README / body / extras. */
function summarize(input) {
	const chunks = [];
	if (typeof input.description === "string") chunks.push(input.description);
	if (typeof input.readme === "string") chunks.push(input.readme);
	if (typeof input.body === "string") chunks.push(input.body);
	const extras = input.extras;
	if (extras !== void 0) {
		for (const extra of extras) if (typeof extra === "string") chunks.push(extra);
	}
	const summary = renderSummary(extractSections(chunks.join("\n\n")));
	if (!summary.startsWith("未能从该来源文本中抽取出可读的思路要点")) return summary;
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (title.length > 0) return `仅命中标题信息${typeof input.language === "string" && input.language.length > 0 ? `（${input.language}）` : ""}：${title}；未从原文抽取出可读的思路要点。`;
	return summary;
}
//#endregion
//#region src/learn/score.ts
/**
* dsh-codehub — 置信度与理由（纯函数）.
*
* `confidence` is a function of exactly four things, per the brief:
*
*   源等级（SOURCE_WEIGHT）× 是否登录 × 是否转载 × 解析完整度
*
* CSDN carries the lowest source weight and can therefore never reach `high`
* on its own (see `CSDN_CONFIDENCE_CEILING`). The same call also produces the
* one-sentence `reason`; extra clauses handed in by a caller — such as a
* transport-provenance note (备注①) — are appended verbatim, never dropped.
*
* Everything here is pure: no clock, no network, no globals.
*/
/** Source tier. GitHub 3 > Gitee 2 > CSDN 1 — CSDN is a supplement only. */
const SOURCE_WEIGHT = {
	github: 3,
	gitee: 2,
	csdn: 1
};
/** Highest level any CSDN row may reach, no matter how it scores. */
const CSDN_CONFIDENCE_CEILING = "medium";
const LEVEL_RANK$1 = {
	low: 1,
	medium: 2,
	high: 3
};
/** Lower a level so it never exceeds `ceiling`. */
function capConfidence(level, ceiling) {
	return LEVEL_RANK$1[level] > LEVEL_RANK$1[ceiling] ? ceiling : level;
}
/** Clamp a completeness ratio into `[0, 1]`; non-finite input becomes 0. */
function clampCompleteness(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}
/** Rounded completeness ratio of `present` out of `expected` fields. */
function completenessOf(present, expected) {
	if (!Number.isFinite(expected) || expected <= 0) return 0;
	return clampCompleteness(present / expected);
}
/** Completeness of a parsed object against the field names that were expected. */
function completenessFrom(fields, keys) {
	if (keys.length === 0) return 0;
	let present = 0;
	for (const key of keys) {
		const value = fields[key];
		if (value === void 0 || value === null) continue;
		if (typeof value === "string" && value.trim().length === 0) continue;
		present += 1;
	}
	return completenessOf(present, keys.length);
}
/**
* Weigh the four factors and emit the level plus one sentence.
*
* The reason always names the source tier, the login state, the completeness
* band, the final points and the resulting level, so a reader can re-derive it.
*/
function score(input) {
	const weight = SOURCE_WEIGHT[input.source];
	const completeness = clampCompleteness(input.completeness);
	const factors = [`源等级 ${weight}/3`];
	let points = weight;
	if (input.authenticated) {
		points += 1;
		factors.push("已登录");
	} else factors.push("未登录（匿名）");
	if (input.reposted) {
		points -= 2;
		factors.push("非原创（转载）条目已降权");
	} else factors.push("原创标注");
	if (completeness >= .8) {
		points += 1;
		factors.push(`解析完整度高（${Math.round(completeness * 100)}%）`);
	} else if (completeness >= .4) factors.push(`解析完整度中（${Math.round(completeness * 100)}%）`);
	else {
		points -= 1;
		factors.push(`解析完整度低（${Math.round(completeness * 100)}%）`);
	}
	let confidence = points >= 5 ? "high" : points >= 3 ? "medium" : "low";
	if (input.source === "csdn") confidence = capConfidence(confidence, CSDN_CONFIDENCE_CEILING);
	const notes = joinReason(...(input.notes === void 0 ? [] : input.notes).filter((note) => typeof note === "string"));
	const tail = notes.length > 0 ? `；${notes}` : "";
	const reason = `${SOURCE_LABELS[input.source]}：${factors.join("、")}，综合 ${points} 分 → ${confidence}${tail}。`;
	return {
		confidence,
		reason
	};
}
//#endregion
//#region src/sources/csdn.ts
/**
* dsh-codehub — CSDN 源适配器（补充源，权重最低）.
*
* ── 备注② 接口来源标注（contract.ts 的 `CSDN_API_NOTE` 全文，逐字保留）───────
*
*   CSDN v3 搜索接口为非官方内部接口（非公开 API），实测日期 2026-10-03，字段与可用性可能随时失效；失效时请改用 CSDN 网页搜索或关闭该源。
*
* 三要素必须同时存在：**非官方**（非公开 API）、**实测日期 2026-10-03**
* （`CSDN_API_PROBED_AT`）、**可能失效**。上面这一行与 `CSDN_API_NOTE` 完全一致，
* 由 `CSDN_API_NOTE` / `CSDN_API_PROBED_AT` 两个常量在运行时导出（见
* `CSDN_PROVENANCE` 与 `CSDN_SEARCH_BASE` 旁的说明），端点一旦失效，失败原因里会带上
* 该 note 全文，而不是抛一个裸异常。
*
* 备注①：本适配器不自己发网络请求 —— 一切经注入的 `Transport`，且 transport 附带的
* 说明（例如「仅 Node 直连传输生效」）会被原样拼进 `reason`。
*
* 备注③：只产出「思路」摘要 + 有界代码摘录（`code` 仅学习参考），`is_verbatim_copy`
* 恒为 false；`deepRead` 明确拒绝（CSDN 只作浅搜索补充）。
*
* ── 登录要求 / 反爬 / robots（单一来源见 contract.ts）─────────────────────────
*
* 实测 2026-10-04：搜索接口匿名可用（HTTP 200，30 条中仅 6 条带 `body`），正文代码
* 需要打开文章页；文章页缺浏览器 UA / Referer 时会被 **HTTP 521** 反爬拦截，带上后
* 200 且 19 个 `<pre>` 可抽。`so.csdn.net/robots.txt` 是 `Disallow: /`。这三件事分别
* 由 `CSDN_LOGIN_REQUIREMENT` 与 `CSDN_ROBOTS_DISCLOSURE` 承载，本文件只引用、不重写：
* 失败文案里带上它们，用户才知道「要不要登录、站点允不允许抓」。
*/
/** `result_vos[]` fields this adapter reads. Nothing outside this list is read. */
const CSDN_RESULT_FIELDS = [
	"title",
	"body",
	"description",
	"url",
	"originalType",
	"create_time",
	"author",
	"view"
];
/**
* 转载降权的两种说明（三态，见 `searchCsdn` 里 `reposted` 的推导）。
*
* `originalType` was measured to be ABSENT from the anonymous response
* (2026-10-04), so "missing" must not be read as "转载": that would down-weight
* every row and hide real hits. Only an explicit non-「原创」 value is a repost.
*/
const REPOST_NOTE = "原文 originalType 非「原创」，疑似转载，已降低置信度";
const ORIGINAL_TYPE_UNKNOWN_NOTE = "来源类型未知（响应里没有 originalType 字段），未按转载降权";
/**
* Browser-like User-Agent. Measured 2026-10-04: an article page answers **HTTP
* 521** to a request without a browser UA + Referer, and 200 with them. Kept as
* an exported constant so a test can assert the headers CSDN actually receives.
*/
const CSDN_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** Referer that pairs with the UA above; the search page is the natural origin. */
const CSDN_SEARCH_REFERER = "https://so.csdn.net/";
/** Accept header for the JSON search endpoint. */
const CSDN_SEARCH_ACCEPT = "application/json, text/plain, */*";
/** Accept header for an article page (HTML). */
const CSDN_ARTICLE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
/** CSDN 登录态是 Cookie，不是 Bearer token（见 `csdnRequestHeaders()`）。 */
const CSDN_REQUEST_HEADERS = {
	accept: CSDN_SEARCH_ACCEPT,
	"user-agent": CSDN_BROWSER_USER_AGENT,
	referer: CSDN_SEARCH_REFERER
};
/** 521 时的中文说明：结论（被反爬拦截）+ 现状（已带 UA/Referer）+ 出路（登录 cookie）。 */
const CSDN_ARTICLE_BLOCKED_NOTE = "文章页触发 CSDN 反爬（HTTP 521）：请求已带浏览器 UA / Referer 仍被拦截，站点会按频次与指纹判定自动抓取；带上登录 cookie 可提高成功率";
/** 文章页抽到代码时的来源说明（搜索结果本身不带正文）。 */
const CSDN_ARTICLE_CODE_NOTE = "代码来自文章页（so.csdn.net 的搜索结果不带正文）";
/** 文章页 200 但没有可抽代码块时的说明。 */
const CSDN_ARTICLE_NO_CODE_NOTE = "文章页已打开，但没有可抽取的代码块";
function isRecord$5(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString$2(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function asNumber$2(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
}
/**
* CSDN timestamps arrive as epoch numbers, epoch strings, or Beijing-time
* strings. Unknown input yields null rather than a fabricated date.
*/
function parseCsdnTime(value) {
	const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{9,13}$/.test(value.trim()) ? Number(value.trim()) : void 0;
	if (numeric !== void 0 && Number.isFinite(numeric)) {
		const ms = numeric > 1e11 ? numeric : numeric * 1e3;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const normalized = trimmed.replace(/\//g, "-").replace(" ", "T");
	const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(normalized)) return null;
	const candidate = hasZone ? normalized : `${normalized.length <= 10 ? `${normalized}T00:00:00` : normalized}+08:00`;
	const date = new Date(candidate);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
/** Extract the row array from the (non-official) payload. `null` = shape changed. */
function csdnRowsOf(payload) {
	if (Array.isArray(payload)) return payload.filter(isRecord$5);
	if (isRecord$5(payload)) {
		const vos = payload["result_vos"];
		if (Array.isArray(vos)) return vos.filter(isRecord$5);
	}
	return null;
}
function normalizeLanguage(info) {
	return (info.trim().split(/\s+/)[0] ?? "").replace(/^\{?\.?/, "").replace(/[:}]$/, "").toLowerCase();
}
/**
* Strip the inline markup CSDN puts inside `<pre>`/`<code>`, then decode
* entities. Only *named* tags are removed, so a comparison such as `a < b && c > d`
* is not mistaken for a tag.
*/
function cleanCode(text) {
	return decodeEntities(text.replace(/<\/?(?:code|span|em|strong|b|i|u|a|br|div|p|font|label|mark|sub|sup|ol|ul|li)\b[^>]*>/gi, "")).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
}
function indentedBlocks(text) {
	const groups = [];
	let current = null;
	for (const line of text.split(/\r?\n/)) {
		if (/^(?: {4}|\t)/.test(line)) {
			if (current === null) {
				current = [];
				groups.push(current);
			}
			current.push(line.replace(/^(?: {4}|\t)/, ""));
			continue;
		}
		if (line.trim().length === 0 && current !== null) {
			current.push("");
			continue;
		}
		current = null;
	}
	return groups.filter((group) => group.some((line) => looksLikeCode(line))).map((group) => ({
		code: group.join("\n").trim(),
		language: ""
	}));
}
/**
* 抽代码块：先 ``` 围栏，再 `<pre>` 区块，最后才退到缩进块。
* Returns at most `maxBlocks` non-empty blocks, joined in document order.
*/
function extractCodeBlocks(text, maxBlocks = 3) {
	const empty = {
		code: "",
		language: "",
		blocks: 0
	};
	if (typeof text !== "string" || text.length === 0) return empty;
	const found = [];
	const fence = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
		const info = match[1] ?? "";
		found.push({
			language: normalizeLanguage(info),
			code: cleanCode(match[2] ?? "")
		});
	}
	const pre = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi;
	for (let match = pre.exec(text); match !== null; match = pre.exec(text)) {
		const attributes = match[1] ?? "";
		const inner = match[2] ?? "";
		const declared = /(?:language|lang|brush)[-:=]["']?([\w+#.-]+)/i.exec(attributes) ?? /class=["'][^"']*?(?:language|lang)-([\w+#.-]+)/i.exec(inner);
		found.push({
			language: declared === null ? "" : declared[1]?.toLowerCase() ?? "",
			code: cleanCode(inner)
		});
	}
	if (found.every((block) => block.code.trim().length === 0)) {
		found.length = 0;
		for (const block of indentedBlocks(text)) found.push(block);
	}
	const usable = found.filter((block) => block.code.trim().length > 0).slice(0, Math.max(1, Math.floor(maxBlocks)));
	if (usable.length === 0) return empty;
	const language = usable.find((block) => block.language.length > 0)?.language ?? "";
	return {
		code: usable.map((block) => block.code.trim()).join("\n\n"),
		language,
		blocks: usable.length
	};
}
/**
* Search URL. Only these parameters are sent — the extra filter parameters seen
* in scraping write-ups are deliberately omitted, because this endpoint is not
* documented and an unverified parameter is worse than a missing one (备注②).
*/
function buildCsdnSearchUrl(query, options = {}) {
	const base = (typeof options.apiBase === "string" && options.apiBase.trim().length > 0 ? options.apiBase.trim() : CSDN_SEARCH_BASE).replace(/\/+$/, "");
	const page = typeof options.page === "number" && Number.isFinite(options.page) && options.page >= 1 ? Math.floor(options.page) : 1;
	return `${base}?${new URLSearchParams({
		q: query,
		t: "all",
		p: String(page),
		s: "0",
		platform: "pc"
	}).toString()}`;
}
/**
* Headers for one CSDN search request. CSDN has no API token: its login state is
* a cookie, so a credential handed to this adapter by `ctx.credentials` travels
* in the `cookie` header. The header set is returned rather than sent, so the
* test suite can assert it without a network.
*
* The browser UA + Referer are not decoration: measured 2026-10-04, CSDN's
* anti-bot layer answers HTTP 521 to header-less requests, so every request this
* adapter makes has to look like a browser navigation.
*/
function csdnRequestHeaders(opts) {
	const headers = { ...CSDN_REQUEST_HEADERS };
	if (typeof opts.token === "string" && opts.token.trim().length > 0) headers["cookie"] = opts.token.trim();
	return headers;
}
/**
* Headers for one article-page request: same UA/Referer/cookie story as the
* search call, but asking for HTML rather than JSON.
*/
function csdnArticleHeaders(opts) {
	return {
		...csdnRequestHeaders(opts),
		accept: CSDN_ARTICLE_ACCEPT
	};
}
/**
* How many article pages this call may open.
*
* `maxDepth` is the caller's budget for the same reason it bounds failover: one
* number the user already controls. It is read RAW (never through
* `clampMaxDepth()`, whose missing-value default is 1) because an absent budget
* must mean **zero** extra requests — a search that silently opens pages the
* caller did not ask for would be worse than a missing excerpt.
*/
function articlePageBudget(maxDepth) {
	if (typeof maxDepth !== "number" || !Number.isFinite(maxDepth) || maxDepth <= 0) return 0;
	return Math.min(Math.floor(maxDepth), HARD_LIMITS.maxDepth);
}
/** Reason clauses for a suspicious endpoint shape (备注②) plus the login / robots story. */
function failureNotesFor(failure) {
	if (failure !== "empty" && failure !== "parse-failed" && failure !== "not-code") return [];
	const notes = [CSDN_API_NOTE];
	if (failure === "empty" || failure === "not-code") notes.push(CSDN_LOGIN_REQUIREMENT, CSDN_ROBOTS_DISCLOSURE);
	return notes;
}
/**
* Open ONE article page and extract its code blocks.
*
* Why this exists: the search payload carries a usable `body` for only a
* minority of rows (measured 30 rows / 6 with `body`), so a legitimate hit
* usually has no code until its own page is read. Each call issues exactly one
* request — no crawling, no link following — which is the position
* `CSDN_ROBOTS_DISCLOSURE` states to the user. Failure is a value: the caller
* keeps the row (title + URL) and records the reason, and never fabricates code.
*/
async function fetchCsdnArticleCode(url, opts, timeoutMs, attempts) {
	let res;
	try {
		res = await opts.transport({
			url,
			headers: csdnArticleHeaders(opts),
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			code: "",
			language: "",
			reason: joinReason("文章页抓取失败，未取到代码", classified.reason)
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "CSDN 文章页");
	if (httpFailure !== null) {
		attempts.push({
			url,
			statusCode: res.statusCode,
			failure: httpFailure.failure,
			note: optionalReason(httpFailure.reason, notes.join("；"))
		});
		const blocked = res.statusCode === 521;
		return {
			code: "",
			language: "",
			reason: joinReason(blocked ? CSDN_ARTICLE_BLOCKED_NOTE : `文章页未取到代码（HTTP ${res.statusCode}）`, blocked ? CSDN_LOGIN_REQUIREMENT : void 0, httpFailure.reason, notes.join("；"))
		};
	}
	const extracted = extractCodeBlocks(res.body);
	attempts.push({
		url,
		statusCode: res.statusCode,
		note: optionalReason(notes.join("；"))
	});
	if (extracted.code.trim().length === 0) return {
		code: "",
		language: "",
		reason: joinReason(CSDN_ARTICLE_NO_CODE_NOTE, notes.join("；"))
	};
	return {
		code: extracted.code,
		language: extracted.language,
		reason: joinReason(CSDN_ARTICLE_CODE_NOTE, notes.join("；"))
	};
}
/** One CSDN search. Failures are values; nothing is thrown. */
async function searchCsdn(query, opts) {
	const attempts = [];
	const maxItems = clampMaxItems(opts.maxItems);
	const maxCodeChars = clampMaxCodeChars$1(opts.maxCodeChars);
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const trimmed = typeof query === "string" ? query.trim() : "";
	if (trimmed.length === 0) return {
		ok: false,
		results: [],
		reason: "CSDN 搜索：查询为空，未发起任何请求。",
		failure: "empty",
		attempts
	};
	const url = buildCsdnSearchUrl(trimmed, opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase });
	let res;
	try {
		res = await opts.transport({
			url,
			headers: csdnRequestHeaders(opts),
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			ok: false,
			results: [],
			reason: joinReason("CSDN 搜索失败", classified.reason, ...failureNotesFor(classified.failure)),
			failure: classified.failure,
			attempts
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "CSDN 搜索");
	attempts.push({
		url,
		statusCode: res.statusCode,
		failure: httpFailure?.failure,
		note: joinReason(httpFailure?.reason, notes.join("；"))
	});
	if (httpFailure !== null) return {
		ok: false,
		results: [],
		reason: joinReason("CSDN 搜索失败", httpFailure.reason, ...failureNotesFor(httpFailure.failure)),
		failure: httpFailure.failure,
		attempts
	};
	let payload;
	try {
		payload = JSON.parse(res.body);
	} catch (error) {
		return {
			ok: false,
			results: [],
			reason: joinReason("CSDN 搜索返回值不是合法 JSON", `解析错误：${error instanceof Error ? error.message : String(error)}`, CSDN_API_NOTE, notes.join("；")),
			failure: "parse-failed",
			attempts
		};
	}
	const rows = csdnRowsOf(payload);
	if (rows === null) return {
		ok: false,
		results: [],
		reason: joinReason("CSDN 搜索返回的结构里没有 result_vos[]，接口字段可能已变更", CSDN_API_NOTE, notes.join("；")),
		failure: "parse-failed",
		attempts
	};
	const results = [];
	let skippedNoUrl = 0;
	let skippedNoCode = 0;
	const articleBudget = opts.articleFetch === true ? articlePageBudget(opts.maxDepth) : 0;
	let articleFetches = 0;
	for (const raw of rows) {
		const urlValue = asString$2(raw["url"]);
		if (urlValue === void 0) {
			skippedNoUrl += 1;
			continue;
		}
		const body = asString$2(raw["body"]) ?? "";
		const description = asString$2(raw["description"]) ?? "";
		const extracted = extractCodeBlocks(body.length > 0 ? body : description);
		const title = stripHtml(asString$2(raw["title"]) ?? "").replace(/\s+/g, " ").trim() || "（无标题）";
		let code = extracted.code;
		let language = extracted.language;
		const rowNotes = [];
		let articleAttempted = false;
		if (code.trim().length === 0 && articleBudget > articleFetches) {
			articleFetches += 1;
			articleAttempted = true;
			const article = await fetchCsdnArticleCode(urlValue, opts, timeoutMs, attempts);
			code = article.code;
			language = article.language;
			rowNotes.push(CSDN_ROBOTS_DISCLOSURE);
			rowNotes.push(article.reason);
		}
		if (code.trim().length === 0 && !articleAttempted) {
			skippedNoCode += 1;
			continue;
		}
		const originalType = asString$2(raw["originalType"]);
		const originalTypeUnknown = originalType === void 0;
		const reposted = originalType !== void 0 && originalType !== "原创";
		const bounded = boundExcerpt(code, maxCodeChars);
		if (reposted) rowNotes.push(REPOST_NOTE);
		else if (originalTypeUnknown) rowNotes.push(ORIGINAL_TYPE_UNKNOWN_NOTE);
		const author = asString$2(raw["author"]);
		if (author !== void 0) rowNotes.push(`作者 ${author}`);
		const view = asNumber$2(raw["view"]);
		if (view !== void 0) rowNotes.push(`阅读 ${view}`);
		for (const note of notes) rowNotes.push(note);
		const scored = score({
			source: "csdn",
			authenticated: opts.authenticated === true,
			reposted,
			completeness: completenessFrom(raw, CSDN_RESULT_FIELDS),
			notes: rowNotes
		});
		results.push({
			source: "csdn",
			url: urlValue,
			title,
			language,
			code: bounded.code,
			codeTruncated: bounded.codeTruncated,
			learned_summary: summarize({
				title,
				description,
				body,
				language
			}),
			is_verbatim_copy: false,
			stars: null,
			updatedAt: parseCsdnTime(raw["create_time"]),
			confidence: scored.confidence,
			reason: scored.reason
		});
	}
	if (results.length === 0) {
		const failure = rows.length === 0 ? "empty" : "not-code";
		return {
			ok: false,
			results: [],
			reason: joinReason(rows.length === 0 ? "CSDN 搜索返回 0 条结果" : `CSDN 命中 ${rows.length} 条，但没有任何条目包含可抽取的代码块`, skippedNoUrl > 0 ? `跳过 ${skippedNoUrl} 条缺少 url 的条目` : void 0, skippedNoCode > 0 ? `跳过 ${skippedNoCode} 条无代码块的条目` : void 0, ...failureNotesFor(failure), notes.join("；")),
			failure,
			attempts
		};
	}
	const truncated = results.length > maxItems;
	const kept = results.slice(0, maxItems);
	return {
		ok: true,
		results: kept,
		reason: joinReason(`CSDN 搜索命中 ${rows.length} 条，抽取到 ${results.length} 个条目（其中 ${kept.filter((row) => row.code.length > 0).length} 条带代码摘录）`, articleFetches > 0 ? `已按 articleFetch 打开 ${articleFetches} 篇文章页补齐正文` : void 0, truncated ? `已按 maxItems=${maxItems} 截断` : void 0, notes.join("；")),
		attempts,
		truncated
	};
}
/** CSDN 不支持深度阅读：它只作浅搜索补充（不返回任何文件副本）。 */
async function csdnDeepRead(_url, targets, _opts) {
	return {
		notes: [],
		reason: joinReason(`CSDN 仅作浅搜索补充，不支持深度阅读（请求目标：${targets.length > 0 ? targets.join("、") : "（未指定目标）"}）`, CSDN_API_NOTE),
		failure: "not-code",
		fetchedUrls: [],
		skipped: [...targets]
	};
}
/** Adapter factory. `id` is fixed by the contract. */
function createCsdnAdapter() {
	return {
		id: "csdn",
		search: searchCsdn,
		deepRead: csdnDeepRead
	};
}
//#endregion
//#region src/learn/dedupe.ts
const LEVEL_RANK = {
	high: 3,
	medium: 2,
	low: 1
};
function rankOf(confidence) {
	return LEVEL_RANK[confidence] ?? 0;
}
function collapseSlashes(path) {
	return path.replace(/\/{2,}/g, "/");
}
/**
* Canonical dedupe key for a URL: no query, no fragment, lower case, no default
* port, no `www.` prefix, no trailing slash. Unparseable input degrades to a
* conservative textual normalization instead of throwing.
*/
function normalizeUrl(url) {
	const trimmed = typeof url === "string" ? url.trim() : "";
	if (trimmed.length === 0) return "";
	const withoutFragment = trimmed.split("#")[0] ?? trimmed;
	const withoutQuery = withoutFragment.split("?")[0] ?? withoutFragment;
	let parsed = null;
	try {
		parsed = new URL(withoutQuery);
	} catch {
		parsed = null;
	}
	if (parsed === null) return withoutQuery.replace(/\/+$/, "").toLowerCase();
	parsed.hash = "";
	parsed.search = "";
	const protocol = parsed.protocol.toLowerCase();
	let host = parsed.hostname.toLowerCase();
	if (host.startsWith("www.")) host = host.slice(4);
	const port = protocol === "http:" && parsed.port === "80" || protocol === "https:" && parsed.port === "443" ? "" : parsed.port;
	const path = collapseSlashes(parsed.pathname).replace(/\/+$/, "");
	return `${protocol}//${host}${port.length > 0 ? `:${port}` : ""}${path}`.toLowerCase();
}
/** Alias of `normalizeUrl()`, named for how it is used. */
function urlKey(url) {
	return normalizeUrl(url);
}
const FNV_OFFSET_BASIS = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const UINT64_MASK = 18446744073709551615n;
/** 64-bit FNV-1a, rendered as 16 hex chars. Deterministic, non-cryptographic. */
function fnv1a64(text) {
	let hash = FNV_OFFSET_BASIS;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = hash * FNV_PRIME & UINT64_MASK;
	}
	return hash.toString(16).padStart(16, "0");
}
/** Strip everything that is presentation rather than content. */
function normalizeContent(text) {
	return text.toLowerCase().replace(/```[a-z0-9+#._-]*/g, "").replace(/<[^>]*>/g, "").replace(/[\s\p{P}\p{S}]+/gu, "");
}
/**
* Content fingerprint over the takeaway-bearing fields. The normalized length
* is prefixed so two different payloads cannot collide on the hash alone
* without also agreeing on size.
*/
function contentFingerprint(input) {
	const title = typeof input.title === "string" ? input.title : "";
	const code = typeof input.code === "string" ? input.code : "";
	const normalized = normalizeContent([
		title,
		typeof input.learned_summary === "string" ? input.learned_summary : "",
		code
	].join("\n"));
	if (normalized.length === 0) return "";
	return `${normalized.length}-${fnv1a64(normalized)}`;
}
/**
* Collapse duplicate rows. Order is stable: the surviving row keeps the
* position of the first occurrence of its key.
*/
function dedupeResults(results, opts = {}) {
	const byContent = opts.byContent !== false;
	const prefer = opts.prefer ?? "first";
	const kept = [];
	const urlIndex = /* @__PURE__ */ new Map();
	const contentIndex = /* @__PURE__ */ new Map();
	let droppedByUrl = 0;
	let droppedByContent = 0;
	for (const row of results) {
		const key = urlKey(row.url);
		const fingerprint = byContent ? contentFingerprint(row) : "";
		const urlHit = key.length > 0 ? urlIndex.get(key) : void 0;
		const contentHit = fingerprint.length > 0 ? contentIndex.get(fingerprint) : void 0;
		const hit = urlHit ?? contentHit;
		if (hit === void 0) {
			const index = kept.length;
			kept.push(row);
			if (key.length > 0) urlIndex.set(key, index);
			if (fingerprint.length > 0) contentIndex.set(fingerprint, index);
			continue;
		}
		if (urlHit !== void 0) droppedByUrl += 1;
		else droppedByContent += 1;
		if (prefer === "confidence") {
			const existing = kept[hit];
			if (existing !== void 0 && rankOf(row.confidence) > rankOf(existing.confidence)) {
				kept[hit] = row;
				if (urlHit === void 0 && key.length > 0) urlIndex.set(key, hit);
				if (contentHit === void 0 && fingerprint.length > 0) contentIndex.set(fingerprint, hit);
			}
		}
	}
	return {
		results: kept,
		stats: {
			input: results.length,
			kept: kept.length,
			droppedByUrl,
			droppedByContent
		}
	};
}
/**
* Convenience wrapper for callers that only want the rows: same algorithm as
* `dedupeResults()`, returns the array (stable order, first occurrence wins).
*/
function dedupe(results) {
	return dedupeResults(results).results;
}
const DEEPREAD_MAX_CHARS_PER_FILE = 4e4;
function clampFiles(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 6;
	return Math.min(Math.floor(value), 6);
}
function truncateText(text, limit) {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit);
	const lastBreak = cut.lastIndexOf("\n");
	return lastBreak > limit * .6 ? cut.slice(0, lastBreak) : cut;
}
/** Collapse to a single bounded line; returns null for empty input. */
function sanitizeBullet(text, limit = 200) {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length === 0) return null;
	if (oneLine.length > limit) return `${oneLine.slice(0, limit - 1)}…`;
	return oneLine;
}
function pushBullet(target, value, seen) {
	if (value === null) return;
	const key = value.toLowerCase();
	if (seen.has(key)) return;
	seen.add(key);
	target.push(value);
}
const README_CANDIDATES = [
	"README.md",
	"README.zh-CN.md",
	"README.rst",
	"readme.md",
	"README.txt"
];
const ENTRY_CANDIDATES = [
	"src/index.ts",
	"src/index.js",
	"index.ts",
	"index.js",
	"src/main.ts",
	"src/main.js",
	"main.ts",
	"main.js",
	"main.py",
	"app.py",
	"__init__.py",
	"index.php",
	"cmd/main.go",
	"src/main.rs",
	"src/lib.rs"
];
const MANIFEST_CANDIDATES = [
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"composer.json",
	"setup.py",
	"Gemfile",
	"requirements.txt"
];
const TEST_CANDIDATES = [
	"test/index.js",
	"tests/index.js",
	"test/index.ts",
	"tests/index.ts",
	"test.js",
	"tests/test.js",
	"__tests__/index.js",
	"tests/test_main.py",
	"test_main.py"
];
/** Conventional paths for one deep-read target. */
function candidatePaths(target) {
	switch (target) {
		case "readme": return README_CANDIDATES;
		case "entry": return ENTRY_CANDIDATES;
		case "core": return MANIFEST_CANDIDATES;
		case "tests": return TEST_CANDIDATES;
		default: return [];
	}
}
const SIGNATURE_PATTERNS = [
	/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+[A-Za-z_$][\w$]*/,
	/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/,
	/^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(/,
	/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|type)\s+[A-Za-z_]\w*/,
	/^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?[A-Za-z_][\w<>\[\],.? ]*\s+[A-Za-z_]\w*\s*\(/,
	/^\s*function\s+[A-Za-z_$][\w$]*\s*\(/,
	/^\s*(?:public\s+|private\s+|protected\s+)?function\s+[A-Za-z_]\w*\s*\(/,
	/^\s*(?:module\.exports|exports\.[A-Za-z_$][\w$]*)\s*=/,
	/^\s*type\s+[A-Za-z_]\w*\s*(?:<[^>]*>)?\s*=/
];
/**
* Pull public API *signatures* out of a file. Only the declaration line is
* kept, cut at the first body brace, so no function body can leak.
*/
function signaturesFrom(text, limit = 8) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rawLine of text.split(/\r?\n/)) {
		if (out.length >= limit) break;
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;
		let matched = false;
		for (const pattern of SIGNATURE_PATTERNS) if (pattern.test(line)) {
			matched = true;
			break;
		}
		if (!matched) continue;
		if (line.includes("=>") && line.length > 120) continue;
		const bodyStart = line.indexOf("{");
		const signature = sanitizeBullet((bodyStart >= 0 ? line.slice(0, bodyStart) : line).replace(/[;{]\s*$/, "").trim(), 160);
		if (signature === null) continue;
		if (!/[(\w]/.test(signature)) continue;
		const key = signature.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(signature);
	}
	return out;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function keysOf(value) {
	const record = asRecord(value);
	return record === null ? [] : Object.keys(record);
}
/** Facts read from a manifest that the note can safely assert. */
function manifestFacts(text) {
	const apiContract = [];
	const pitfalls = [];
	const approach = [];
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = void 0;
	}
	const pkg = asRecord(parsed);
	if (pkg !== null && (typeof pkg["name"] === "string" || pkg["dependencies"] !== void 0 || pkg["peerDependencies"] !== void 0)) {
		const peers = keysOf(pkg["peerDependencies"]);
		if (peers.length > 0) apiContract.push(`peerDependencies 要求宿主提供：${peers.join("、")}`);
		const deps = keysOf(pkg["dependencies"]);
		if (deps.length > 0) approach.push(`运行时依赖 ${deps.length} 个（${deps.slice(0, 8).join("、")}）`);
		const devDeps = keysOf(pkg["devDependencies"]);
		if (devDeps.length > 0) approach.push(`开发依赖 ${devDeps.length} 个`);
		const engines = asRecord(pkg["engines"]);
		if (engines !== null) {
			const declared = Object.entries(engines).filter((entry) => typeof entry[1] === "string").map(([key, value]) => `${key} ${value}`);
			if (declared.length > 0) pitfalls.push(`engines 声明 ${declared.join("、")}，运行环境不符时会失败`);
		}
		if (pkg["type"] === "module") pitfalls.push("package.json 声明 \"type\": \"module\"，CommonJS 的 require 不可直接使用");
		const main = pkg["main"];
		if (typeof main === "string" && main.length > 0) apiContract.push(`入口字段 main = ${main}`);
	}
	const python = /requires-python\s*=\s*["']([^"']+)["']/.exec(text);
	if (python !== null) pitfalls.push(`requires-python = ${python[1] ?? ""}，Python 版本不符会安装失败`);
	const edition = /^\s*edition\s*=\s*["']([^"']+)["']/m.exec(text);
	if (edition !== null) pitfalls.push(`Cargo edition = ${edition[1] ?? ""}，工具链过旧会编译失败`);
	const goVersion = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text);
	if (goVersion !== null) pitfalls.push(`go.mod 要求 Go ${goVersion[1] ?? ""} 及以上`);
	return {
		apiContract,
		pitfalls,
		approach
	};
}
/** Build the note. Pure: same sources in, same note out. */
function distillNote(input) {
	const approachParts = [];
	const apiParts = [];
	const tradeoffParts = [];
	const pitfallParts = [];
	const sourceUrls = [];
	const seen = {
		approach: /* @__PURE__ */ new Set(),
		api: /* @__PURE__ */ new Set(),
		tradeoff: /* @__PURE__ */ new Set(),
		pitfall: /* @__PURE__ */ new Set()
	};
	if (input.url.length > 0) sourceUrls.push(input.url);
	for (const source of input.sources) {
		if (!sourceUrls.includes(source.url)) sourceUrls.push(source.url);
		const sections = extractSections(source.text);
		for (const item of sections.approach) pushBullet(approachParts, sanitizeBullet(item), seen.approach);
		for (const item of sections.apiContract) pushBullet(apiParts, sanitizeBullet(item), seen.api);
		for (const item of sections.tradeoffs) pushBullet(tradeoffParts, sanitizeBullet(item), seen.tradeoff);
		for (const item of sections.pitfalls) pushBullet(pitfallParts, sanitizeBullet(item), seen.pitfall);
		if (source.target === "entry" || source.target === "core") {
			for (const signature of signaturesFrom(source.text)) pushBullet(apiParts, sanitizeBullet(`${source.label !== void 0 && source.label.length > 0 ? `${source.label}: ` : ""}${signature}`, 200), seen.api);
			const facts = manifestFacts(source.text);
			for (const item of facts.apiContract) pushBullet(apiParts, sanitizeBullet(item), seen.api);
			for (const item of facts.pitfalls) pushBullet(pitfallParts, sanitizeBullet(item), seen.pitfall);
			for (const item of facts.approach) pushBullet(approachParts, sanitizeBullet(item), seen.approach);
		}
	}
	const coverage = [...new Set(input.sources.map((source) => source.target))].join("/");
	const lead = `共读取 ${input.sources.length} 个文件（覆盖 ${coverage.length > 0 ? coverage : "无"}）。`;
	const approach = sanitizeBullet(`${lead} ${approachParts.slice(0, 4).join(" ")}`, 1200) ?? lead;
	return {
		url: input.url,
		title: input.title,
		approach,
		apiContract: apiParts.slice(0, 8),
		tradeoffs: tradeoffParts.slice(0, 5),
		pitfalls: pitfallParts.slice(0, 5),
		sourceUrls
	};
}
/**
* Round-robin the candidate list by target so one long conventional list
* (test files, say) cannot starve the other requested targets.
*/
function interleaveCandidates(candidates) {
	const byTarget = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const list = byTarget.get(candidate.target);
		if (list === void 0) byTarget.set(candidate.target, [candidate]);
		else list.push(candidate);
	}
	const out = [];
	let index = 0;
	for (;;) {
		let added = false;
		for (const list of byTarget.values()) if (index < list.length) {
			out.push(list[index]);
			added = true;
		}
		if (!added) break;
		index += 1;
	}
	return out;
}
/** Read the candidate files, then distill. Never returns a file copy. */
async function deepReadFiles(run) {
	const maxFiles = clampFiles(run.maxFiles);
	const maxChars = typeof run.maxCharsPerFile === "number" && Number.isFinite(run.maxCharsPerFile) && run.maxCharsPerFile > 0 ? Math.floor(run.maxCharsPerFile) : DEEPREAD_MAX_CHARS_PER_FILE;
	const attempts = [];
	const sources = [];
	const fetchedUrls = [];
	const seenKeys = /* @__PURE__ */ new Set();
	const failureNotes = [];
	const ordered = interleaveCandidates(run.candidates);
	let firstFailure;
	let retryableHit = false;
	let capped = false;
	for (const candidate of ordered) {
		if (sources.length >= maxFiles) break;
		if (attempts.length >= 12) {
			capped = true;
			break;
		}
		const key = urlKey(candidate.url);
		const identity = key.length > 0 ? key : candidate.url;
		if (seenKeys.has(identity)) continue;
		seenKeys.add(identity);
		let result;
		try {
			result = await run.fetchFile(candidate.url);
		} catch (error) {
			const classified = classifyTransportError(error);
			result = {
				ok: false,
				url: candidate.url,
				failure: classified.failure,
				reason: classified.reason
			};
		}
		if (!result.ok) {
			attempts.push({
				url: result.url,
				statusCode: null,
				failure: result.failure,
				note: result.reason
			});
			if (firstFailure === void 0) firstFailure = result.failure;
			if (isRetryableFailure(result.failure)) retryableHit = true;
			failureNotes.push(`${result.url}：${result.reason}`);
			continue;
		}
		sources.push({
			url: result.url,
			target: candidate.target,
			text: truncateText(result.text, maxChars),
			label: candidate.label
		});
		fetchedUrls.push(result.url);
		attempts.push({
			url: result.url,
			statusCode: 200
		});
	}
	if (sources.length === 0) {
		const failure = firstFailure ?? "empty";
		return {
			notes: [],
			reason: joinReason(`深度阅读未能读取到任何文件（尝试 ${attempts.length} 个候选${capped ? `，已达上限 12` : ""}）`, failureNotes.slice(0, 3).join("；"), retryableHit ? "部分候选是可重试失败，交给降级链处理" : void 0),
			failure,
			fetchedUrls: [],
			skipped: [...run.requested],
			attempts
		};
	}
	const covered = new Set(sources.map((source) => source.target));
	const skipped = run.requested.filter((target) => !covered.has(target));
	return {
		notes: [distillNote({
			url: run.url,
			title: run.title,
			sources
		})],
		reason: joinReason(`深度阅读完成：读取 ${sources.length} 个文件（${[...covered].join("/")}），产出 1 条思路笔记`, skipped.length > 0 ? `未覆盖目标：${skipped.join("、")}` : void 0, capped ? `候选请求已达上限 12，其余候选未尝试` : void 0, failureNotes.length > 0 ? `部分候选读取失败：${failureNotes.slice(0, 2).join("；")}` : void 0),
		fetchedUrls,
		skipped,
		attempts
	};
}
//#endregion
//#region src/sources/gitee.ts
/**
* dsh-codehub — Gitee 源适配器.
*
* Endpoint — and ONLY this one, from `contract.ts`:
*
*   `GITEE_SEARCH_REPOSITORIES`  `/search/repositories?q=&per_page=`
*
* There is NO code-search endpoint to pair with it. Measured 2026-10-04:
* `GET https://gitee.com/api/v5/search/code?q=vue` answers **HTTP 404 with an
* HTML page-not-found body**, so it is not a v5 endpoint at all and this module
* must never build a request for it (see `GITEE_CODE_SEARCH_SUPPORTED`). Gitee's
* *web* code search (search.gitee.com) renders client-side and needs a
* logged-in session, so it is not reachable as an API either.
*
* `https://gitee.com/api/v5/projects?q=...` was probed live and returned **404**
* as well. It does not exist, is not referenced anywhere in this file, and must
* never be implemented.
*
* Live facts this adapter is built around:
*   • anonymous `/search/repositories?q=vue` → HTTP 200 with an empty array, so
*     an anonymous empty answer is reported as `empty` — never padded with
*     invented rows;
*   • when the JSON surface yields nothing, the adapter may fall back to the
*     search HTML page (`opts.htmlFallback === true`), and those rows are
*     explicitly labelled as an HTML fallback with a lower confidence.
*
* Auth: a personal access token, delivered either as an `Authorization: Bearer`
* header (default — keeps the credential out of URLs, which the project bans
* from logs) or as the documented `access_token` query parameter when the caller
* asks for it. The token comes from `ctx.credentials` via `opts.token`; this
* module never reads an environment variable.
*
* 备注①：all egress goes through `opts.transport`, and transport notes are copied
* into `reason` verbatim.
*
* 登录要求：every failure/no-result `reason` quotes `GITEE_LOGIN_REQUIREMENT`
* rather than re-spelling the three measured facts, so the adapter, the panel,
* the README and the tests can never disagree.
*/
/** Repo fields this adapter reads. Gitee v5 uses the same names as GitHub here. */
const GITEE_REPO_FIELDS = [
	"full_name",
	"html_url",
	"description",
	"language",
	"stargazers_count",
	"updated_at",
	"default_branch"
];
/** Gitee API headers. */
const GITEE_API_HEADERS = {
	accept: "application/json",
	"user-agent": "dsh-codehub"
};
/** Same-origin raw file base for public content. */
const GITEE_RAW_BASE = "https://gitee.com";
/** HTML search page used only by the explicit fallback path. */
const GITEE_WEB_SEARCH_BASE = "https://search.gitee.com/";
/** Gitee 搜索网页兜底文案（含来源标注）。 */
const GITEE_HTML_FALLBACK_NOTE = "HTML 网页兜底（未走官方 API），字段不完整、置信度较低";
function isRecord$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function asNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeBase$1(base) {
	return (typeof base === "string" && base.trim().length > 0 ? base.trim() : GITEE_API_BASE).replace(/\/+$/, "");
}
/**
* Build a Gitee v5 URL. `endpointPath` is a path this module owns — a contract
* constant (`GITEE_SEARCH_REPOSITORIES`) or a repository metadata path built
* from parsed owner/repo. This is not a general URL builder, and no caller may
* pass a code-search path: that endpoint does not exist.
*/
function buildGiteeApiUrl(endpointPath, options = {}) {
	const path = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
	const search = new URLSearchParams();
	if (options.params !== void 0) for (const [key, value] of Object.entries(options.params)) search.set(key, String(value));
	if (options.tokenInQuery === true && typeof options.token === "string" && options.token.length > 0) search.set("access_token", options.token);
	const query = search.toString();
	const base = normalizeBase$1(options.apiBase);
	return query.length > 0 ? `${base}${path}?${query}` : `${base}${path}`;
}
/** Headers for one Gitee API call. Bearer by default; never logs the token. */
function giteeHeaders(opts) {
	const headers = { ...GITEE_API_HEADERS };
	const token = tokenForAccess(opts.access, opts.token);
	if (token !== void 0) headers["authorization"] = `Bearer ${token}`;
	return headers;
}
/** Accept a bare array or an `items[]` container; `null` means the shape changed. */
function giteeRowsOf(payload) {
	if (Array.isArray(payload)) return payload.filter(isRecord$4);
	if (isRecord$4(payload)) {
		const items = payload["items"];
		if (Array.isArray(items)) return items.filter(isRecord$4);
	}
	return null;
}
/** Map one Gitee repository row. Returns null when it carries no openable URL. */
function mapGiteeRepo(item, context) {
	const url = asString$1(item["html_url"]);
	if (url === void 0) return null;
	const fullName = asString$1(item["full_name"]) ?? url;
	const description = asString$1(item["description"]) ?? "";
	const language = asString$1(item["language"]) ?? "";
	const scored = score({
		source: "gitee",
		authenticated: context.authenticated,
		reposted: false,
		completeness: completenessFrom(item, GITEE_REPO_FIELDS),
		notes: context.notes
	});
	return {
		source: "gitee",
		url,
		title: fullName,
		language,
		code: "",
		codeTruncated: false,
		learned_summary: summarize({
			title: fullName,
			description,
			language
		}),
		is_verbatim_copy: false,
		stars: asNumber$1(item["stargazers_count"]) ?? null,
		updatedAt: asString$1(item["updated_at"]) ?? null,
		confidence: scored.confidence,
		reason: joinReason("Gitee 仓库搜索结果", scored.reason)
	};
}
/** `GET /search/repositories`. An anonymous empty answer stays `empty`. */
async function searchGiteeRepositories(query, opts) {
	const attempts = [];
	const maxItems = clampMaxItems(opts.maxItems);
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const token = tokenForAccess(opts.access, opts.token);
	const trimmed = typeof query === "string" ? query.trim() : "";
	if (trimmed.length === 0) return {
		ok: false,
		results: [],
		reason: "Gitee 仓库搜索：查询为空，未发起任何请求。",
		failure: "empty",
		attempts
	};
	const url = buildGiteeApiUrl(GITEE_SEARCH_REPOSITORIES, {
		...opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase },
		params: {
			q: trimmed,
			per_page: maxItems
		}
	});
	let res;
	try {
		res = await opts.transport({
			url,
			headers: giteeHeaders(opts),
			...token === void 0 ? {} : { token },
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			ok: false,
			results: [],
			reason: classified.reason,
			failure: classified.failure,
			attempts
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "Gitee 仓库搜索");
	attempts.push({
		url,
		statusCode: res.statusCode,
		failure: httpFailure?.failure,
		note: optionalReason(httpFailure?.reason, notes.join("；"))
	});
	if (httpFailure !== null) return {
		ok: false,
		results: [],
		reason: httpFailure.reason,
		failure: httpFailure.failure,
		attempts
	};
	let payload;
	try {
		payload = JSON.parse(res.body);
	} catch (error) {
		return {
			ok: false,
			results: [],
			reason: joinReason("Gitee 仓库搜索返回值不是合法 JSON", `解析错误：${error instanceof Error ? error.message : String(error)}`, notes.join("；")),
			failure: "parse-failed",
			attempts
		};
	}
	const items = giteeRowsOf(payload);
	if (items === null) return {
		ok: false,
		results: [],
		reason: joinReason("Gitee 仓库搜索返回结构既不是数组也没有 items[]", notes.join("；")),
		failure: "parse-failed",
		attempts
	};
	const rows = [];
	let skipped = 0;
	for (const item of items) {
		const row = mapGiteeRepo(item, {
			authenticated: token !== void 0 || opts.authenticated === true,
			notes
		});
		if (row === null) {
			skipped += 1;
			continue;
		}
		rows.push(row);
	}
	if (rows.length === 0) return {
		ok: false,
		results: [],
		reason: joinReason(items.length === 0 ? "Gitee 仓库搜索返回 0 条结果" : `Gitee 仓库搜索命中 ${items.length} 条，但没有一条带得 html_url`, GITEE_LOGIN_REQUIREMENT, skipped > 0 ? `跳过 ${skipped} 条不可用条目` : void 0, notes.join("；")),
		failure: "empty",
		attempts
	};
	const truncated = rows.length > maxItems;
	return {
		ok: true,
		results: rows.slice(0, maxItems),
		reason: joinReason(`Gitee 仓库搜索命中 ${rows.length} 条${token !== void 0 ? "（已登录）" : "（匿名）"}`, truncated ? `已按 maxItems=${maxItems} 截断` : void 0, notes.join("；")),
		attempts,
		truncated
	};
}
const RESERVED_OWNERS = /* @__PURE__ */ new Set([
	"explore",
	"login",
	"search",
	"help",
	"enterprise",
	"oschina",
	"gitee",
	"about",
	"users",
	"organizations",
	"assets",
	"api",
	"oauth",
	"terms",
	"features",
	"pricing",
	"education",
	"ai",
	"notifications",
	"dashboard",
	"settings",
	"signup",
	"session",
	"static"
]);
/** Scrape `/{owner}/{repo}` anchors out of the search page. Heuristic by nature. */
function parseGiteeSearchHtml(html, limit = 10) {
	const hits = [];
	const seen = /* @__PURE__ */ new Set();
	const anchor = /href=["'](?:https?:\/\/(?:www\.)?gitee\.com)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
	for (let match = anchor.exec(html); match !== null; match = anchor.exec(html)) {
		if (hits.length >= limit) break;
		const owner = match[1];
		const repo = match[2];
		if (owner === void 0 || repo === void 0) continue;
		if (RESERVED_OWNERS.has(owner.toLowerCase())) continue;
		if (RESERVED_OWNERS.has(repo.toLowerCase())) continue;
		const url = `${GITEE_RAW_BASE}/${owner}/${repo}`;
		if (seen.has(url.toLowerCase())) continue;
		seen.add(url.toLowerCase());
		const title = stripHtml(match[3] ?? "").replace(/\s+/g, " ").trim();
		hits.push({
			url,
			title: title.length > 0 ? title : `${owner}/${repo}`
		});
	}
	return hits;
}
/** Fetch the search page and turn its repo links into low-confidence rows. */
async function searchGiteeHtml(query, opts) {
	const attempts = [];
	const maxItems = clampMaxItems(opts.maxItems);
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const url = `${GITEE_WEB_SEARCH_BASE}?${new URLSearchParams({
		q: query,
		type: "repository"
	}).toString()}`;
	let res;
	try {
		res = await opts.transport({
			url,
			headers: {
				accept: "text/html,application/xhtml+xml",
				"user-agent": "dsh-codehub"
			},
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			ok: false,
			results: [],
			reason: joinReason("Gitee 网页兜底失败", classified.reason),
			failure: classified.failure,
			attempts
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "Gitee 搜索网页");
	attempts.push({
		url,
		statusCode: res.statusCode,
		failure: httpFailure?.failure,
		note: optionalReason(httpFailure?.reason, notes.join("；"))
	});
	if (httpFailure !== null) return {
		ok: false,
		results: [],
		reason: joinReason("Gitee 网页兜底失败", httpFailure.reason, notes.join("；")),
		failure: httpFailure.failure,
		attempts
	};
	const hits = parseGiteeSearchHtml(res.body, maxItems);
	if (hits.length === 0) return {
		ok: false,
		results: [],
		reason: joinReason("Gitee 网页兜底未解析出仓库链接：实测 search.gitee.com 返回的是 SPA 外壳（结果由前端渲染，服务端 HTML 里没有链接），网页版代码搜索需要登录", GITEE_LOGIN_REQUIREMENT, notes.join("；")),
		failure: "empty",
		attempts
	};
	const rows = hits.map((hit) => {
		const scored = score({
			source: "gitee",
			authenticated: opts.authenticated === true,
			reposted: false,
			completeness: .35,
			notes: [GITEE_HTML_FALLBACK_NOTE, ...notes]
		});
		return {
			source: "gitee",
			url: hit.url,
			title: hit.title,
			language: "",
			code: "",
			codeTruncated: false,
			learned_summary: summarize({ title: hit.title }),
			is_verbatim_copy: false,
			stars: null,
			updatedAt: null,
			confidence: scored.confidence,
			reason: scored.reason
		};
	});
	return {
		ok: true,
		results: rows.slice(0, maxItems),
		reason: joinReason(`Gitee 网页兜底解析出 ${rows.length} 条仓库链接`, GITEE_HTML_FALLBACK_NOTE, notes.join("；")),
		attempts,
		truncated: rows.length > maxItems
	};
}
/** `search()` behind the adapter. */
async function searchGitee(query, opts) {
	const maxItems = clampMaxItems(opts.maxItems);
	const repo = await searchGiteeRepositories(query, opts);
	const merged = dedupe(repo.results).slice(0, maxItems);
	if (merged.length > 0) return {
		ok: true,
		results: merged,
		reason: joinReason(repo.reason, GITEE_LOGIN_REQUIREMENT),
		attempts: [...repo.attempts ?? []],
		truncated: repo.results.length > maxItems
	};
	if (opts.htmlFallback === true) {
		const html = await searchGiteeHtml(query, opts);
		return {
			ok: html.results.length > 0,
			results: html.results,
			reason: joinReason("Gitee API 未取得结果，已按配置回退到网页兜底", repo.reason, html.reason),
			failure: html.results.length > 0 ? void 0 : html.failure ?? repo.failure ?? "empty",
			attempts: [...repo.attempts ?? [], ...html.attempts ?? []],
			truncated: html.truncated
		};
	}
	return {
		ok: false,
		results: [],
		reason: joinReason("Gitee 未取得结果（可开启 htmlFallback 回退到网页搜索）", GITEE_LOGIN_REQUIREMENT, repo.reason),
		failure: repo.failure ?? "empty",
		attempts: [...repo.attempts ?? []]
	};
}
/** Split `owner/repo` out of a Gitee URL. */
function parseGiteeRepo(url) {
	const match = /^https?:\/\/(?:www\.)?gitee\.com\/([^/\s#?]+)\/([^/\s#?]+)/i.exec(url.trim());
	if (match === null) return null;
	const owner = match[1];
	const rawRepo = match[2];
	if (owner === void 0 || rawRepo === void 0) return null;
	const repo = rawRepo.replace(/\.git$/, "");
	if (owner.length === 0 || repo.length === 0) return null;
	return {
		owner,
		repo
	};
}
/** Gitee raw file URL: same origin, `/raw/{branch}/{path}`. */
function buildGiteeRawUrl(fullName, branch, path) {
	return `${GITEE_RAW_BASE}/${fullName}/raw/${branch}/${path.replace(/^\/+/, "")}`;
}
/**
* Deep read for Gitee. Gitee has no cheap recursive tree listing in this
* adapter, so discovery is conventional: README / entry candidates by name,
* manifests for `core`, common test paths for `tests` — and whatever was not
* found is reported in `skipped` instead of being invented.
*
* Raw reads are public-content only: the token is never put in a URL (see the
* module header), so private repositories answer `auth-required` from Gitee.
*/
async function deepReadGitee(url, targets, opts) {
	const attempts = [];
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const parsed = parseGiteeRepo(url);
	const requested = targets.length > 0 ? [...targets] : ["readme"];
	if (parsed === null) return {
		notes: [],
		reason: `无法从 URL 解析出 owner/repo：${url}`,
		failure: "parse-failed",
		fetchedUrls: [],
		skipped: requested,
		attempts
	};
	const fullName = `${parsed.owner}/${parsed.repo}`;
	const token = tokenForAccess(opts.access, opts.token);
	let branch = "master";
	const metaUrl = buildGiteeApiUrl(`/repos/${parsed.owner}/${parsed.repo}`, { ...opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase } });
	try {
		const meta = await opts.transport({
			url: metaUrl,
			headers: giteeHeaders(opts),
			...token === void 0 ? {} : { token },
			timeoutMs,
			signal: opts.signal
		});
		const metaFailure = failureFromResponse(meta, "Gitee 仓库元数据");
		if (metaFailure === null) {
			const payload = JSON.parse(meta.body);
			const declared = isRecord$4(payload) ? asString$1(payload["default_branch"]) : void 0;
			if (declared !== void 0) branch = declared;
		}
		attempts.push({
			url: metaUrl,
			statusCode: meta.statusCode,
			failure: metaFailure?.failure,
			note: optionalReason(metaFailure?.reason, transportNotes(meta).join("；"))
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url: metaUrl,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
	}
	const candidates = [];
	for (const target of requested) for (const path of candidatePaths(target)) {
		const raw = buildGiteeRawUrl(fullName, branch, path);
		if (candidates.some((candidate) => candidate.url === raw)) continue;
		candidates.push({
			url: raw,
			target,
			label: path
		});
	}
	const fetchFile = async (candidateUrl) => {
		try {
			const res = await opts.transport({
				url: candidateUrl,
				headers: {
					accept: "text/plain, */*",
					"user-agent": "dsh-codehub"
				},
				timeoutMs,
				signal: opts.signal
			});
			const httpFailure = failureFromResponse(res, "Gitee raw 文件");
			const notes = transportNotes(res);
			if (httpFailure === null) return {
				ok: true,
				url: res.finalUrl.length > 0 ? res.finalUrl : candidateUrl,
				text: res.body
			};
			attempts.push({
				url: candidateUrl,
				statusCode: res.statusCode,
				failure: httpFailure.failure,
				note: httpFailure.reason
			});
			return {
				ok: false,
				url: candidateUrl,
				failure: httpFailure.failure,
				reason: joinReason(httpFailure.reason, notes.join("；"))
			};
		} catch (error) {
			const classified = classifyTransportError(error);
			attempts.push({
				url: candidateUrl,
				statusCode: null,
				failure: classified.failure,
				note: classified.reason
			});
			return {
				ok: false,
				url: candidateUrl,
				failure: classified.failure,
				reason: classified.reason
			};
		}
	};
	const outcome = await deepReadFiles({
		url,
		title: fullName,
		requested,
		candidates,
		fetchFile,
		maxFiles: 5
	});
	return {
		...outcome,
		attempts: [...attempts, ...outcome.attempts ?? []]
	};
}
/** Adapter factory. */
function createGiteeAdapter() {
	return {
		id: "gitee",
		search: searchGitee,
		deepRead: deepReadGitee
	};
}
/** Fields this adapter reads from a repository search row. Nothing else. */
const GITHUB_REPO_FIELDS = [
	"full_name",
	"html_url",
	"description",
	"language",
	"stargazers_count",
	"updated_at",
	"default_branch"
];
/** Fields read from a code-search row. */
const GITHUB_CODE_FIELDS = [
	"name",
	"path",
	"html_url",
	"repository",
	"text_matches"
];
/** Headers GitHub documents for its REST API. */
const GITHUB_API_HEADERS = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "dsh-codehub"
};
/** Header that makes `/search/code` include `text_matches[].fragment`. */
const GITHUB_TEXT_MATCH_HEADERS = {
	...GITHUB_API_HEADERS,
	accept: "application/vnd.github.text-match+json"
};
/** Raw downloads go through mirrors and never carry a credential. */
const GITHUB_RAW_HEADERS = {
	accept: "text/plain, */*",
	"user-agent": "dsh-codehub"
};
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Index a regex group as `string | undefined` regardless of TS index typing. */
function group(match, index) {
	const value = match[index];
	return value === void 0 || value.length === 0 ? void 0 : value;
}
/**
* Read a JSON array field without guessing the container shape: only the exact
* key is looked at, and anything that is not an array yields null.
*/
function arrayField(container, key) {
	const raw = isRecord$3(container) ? container[key] : void 0;
	return Array.isArray(raw) ? raw : null;
}
/** Strip trailing slashes from a base without touching its interior. */
function normalizeBase(base, fallback) {
	return (typeof base === "string" && base.trim().length > 0 ? base.trim() : fallback).replace(/\/+$/, "");
}
/** Build an API URL from a configurable base plus a real endpoint path. */
function buildGithubApiUrl(endpointPath, options = {}) {
	const base = normalizeBase(options.apiBase, GITHUB_API_BASE);
	const path = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
	const search = new URLSearchParams();
	if (options.params !== void 0) for (const [key, value] of Object.entries(options.params)) search.set(key, String(value));
	const query = search.toString();
	return query.length > 0 ? `${base}${path}?${query}` : `${base}${path}`;
}
/**
* Map a repo-relative path onto a raw base.
*
* Three shapes are accepted, all verified or user-configured:
*   `https://ghproxy.net`                                  → `<base>/https://raw.githubusercontent.com/<path>`
*   `https://ghproxy.net/https://raw.githubusercontent.com`→ `<base>/<path>`
*   `https://cdn.example/{url}`                            → template substitution
*/
function buildGithubRawUrl(base, repoPath) {
	const path = repoPath.replace(/^\/+/, "");
	const canonical = `${GITHUB_RAW_ORIGIN}/${path}`;
	const trimmed = base.trim().replace(/\/+$/, "");
	if (trimmed.includes("{url}")) return trimmed.split("{url}").join(canonical);
	if (trimmed.includes("https://raw.githubusercontent.com")) return `${trimmed}/${path}`;
	return `${trimmed}/${canonical}`;
}
/**
* Raw bases to try, in order.
*
* Decision #7 of the design is explicit: `rawMirrorBases` defaults to `[]` and
* an empty list means "raw download is unavailable — do not improvise"
* (`docs/DESIGN.md` §2, `config.ts`). So an empty list yields NO base and a
* failure that names the missing setting, instead of guessing a mirror.
*
* The two exceptions are the access strategies whose whole purpose is to make
* the canonical origin reachable from this machine (`local-proxy`, `watt`,
* `hosts`): for those the origin itself is tried, because that is not a
* fallback but the path the user just enabled. `direct` / `token` deliberately
* do NOT qualify — the live probe found `raw.githubusercontent.com`
* unreachable exactly there, which is why the failure reason says to add a
* mirror.
*/
function rawBasesFor(opts) {
	const configuredRaw = opts.rawMirrors;
	const configured = configuredRaw === void 0 ? [] : configuredRaw.filter((base) => typeof base === "string" && base.trim().length > 0);
	if (configured.length > 0) return {
		bases: configured.map((base) => base.trim()),
		reason: `使用 ${configured.length} 个已配置的 raw 镜像基址`
	};
	const access = opts.access;
	if (access === "local-proxy" || access === "watt" || access === "hosts") return {
		bases: [GITHUB_RAW_ORIGIN],
		reason: `访问方式「${access}」已让本机可直连 GitHub，直接读取 ${GITHUB_RAW_ORIGIN}（失败时请在 raw 镜像列表里补一个基址）`
	};
	return {
		bases: [],
		reason: joinReason("未配置任何 raw 镜像基址（rawMirrorBases 为空）", `本机实测 ${GITHUB_RAW_ORIGIN} 不可直连，设计约定「空列表 = 该方式不可用，不兜底」`, "请在设置 → GitHub → raw 文件镜像里填入基址（例如 https://ghproxy.net/https://raw.githubusercontent.com）后重试")
	};
}
/** Map one repository row onto the unified envelope. Returns null when unusable. */
function mapGithubRepo(item, context) {
	const url = asString(item["html_url"]);
	if (url === void 0) return null;
	const fullName = asString(item["full_name"]) ?? url;
	const description = asString(item["description"]) ?? "";
	const language = asString(item["language"]) ?? "";
	const scored = score({
		source: "github",
		authenticated: context.authenticated,
		reposted: false,
		completeness: completenessFrom(item, GITHUB_REPO_FIELDS),
		notes: context.notes
	});
	return {
		source: "github",
		url,
		title: fullName,
		language,
		code: "",
		codeTruncated: false,
		learned_summary: summarize({
			title: fullName,
			description,
			language
		}),
		is_verbatim_copy: false,
		stars: asNumber(item["stargazers_count"]) ?? null,
		updatedAt: asString(item["updated_at"]) ?? null,
		confidence: scored.confidence,
		reason: joinReason("GitHub 仓库搜索结果", scored.reason)
	};
}
/** `GET /search/repositories`. */
async function searchGithubRepos(query, opts) {
	const attempts = [];
	const maxItems = clampMaxItems(opts.maxItems);
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const trimmed = typeof query === "string" ? query.trim() : "";
	const token = tokenForAccess(opts.access, opts.token);
	if (trimmed.length === 0) return {
		ok: false,
		results: [],
		reason: "GitHub 仓库搜索：查询为空，未发起任何请求。",
		failure: "empty",
		attempts
	};
	const url = buildGithubApiUrl("/search/repositories", {
		...opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase },
		params: {
			q: trimmed,
			per_page: maxItems
		}
	});
	let res;
	try {
		res = await opts.transport({
			url,
			headers: { ...GITHUB_API_HEADERS },
			...token === void 0 ? {} : { token },
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			ok: false,
			results: [],
			reason: classified.reason,
			failure: classified.failure,
			attempts
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "GitHub 仓库搜索");
	attempts.push({
		url,
		statusCode: res.statusCode,
		failure: httpFailure?.failure,
		note: optionalReason(httpFailure?.reason, notes.join("；"))
	});
	if (httpFailure !== null) return {
		ok: false,
		results: [],
		reason: httpFailure.reason,
		failure: httpFailure.failure,
		attempts
	};
	let payload;
	try {
		payload = JSON.parse(res.body);
	} catch (error) {
		return {
			ok: false,
			results: [],
			reason: joinReason("GitHub 仓库搜索返回值不是合法 JSON", `解析错误：${error instanceof Error ? error.message : String(error)}`, notes.join("；")),
			failure: "parse-failed",
			attempts
		};
	}
	const items = arrayField(payload, "items");
	if (items === null) return {
		ok: false,
		results: [],
		reason: joinReason("GitHub 仓库搜索返回结构里没有 items[]", notes.join("；")),
		failure: "parse-failed",
		attempts
	};
	const rows = [];
	let skipped = 0;
	for (const item of items) {
		if (!isRecord$3(item)) {
			skipped += 1;
			continue;
		}
		const row = mapGithubRepo(item, {
			authenticated: token !== void 0 || opts.authenticated === true,
			notes
		});
		if (row === null) {
			skipped += 1;
			continue;
		}
		rows.push(row);
	}
	if (rows.length === 0) return {
		ok: false,
		results: [],
		reason: joinReason(items.length === 0 ? "GitHub 仓库搜索返回 0 条结果" : `GitHub 仓库搜索命中 ${items.length} 条，但没有一条带得 html_url`, skipped > 0 ? `跳过 ${skipped} 条不可用条目` : void 0, notes.join("；")),
		failure: "empty",
		attempts
	};
	const truncated = rows.length > maxItems;
	return {
		ok: true,
		results: rows.slice(0, maxItems),
		reason: joinReason(`GitHub 仓库搜索命中 ${rows.length} 条${token !== void 0 ? "（已登录）" : "（匿名）"}`, truncated ? `已按 maxItems=${maxItems} 截断` : void 0, notes.join("；")),
		attempts,
		truncated
	};
}
/** Map one code-search row, using `text_matches[].fragment` for the excerpt. */
function mapGithubCode(item, context) {
	const url = asString(item["html_url"]);
	if (url === void 0) return null;
	const path = asString(item["path"]) ?? asString(item["name"]) ?? url;
	const repositoryRaw = item["repository"];
	const repository = isRecord$3(repositoryRaw) ? repositoryRaw : null;
	const fullName = repository === null ? void 0 : asString(repository["full_name"]);
	const title = fullName === void 0 ? path : `${fullName}/${path}`;
	const fragments = [];
	const textMatches = item["text_matches"];
	if (Array.isArray(textMatches)) for (const match of textMatches) {
		if (!isRecord$3(match)) continue;
		const fragment = asString(match["fragment"]);
		if (fragment !== void 0) fragments.push(fragment);
	}
	const bounded = boundExcerpt(fragments.join("\n\n"), context.maxCodeChars);
	const scored = score({
		source: "github",
		authenticated: context.authenticated,
		reposted: false,
		completeness: completenessFrom(item, GITHUB_CODE_FIELDS),
		notes: context.notes
	});
	return {
		source: "github",
		url,
		title,
		language: "",
		code: bounded.code,
		codeTruncated: bounded.codeTruncated,
		learned_summary: summarize({
			title,
			body: fragments.join("\n\n")
		}),
		is_verbatim_copy: false,
		stars: null,
		updatedAt: null,
		confidence: scored.confidence,
		reason: joinReason("GitHub 代码搜索命中", scored.reason)
	};
}
/**
* `GET /search/code`. Without a token this answers `auth-required` and issues
* **zero** requests, because the endpoint rejects anonymous callers.
*
* The evidence — measured 2026-10-04: anonymous `GET
* api.github.com/search/code?q=vue` → HTTP 401 `Requires authentication` — is
* quoted from `GITHUB_LOGIN_REQUIREMENT` instead of being re-typed here, so the
* tool reason, the connectivity panel and the README cannot drift apart.
*/
async function searchGithubCode(query, opts) {
	const attempts = [];
	const maxItems = clampMaxItems(opts.maxItems);
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const trimmed = typeof query === "string" ? query.trim() : "";
	const token = tokenForAccess(opts.access, opts.token);
	if (trimmed.length === 0) return {
		ok: false,
		results: [],
		reason: "GitHub 代码搜索：查询为空，未发起任何请求。",
		failure: "empty",
		attempts
	};
	if (token === void 0) return {
		ok: false,
		results: [],
		reason: joinReason("GitHub 代码搜索需要 token（/search/code 不接受匿名调用）；未发起任何请求。", GITHUB_LOGIN_REQUIREMENT),
		failure: "auth-required",
		attempts
	};
	const url = buildGithubApiUrl("/search/code", {
		...opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase },
		params: {
			q: trimmed,
			per_page: maxItems
		}
	});
	let res;
	try {
		res = await opts.transport({
			url,
			headers: { ...GITHUB_TEXT_MATCH_HEADERS },
			token,
			timeoutMs,
			signal: opts.signal
		});
	} catch (error) {
		const classified = classifyTransportError(error);
		attempts.push({
			url,
			statusCode: null,
			failure: classified.failure,
			note: classified.reason
		});
		return {
			ok: false,
			results: [],
			reason: classified.reason,
			failure: classified.failure,
			attempts
		};
	}
	const notes = transportNotes(res);
	const httpFailure = failureFromResponse(res, "GitHub 代码搜索");
	attempts.push({
		url,
		statusCode: res.statusCode,
		failure: httpFailure?.failure,
		note: optionalReason(httpFailure?.reason, notes.join("；"))
	});
	if (httpFailure !== null) return {
		ok: false,
		results: [],
		reason: httpFailure.reason,
		failure: httpFailure.failure,
		attempts
	};
	let payload;
	try {
		payload = JSON.parse(res.body);
	} catch (error) {
		return {
			ok: false,
			results: [],
			reason: joinReason("GitHub 代码搜索返回值不是合法 JSON", `解析错误：${error instanceof Error ? error.message : String(error)}`, notes.join("；")),
			failure: "parse-failed",
			attempts
		};
	}
	const items = arrayField(payload, "items");
	if (items === null) return {
		ok: false,
		results: [],
		reason: joinReason("GitHub 代码搜索返回结构里没有 items[]", notes.join("；")),
		failure: "parse-failed",
		attempts
	};
	const rows = [];
	for (const item of items) {
		if (!isRecord$3(item)) continue;
		const row = mapGithubCode(item, {
			authenticated: true,
			notes,
			maxCodeChars: clampMaxCodeChars$1(opts.maxCodeChars)
		});
		if (row !== null) rows.push(row);
	}
	if (rows.length === 0) return {
		ok: false,
		results: [],
		reason: joinReason("GitHub 代码搜索返回 0 条可用结果", notes.join("；")),
		failure: "empty",
		attempts
	};
	const truncated = rows.length > maxItems;
	return {
		ok: true,
		results: rows.slice(0, maxItems),
		reason: joinReason(`GitHub 代码搜索命中 ${rows.length} 条（已登录）`, truncated ? `已按 maxItems=${maxItems} 截断` : void 0, notes.join("；")),
		attempts,
		truncated
	};
}
/** `search()` behind the adapter: repo search always, code search when a token exists. */
async function searchGithub(query, opts) {
	const maxItems = clampMaxItems(opts.maxItems);
	const repo = await searchGithubRepos(query, opts);
	const token = tokenForAccess(opts.access, opts.token);
	let code;
	if (token !== void 0 && repo.results.length < maxItems) code = await searchGithubCode(query, opts);
	const attempts = [...repo.attempts ?? [], ...code?.attempts ?? []];
	const rows = dedupe([...repo.results, ...code?.results ?? []]).slice(0, maxItems);
	if (rows.length === 0) {
		const failure = repo.failure ?? code?.failure ?? "empty";
		return {
			ok: false,
			results: [],
			reason: joinReason("GitHub 搜索未取得可用结果", repo.reason, code === void 0 ? void 0 : `代码搜索：${code.reason}`),
			failure,
			attempts
		};
	}
	const truncated = repo.results.length + (code?.results.length ?? 0) > maxItems;
	return {
		ok: true,
		results: rows,
		reason: joinReason(repo.reason, code === void 0 ? void 0 : code.reason, truncated ? `合并后已按 maxItems=${maxItems} 截断` : void 0),
		attempts,
		truncated
	};
}
/** Split `owner/repo` out of any GitHub URL this adapter produced. */
function parseGithubRepo(url) {
	const match = /^https?:\/\/[^/]*github(?:usercontent)?\.[a-z.]+\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:blob|tree)\/([^/\s#?]+))?/i.exec(url.trim());
	if (match === null) return null;
	const owner = group(match, 1);
	const rawRepo = group(match, 2);
	if (owner === void 0 || rawRepo === void 0) return null;
	const repo = rawRepo.replace(/\.git$/, "");
	if (repo.length === 0) return null;
	const ref = group(match, 3);
	return ref === void 0 ? {
		owner,
		repo
	} : {
		owner,
		repo,
		ref
	};
}
const SOURCE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".php",
	".rb",
	".java",
	".kt",
	".cs",
	".vue",
	".svelte"
];
/** Pick core-module candidates out of a recursive tree listing. */
function pickCorePaths(entries, limit = 3) {
	const scored = entries.filter((entry) => {
		if (entry.type !== "blob") return false;
		const lower = entry.path.toLowerCase();
		if (/(^|\/)(tests?|__tests__|spec|e2e|docs?|examples?|benchmarks?)\//.test(lower)) return false;
		if (/(^|\/)readme(\.[a-z-]+)?$/.test(lower)) return false;
		if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(lower)) return false;
		return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
	}).map((entry) => {
		const lower = entry.path.toLowerCase();
		let rank = 0;
		if (lower.startsWith("src/") || lower.startsWith("lib/") || lower.startsWith("core/")) rank -= 2;
		const depth = entry.path.split("/").length;
		return {
			entry,
			rank: rank + depth
		};
	});
	scored.sort((left, right) => left.rank === right.rank ? left.entry.path.localeCompare(right.entry.path) : left.rank - right.rank);
	return scored.slice(0, Math.max(1, limit)).map((item) => item.entry.path);
}
/** Pick test-file candidates out of a recursive tree listing. */
function pickTestPaths(entries, limit = 2) {
	const candidates = entries.filter((entry) => {
		if (entry.type !== "blob") return false;
		const lower = entry.path.toLowerCase();
		if (/(^|\/)(tests?|__tests__|spec|e2e)\//.test(lower)) return true;
		return /\.(test|spec)\.[a-z]+$/.test(lower);
	});
	candidates.sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path));
	return candidates.slice(0, Math.max(1, limit)).map((entry) => entry.path);
}
/** Deep read: resolve the default branch, discover files, read via raw mirrors. */
async function deepReadGithub(url, targets, opts) {
	const attempts = [];
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const parsed = parseGithubRepo(url);
	const requested = targets.length > 0 ? [...targets] : ["readme"];
	if (parsed === null) return {
		notes: [],
		reason: `无法从 URL 解析出 owner/repo：${url}`,
		failure: "parse-failed",
		fetchedUrls: [],
		skipped: requested,
		attempts
	};
	const { bases, reason: baseReason } = rawBasesFor(opts);
	if (bases.length === 0) return {
		notes: [],
		reason: joinReason("GitHub 深度阅读无法读取文件", baseReason),
		failure: "network",
		fetchedUrls: [],
		skipped: requested,
		attempts
	};
	const fullName = `${parsed.owner}/${parsed.repo}`;
	const token = tokenForAccess(opts.access, opts.token);
	let branch = parsed.ref ?? "";
	if (branch.length === 0) {
		const metaUrl = buildGithubApiUrl(`/repos/${parsed.owner}/${parsed.repo}`, opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase });
		try {
			const meta = await opts.transport({
				url: metaUrl,
				headers: { ...GITHUB_API_HEADERS },
				...token === void 0 ? {} : { token },
				timeoutMs,
				signal: opts.signal
			});
			const metaFailure = failureFromResponse(meta, "GitHub 仓库元数据");
			if (metaFailure === null) {
				const payload = JSON.parse(meta.body);
				branch = (isRecord$3(payload) ? asString(payload["default_branch"]) : void 0) ?? "HEAD";
			} else branch = "HEAD";
			attempts.push({
				url: metaUrl,
				statusCode: meta.statusCode,
				failure: metaFailure?.failure,
				note: optionalReason(metaFailure?.reason, transportNotes(meta).join("；"))
			});
		} catch (error) {
			const classified = classifyTransportError(error);
			attempts.push({
				url: metaUrl,
				statusCode: null,
				failure: classified.failure,
				note: classified.reason
			});
			branch = "HEAD";
		}
	}
	let treeEntries = [];
	if (requested.includes("core") || requested.includes("tests")) {
		const treeUrl = buildGithubApiUrl(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}`, {
			...opts.apiBase === void 0 ? {} : { apiBase: opts.apiBase },
			params: { recursive: "1" }
		});
		try {
			const tree = await opts.transport({
				url: treeUrl,
				headers: { ...GITHUB_API_HEADERS },
				...token === void 0 ? {} : { token },
				timeoutMs,
				signal: opts.signal
			});
			const treeFailure = failureFromResponse(tree, "GitHub 文件树");
			if (treeFailure === null) treeEntries = (arrayField(JSON.parse(tree.body), "tree") ?? []).filter(isRecord$3).map((entry) => ({
				path: asString(entry["path"]) ?? "",
				type: asString(entry["type"]) ?? "",
				size: asNumber(entry["size"]) ?? 0
			})).filter((entry) => entry.path.length > 0);
			attempts.push({
				url: treeUrl,
				statusCode: tree.statusCode,
				failure: treeFailure?.failure,
				note: optionalReason(treeFailure?.reason, transportNotes(tree).join("；"))
			});
		} catch (error) {
			const classified = classifyTransportError(error);
			attempts.push({
				url: treeUrl,
				statusCode: null,
				failure: classified.failure,
				note: classified.reason
			});
		}
	}
	const candidates = [];
	const pushCandidate = (path, target) => {
		const canonical = `${GITHUB_RAW_ORIGIN}/${fullName}/${branch}/${path}`;
		if (candidates.some((candidate) => candidate.url === canonical)) return;
		candidates.push({
			url: canonical,
			target,
			label: path
		});
	};
	if (requested.includes("readme")) for (const path of candidatePaths("readme")) pushCandidate(path, "readme");
	if (requested.includes("entry")) for (const path of candidatePaths("entry")) pushCandidate(path, "entry");
	if (requested.includes("core")) {
		const corePaths = treeEntries.length > 0 ? pickCorePaths(treeEntries) : candidatePaths("core");
		for (const path of corePaths) pushCandidate(path, "core");
	}
	if (requested.includes("tests")) {
		const paths = treeEntries.length > 0 ? pickTestPaths(treeEntries) : candidatePaths("tests");
		for (const path of paths) pushCandidate(path, "tests");
	}
	const fetchFile = async (candidateUrl) => {
		const repoPath = candidateUrl.startsWith(`https://raw.githubusercontent.com/`) ? candidateUrl.slice(34) : candidateUrl.replace(/^\/+/, "");
		const failures = [];
		let lastUrl = candidateUrl;
		for (const base of bases) {
			const raw = buildGithubRawUrl(base, repoPath);
			lastUrl = raw;
			try {
				const res = await opts.transport({
					url: raw,
					headers: { ...GITHUB_RAW_HEADERS },
					timeoutMs,
					signal: opts.signal
				});
				const httpFailure = failureFromResponse(res, "GitHub raw 文件");
				const notes = transportNotes(res);
				if (httpFailure === null) return {
					ok: true,
					url: res.finalUrl.length > 0 ? res.finalUrl : raw,
					text: res.body
				};
				failures.push(optionalReason(`${raw}：${httpFailure.reason}`, notes.join("；")) ?? raw);
				attempts.push({
					url: raw,
					statusCode: res.statusCode,
					failure: httpFailure.failure,
					note: httpFailure.reason
				});
				if (httpFailure.failure === "empty" || httpFailure.failure === "auth-required" || httpFailure.failure === "rate-limited") return {
					ok: false,
					url: raw,
					failure: httpFailure.failure,
					reason: joinReason(httpFailure.reason, notes.join("；"))
				};
			} catch (error) {
				const classified = classifyTransportError(error);
				failures.push(`${raw}：${classified.reason}`);
				attempts.push({
					url: raw,
					statusCode: null,
					failure: classified.failure,
					note: classified.reason
				});
			}
		}
		return {
			ok: false,
			url: lastUrl,
			failure: "network",
			reason: joinReason(`所有 raw 基址都失败（${bases.length} 个）`, failures.slice(0, 3).join("；"), baseReason)
		};
	};
	const outcome = await deepReadFiles({
		url,
		title: fullName,
		requested,
		candidates,
		fetchFile,
		maxFiles: 6
	});
	return {
		...outcome,
		attempts: [...attempts, ...outcome.attempts ?? []]
	};
}
/** Adapter factory. */
function createGithubAdapter() {
	return {
		id: "github",
		search: searchGithub,
		deepRead: deepReadGithub
	};
}
//#endregion
//#region src/service.ts
/**
* dsh-codehub — the `codeSource` host service and the unified delivery outlet.
*
* This is the only place the plugin orchestrates: 决策门禁 -> 按 sourcePriority
* 逐源查询 -> 失败降级（需用户已同意）-> 合并去重 -> 深度阅读 -> redactForDelivery.
*
* TWO INVARIANTS WORTH THE READING TIME
* -------------------------------------
* 1. **The decision gate runs before anything else.** `search()` checks
*    `evaluateDecisions(config)` and returns early; on that path no adapter is
*    constructed and no `Transport` is built, so "未决策" costs exactly zero
*    network requests. That ordering is the requirement — not "ask after
*    looking".
* 2. **Every row leaves through `redactForDelivery()`.** It is the single
*    outlet: it bounds `code`, marks `codeTruncated`, stamps the learning-only
*    banner INTO the excerpt, validates `confidence`, and writes
*    `is_verbatim_copy: false` — literally the only value the type permits.
*    Nothing else in this file may construct a `CodeLearnResult` for delivery.
*
* On optional services: `credentials` and `web` are reached with `ctx.get()` and
* a `undefined` check. Property access on an un-injected service throws on this
* runtime, and a throw during mount can take the whole plugin install down.
*/
/**
* The three credential references (docs/DESIGN.md §4).
*
* A `CredentialRef` is a plain string that doubles as an environment-variable
* name, which is why these match `.env.example` exactly. The VALUE never enters
* this module's state: it is fetched per call, handed to the adapter, and
* dropped when the call returns.
*/
const CREDENTIAL_REFS = {
	github: "DSH_CODEHUB_GITHUB_TOKEN",
	gitee: "DSH_CODEHUB_GITEE_TOKEN",
	csdn: "DSH_CODEHUB_CSDN_COOKIE"
};
/** Operator-facing note for the mirror strategies. */
const MIRROR_TOKEN_NOTE = "镜像 / 第三方转发路径在构造请求时强制剥离 token（TOKEN_FORBIDDEN_ACCESS）。";
/** Which operations make sense for which source. */
const OPERATIONS_BY_SOURCE = {
	github: [
		"repo-search",
		"code-search",
		"file-read"
	],
	gitee: [
		"repo-search",
		"code-search",
		"file-read"
	],
	csdn: ["code-search", "article-read"]
};
/**
* The one operation a `smoke()` probe actually exercised.
*
* `smoke()` calls each adapter's `search()`: for GitHub and Gitee that is the
* repository search, for CSDN its search API. Naming it honestly is what keeps
* the derived capability row from claiming to have measured code search.
*/
const PRIMARY_SMOKE_OPERATION = {
	github: "repo-search",
	gitee: "repo-search",
	csdn: "code-search"
};
/**
* Turn a self-check probe into the capability row the panel renders.
*
* Kept as a pure function so the derivation is testable without a service, and
* so the one thing that matters stays visible: `requiresLogin` is the contract
* baseline plus the live 401, never a guess.
*/
function capabilityFromSmokeProbe(probe, probedAt) {
	const source = probe.source;
	const operation = PRIMARY_SMOKE_OPERATION[source];
	const status = probe.statusCode;
	const requiresLogin = operationRequiresLogin(source, operation) || status === 401;
	const measured = status === null ? "请求未得到应答" : `HTTP ${status}`;
	return {
		source,
		label: probe.label,
		probedAt,
		authenticated: false,
		operations: [{
			operation,
			reachable: status !== null && status > 0,
			statusCode: status,
			requiresLogin,
			evidence: `${operation} 本次自检实测（匿名）：${measured} —— ${probe.reason} ${LOGIN_REQUIREMENTS[source]}`,
			probedAt
		}]
	};
}
/** Probes are diagnostics: they must answer fast, so they get their own budget. */
const PROBE_TIMEOUT_MS = 8e3;
/** Same clamp the adapters use, from the same contract caps. */
function clampMaxCodeChars(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return DEFAULT_LIMITS.maxCodeChars;
	return Math.min(Math.floor(value), HARD_LIMITS.maxCodeChars);
}
/**
* Cut on a line boundary when that keeps most of the budget, so an excerpt does
* not end mid-token.
*/
function cutAtLineBoundary(text, budget) {
	const hard = text.slice(0, budget);
	const lastBreak = hard.lastIndexOf("\n");
	if (lastBreak >= Math.floor(budget * .6)) return hard.slice(0, lastBreak);
	return hard;
}
function isResultArray(value) {
	return Array.isArray(value);
}
function fallbackSummary(result) {
	return `未提取出思路要点（来源：${result.title.trim().length > 0 ? result.title : result.url}）。请打开来源原文自行阅读，不要把它当作可直接使用的代码。`;
}
function redactForDelivery(input, limits = {}) {
	const budget = clampMaxCodeChars(limits.maxCodeChars);
	if (isResultArray(input)) return input.map((item) => redactOne(item, budget));
	return redactOne(input, budget);
}
function redactOne(result, budget) {
	const banner = `${LEARNING_ONLY_BANNER}\n`;
	const rawCode = typeof result.code === "string" ? result.code : "";
	const codeBudget = Math.max(1, budget - banner.length);
	const truncated = rawCode.length > codeBudget;
	const kept = truncated ? cutAtLineBoundary(rawCode, codeBudget) : rawCode;
	const summary = typeof result.learned_summary === "string" && result.learned_summary.trim().length > 0 ? result.learned_summary : fallbackSummary(result);
	const confidence = CONFIDENCE_LEVELS.includes(result.confidence) ? result.confidence : "low";
	return {
		source: result.source,
		url: result.url,
		title: result.title,
		language: typeof result.language === "string" ? result.language : "",
		code: `${banner}${kept}`,
		codeTruncated: truncated || result.codeTruncated === true,
		learned_summary: summary,
		is_verbatim_copy: false,
		stars: typeof result.stars === "number" && Number.isFinite(result.stars) ? result.stars : null,
		updatedAt: typeof result.updatedAt === "string" && result.updatedAt.trim().length > 0 ? result.updatedAt : null,
		confidence,
		reason: typeof result.reason === "string" ? result.reason : ""
	};
}
/**
* Compose a mirror API base from a configured prefix.
*
* `https://ghproxy.net/` + `https://api.github.com` -> `https://ghproxy.net/https://api.github.com`,
* which is the form the adapters append endpoint paths to. A `{url}` template is
* honoured too.
*/
function composeMirrorBase(mirror, override) {
	const official = override.trim().length > 0 ? override.trim() : GITHUB_API_BASE;
	const trimmed = mirror.trim().replace(/\/+$/, "");
	if (trimmed.includes("{url}")) return trimmed.replace("{url}", official);
	const bare = official.replace(/^https?:\/\//, "");
	if (trimmed.endsWith(bare)) return trimmed;
	return `${trimmed}/${official}`;
}
/**
* Pick the first GitHub access strategy that is actually usable.
*
* "Configured but unavailable" never falls back to something the user did not
* choose (docs/DESIGN.md §2 #7: 空列表 = 该方式不可用，不兜底). Each skipped
* strategy leaves a note explaining itself, so the reason string tells the user
* what to fix rather than silently taking a different route.
*/
function resolveAccess(config) {
	const notes = [];
	const rawMirrors = [...config.github.rawMirrorBases];
	const priority = config.github.accessPriority;
	if (priority.length === 0) return {
		access: void 0,
		apiBase: "",
		rawMirrors,
		available: false,
		notes: ["尚未决定 GitHub 的访问方式（accessPriority 为空），不会替用户选择。"]
	};
	for (const candidate of priority) {
		if (candidate === "direct" || candidate === "watt" || candidate === "hosts") return {
			access: candidate,
			apiBase: config.github.apiBase,
			rawMirrors,
			available: true,
			notes
		};
		if (candidate === "token") return {
			access: candidate,
			apiBase: config.github.apiBase,
			rawMirrors,
			available: true,
			notes: [...notes, "选择「Token 登录」；未配置 token 时会以匿名额度访问并在 reason 里标注。"]
		};
		if (candidate === "local-proxy") {
			if (config.github.localProxy.trim().length === 0) {
				notes.push("「本机代理」已勾选但地址为空；按设计「未填 = 该方式不可用」，继续看下一个方式。");
				continue;
			}
			return {
				access: candidate,
				apiBase: config.github.apiBase,
				rawMirrors,
				available: true,
				notes: [...notes, `本机代理${LOCAL_PROXY_SCOPE_NOTE}。`]
			};
		}
		if (candidate === "ghproxy" || candidate === "third-party-mirror") {
			const base = config.github.webProxyBases[0];
			if (base === void 0 || base.trim().length === 0) {
				notes.push(`「${candidate}」已勾选但镜像基址列表为空；按设计不预填、不兜底，继续看下一个方式。`);
				continue;
			}
			return {
				access: candidate,
				apiBase: composeMirrorBase(base, config.github.apiBase),
				rawMirrors,
				available: true,
				notes: [...notes, MIRROR_TOKEN_NOTE]
			};
		}
		notes.push("「raw 文件镜像」只用于文件下载，不提供搜索 API 基址，跳过（不会退回官方直连）。");
	}
	return {
		access: void 0,
		apiBase: "",
		rawMirrors,
		available: false,
		notes: [...notes, "accessPriority 里勾选的访问方式当前都不可用，未发起请求。"]
	};
}
function normalizeSources(values) {
	if (values === void 0) return [];
	const out = [];
	for (const value of values) {
		if (!SOURCES.includes(value)) continue;
		if (!out.includes(value)) out.push(value);
	}
	return out;
}
/**
* Source order for one call.
*
* The configured `sourcePriority` is the backbone — the user's ranking is never
* discarded. An explicit `sources` argument re-orders within it and appends
* anything the ranking did not mention, because the caller asked for those
* sources by name.
*/
function orderSources(priority, requested) {
	if (requested.length === 0) return [...priority];
	return [...priority.filter((source) => requested.includes(source)), ...requested.filter((source) => !priority.includes(source))];
}
/**
* The host service consumed as `ctx.codeSource`.
*
* Every optional service is looked up lazily through `ctx.get()` so a context
* without `credentials` or `web` still mounts and still answers — with a clear
* degradation message instead of an exception.
*/
var CodeSource = class extends Service {
	context;
	deps;
	constructor(ctx, deps) {
		super(ctx, SERVICE_KEY);
		this.context = ctx;
		this.deps = deps;
	}
	/** Resolve the effective configuration (built-in config + store snapshot + settings). */
	async resolve() {
		const stored = await this.deps.store.read().catch(() => ({}));
		const fromSettings = this.deps.settings === void 0 ? void 0 : (await this.deps.settings.read()).value;
		return resolveConfig(mergeConfigInput(mergeConfigInput(this.deps.getConfig(), stored.fallbackConfig), fromSettings), { localProxy: stored.localProxy });
	}
	/** Current effective limits. The tool needs them before it composes a timeout. */
	getLimits() {
		return resolveLimits(this.deps.getConfig().limits);
	}
	/** The four decisions that have no answer yet. Empty = the tool may run. */
	async getUnresolved() {
		return unresolvedDecisions(await this.resolve());
	}
	async describeConfig() {
		const config = await this.resolve();
		const decisions = unresolvedDecisions(config);
		const storePath = this.deps.store.filePath;
		return {
			ok: true,
			config: toJsonView(config),
			decisions,
			decided: decisions.length === 0,
			credentials: await this.credentialStatus(),
			limits: config.limits,
			transport: {
				webAvailable: this.deps.web !== void 0,
				proxyConfigured: config.github.localProxy.trim().length > 0,
				proxyScopeNote: LOCAL_PROXY_SCOPE_NOTE
			},
			notes: {
				csdn: CSDN_API_NOTE,
				localProxy: LOCAL_PROXY_HELP,
				antiCopy: ANTI_COPY_STATEMENT,
				settings: `settings namespace: ${SETTINGS_NAMESPACE}`
			},
			paths: { store: storePath },
			login: {
				requirements: LOGIN_REQUIREMENTS,
				oauth: {
					github: config.github.oauthClientId.trim().length > 0,
					gitee: config.gitee.oauthClientId.trim().length > 0 && await this.hasCredential("DSH_CODEHUB_GITEE_OAUTH_CLIENT_SECRET")
				},
				guides: LOGIN_GUIDES
			}
		};
	}
	/** Presence of one credential ref, as a boolean. A value never leaves here. */
	async hasCredential(ref) {
		const credentials = this.context.get("credentials");
		if (credentials === void 0) return false;
		try {
			return (await credentials.describe(ref))?.configured === true;
		} catch {
			return false;
		}
	}
	/** Booleans only — `describe()`, never `resolve()`. A value never leaves here. */
	async credentialStatus() {
		const targets = [
			"github",
			"gitee",
			"csdn"
		];
		const out = {
			github: false,
			gitee: false,
			csdn: false
		};
		const credentials = this.context.get("credentials");
		if (credentials === void 0) return out;
		for (const target of targets) try {
			out[target] = (await credentials.describe(CREDENTIAL_REFS[target]))?.configured === true;
		} catch {
			out[target] = false;
		}
		return out;
	}
	/**
	* Query the sources in priority order.
	*
	* Returns a value for every business outcome (including refusals) so the model
	* can branch on `ok`. Only a caller mistake throws.
	*/
	async search(query, options = {}) {
		const trimmed = typeof query === "string" ? query.trim() : "";
		const empty = {
			ok: false,
			query: trimmed,
			results: [],
			notes: [],
			failures: [],
			unresolved_decisions: [],
			ask_user: "",
			reason: "",
			degraded: false,
			merged: false,
			sources_queried: [],
			deep_read: false
		};
		const config = await this.resolve();
		if (!config.enabled) {
			const refusal = disabledRefusal();
			return {
				...empty,
				reason: refusal.reason,
				ask_user: refusal.ask_user
			};
		}
		const gate = evaluateDecisions(config);
		if (!gate.ok) return {
			...empty,
			unresolved_decisions: [...gate.unresolved_decisions],
			ask_user: gate.ask_user,
			reason: "尚有决策点未确认，按设计未发起任何网络请求。请先回答下面的问题，再让我重试。"
		};
		const order = orderSources(config.sourcePriority, normalizeSources(options.sources));
		if (order.length === 0) return {
			...empty,
			reason: "没有任何可查询的源（sourcePriority 与本次指定的来源都为空）。"
		};
		const access = resolveAccess(config);
		const requestedLimit = typeof options.maxItems === "number" && Number.isFinite(options.maxItems) ? options.maxItems : config.limits.maxItems;
		const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), config.limits.maxItems, HARD_LIMITS.maxItems);
		const failures = [];
		const collected = [];
		const notes = [];
		const queried = [];
		const chainNotes = [];
		let degraded = false;
		let deepReadPerformed = false;
		for (const source of order) {
			if (failures.length > config.limits.maxDepth && config.failover.enabled === true) {
				chainNotes.push(`降级深度已达上限（limits.maxDepth = ${config.limits.maxDepth}），停止继续切换源。`);
				break;
			}
			const adapter = this.adapterFor(source);
			if (adapter === void 0) {
				failures.push({
					source,
					kind: "not-code",
					reason: `没有可用的 ${SOURCE_LABELS[source]} 适配器。`
				});
				continue;
			}
			const sourceAccess = source === "github" ? access.access : void 0;
			if (source === "github" && !access.available) {
				failures.push({
					source,
					kind: "network",
					reason: ["GitHub 访问方式当前不可用，未发起请求。", ...access.notes].join(" ")
				});
				if (config.failover.enabled !== true) break;
				degraded = true;
				continue;
			}
			const token = await this.resolveToken(source);
			const authenticated = token !== void 0;
			const transport = this.buildTransport(config, sourceAccess);
			let outcome;
			try {
				outcome = await adapter.search(trimmed, this.adapterOptions(config, transport, {
					token,
					authenticated,
					access: sourceAccess,
					limit,
					signal: options.signal,
					apiBase: this.apiBaseFor(source, access, config),
					htmlFallback: source === "github" ? void 0 : source === "gitee" ? config.gitee.htmlFallback : config.csdn.htmlFallback
				}));
			} catch (error) {
				const kind = classifyAdapterThrow(error);
				outcome = {
					ok: false,
					results: [],
					reason: `适配器抛出异常：${describeError(error)}`,
					failure: kind
				};
			}
			queried.push(source);
			if (outcome.ok && outcome.results.length > 0) {
				collected.push(...outcome.results);
				if (outcome.truncated === true) chainNotes.push(`${SOURCE_LABELS[source]} 的结果被 maxItems 截断。`);
				if (config.mergeSources !== true) break;
				continue;
			}
			const kind = outcome.failure ?? "empty";
			failures.push({
				source,
				kind,
				reason: outcome.reason
			});
			if (config.failover.enabled !== true) break;
			degraded = true;
			chainNotes.push(`${SOURCE_LABELS[source]} 失败（${kind}），按用户设置自动降级到下一个源。`);
		}
		const results = redactForDelivery((collected.length > 0 ? dedupe(collected) : []).slice(0, limit), { maxCodeChars: config.limits.maxCodeChars });
		const targets = config.deepRead.targets;
		if (options.deepRead === true) {
			if (targets.length === 0) chainNotes.push("已请求深度阅读，但没有选择深度阅读目标（决策点 11），本次只做浅搜索。");
			else {
				const budget = Math.max(1, config.limits.maxDepth);
				let used = 0;
				for (const row of results) {
					if (used >= budget) break;
					const adapter = this.adapterFor(row.source);
					if (adapter?.deepRead === void 0) continue;
					const accessPlan = row.source === "github" ? access : void 0;
					const sourceAccess = accessPlan?.access;
					const token = await this.resolveToken(row.source);
					try {
						const deep = await adapter.deepRead(row.url, targets, this.adapterOptions(config, this.buildTransport(config, sourceAccess), {
							token,
							authenticated: token !== void 0,
							access: sourceAccess,
							limit,
							signal: options.signal,
							apiBase: this.apiBaseFor(row.source, accessPlan, config),
							maxDepth: 0
						}));
						if (deep.notes.length > 0) {
							notes.push(...deep.notes);
							deepReadPerformed = true;
						} else if (deep.reason.length > 0) chainNotes.push(`深度阅读未产出笔记：${deep.reason}`);
					} catch (error) {
						chainNotes.push(`深度阅读失败：${describeError(error)}`);
					}
					used += 1;
				}
			}
		}
		const reasonParts = [
			...chainNotes,
			...failures.length > 0 ? [`失败：${failures.map((item) => `${item.source}=${item.kind}`).join("、")}`] : [],
			`共 ${results.length} 条（合并去重后${config.mergeSources === true ? "，已开启多源合并" : "，未开启多源合并"}）。`,
			"结果仅用于学习实现思路 / API 用法 / 取舍 / 踩坑，不是可直接粘贴的代码交付物。"
		];
		if (results.length === 0) {
			const untried = order.filter((source) => !queried.includes(source));
			return {
				ok: false,
				query: trimmed,
				results: [],
				notes,
				failures,
				unresolved_decisions: [],
				ask_user: untried.length > 0 ? `这些源都没有给出可用结果。要不要再查 ${untried.map((source) => SOURCE_LABELS[source]).join(" / ")}？` : "所有源都没有给出可用结果。要不要换一组更具体的关键词，或者调整访问方式（token / 镜像 / 本机代理）？",
				reason: reasonParts.join(" "),
				degraded,
				merged: config.mergeSources === true,
				sources_queried: queried,
				deep_read: deepReadPerformed
			};
		}
		return {
			ok: true,
			query: trimmed,
			results,
			notes,
			failures,
			unresolved_decisions: [],
			ask_user: "",
			reason: reasonParts.join(" "),
			degraded,
			merged: config.mergeSources === true,
			sources_queried: queried,
			deep_read: deepReadPerformed
		};
	}
	/**
	* Distil design notes from one URL. Returns notes, never files.
	*
	* Returns `[]` (with a log line) when a decision is still open — the caller
	* that needs a *reason* should ask `getUnresolved()` first, which is what the
	* `POST /deepread` route does.
	*/
	async deepRead(url, targets, options = {}) {
		const config = await this.resolve();
		if (!config.enabled) return [];
		const gate = evaluateDecisions(config);
		if (!gate.ok) {
			this.deps.logger?.("深度阅读被决策门禁拒绝，未发起网络请求", { unresolved: gate.unresolved_decisions.length });
			return [];
		}
		const wanted = targets !== void 0 && targets.length > 0 ? targets : config.deepRead.targets;
		if (wanted.length === 0) return [];
		const source = this.sourceForUrl(url, config.sourcePriority);
		const adapter = this.adapterFor(source);
		if (adapter?.deepRead === void 0) return [];
		const accessPlan = source === "github" ? resolveAccess(config) : void 0;
		const sourceAccess = accessPlan?.access;
		const token = await this.resolveToken(source);
		try {
			return (await adapter.deepRead(url, wanted, this.adapterOptions(config, this.buildTransport(config, sourceAccess), {
				token,
				authenticated: token !== void 0,
				access: sourceAccess,
				signal: options.signal,
				apiBase: this.apiBaseFor(source, accessPlan, config)
			}))).notes;
		} catch (error) {
			this.deps.logger?.("深度阅读失败", {
				source,
				reason: describeError(error)
			});
			return [];
		}
	}
	/**
	* Manual connectivity self-check.
	*
	* Deliberately TOKEN-FREE: it exercises the anonymous path only, so running it
	* can never leak a credential, and its result tells the user whether the
	* public route works before they invest in one.
	*/
	async smoke() {
		const config = await this.resolve();
		if (!config.enabled) return {
			ok: false,
			probes: [],
			notes: ["插件当前处于关闭状态，未发起任何探测请求。"],
			capabilities: []
		};
		const probes = [];
		const notes = ["自检只使用公开端点且不携带任何凭据（token / cookie 都不会发出）。"];
		for (const source of SOURCES) {
			const adapter = this.adapterFor(source);
			if (adapter === void 0) {
				probes.push({
					source,
					label: SOURCE_LABELS[source],
					ok: false,
					statusCode: null,
					failure: "not-code",
					latencyMs: 0,
					transport: "node",
					reason: `没有可用的 ${SOURCE_LABELS[source]} 适配器。`
				});
				continue;
			}
			const started = Date.now();
			const transport = this.buildTransport(config, void 0);
			try {
				const outcome = await adapter.search("vue", this.adapterOptions(config, transport, { limit: 1 }));
				const status = outcome.attempts?.find((attempt) => attempt.statusCode !== null)?.statusCode ?? null;
				probes.push({
					source,
					label: SOURCE_LABELS[source],
					ok: outcome.ok,
					statusCode: status,
					...outcome.failure === void 0 ? {} : { failure: outcome.failure },
					latencyMs: Date.now() - started,
					transport: config.github.localProxy.trim().length > 0 ? "node" : this.deps.web === void 0 ? "node" : "dsh-web",
					reason: outcome.reason
				});
			} catch (error) {
				probes.push({
					source,
					label: SOURCE_LABELS[source],
					ok: false,
					statusCode: null,
					failure: classifyAdapterThrow(error),
					latencyMs: Date.now() - started,
					transport: "node",
					reason: describeError(error)
				});
			}
		}
		if (config.github.localProxy.trim().length > 0) notes.push(`本机代理已配置：${LOCAL_PROXY_SCOPE_NOTE}。`);
		const probedAt = (/* @__PURE__ */ new Date()).toISOString();
		const capabilities = probes.map((probe) => capabilityFromSmokeProbe(probe, probedAt));
		notes.push("上方每行的「查代码是否需要登录」= 本次匿名实测的 HTTP 状态码 + contract 里的实测文案；自检不携带任何凭据。");
		return {
			ok: probes.every((probe) => probe.ok),
			probes,
			notes,
			capabilities
		};
	}
	/**
	* Measure what one source can actually do right now, operation by operation.
	*
	* Deliberately ANONYMOUS by default: the connectivity panel has to answer
	* before the user has any credential, and a self-check that quietly spent one
	* would be a credential leaving the process without being asked. Pass
	* `useStoredCredential: true` to include the stored one.
	*
	* Runs without the decision gate: probing is how a user decides.
	*/
	async probe(input = {}) {
		const config = await this.resolve();
		const source = input.source ?? config.sourcePriority[0] ?? "github";
		const token = input.useStoredCredential === true ? await this.resolveToken(source) : void 0;
		const authenticated = token !== void 0;
		const transport = this.buildTransport(config, source === "github" ? resolveAccess(config).access : void 0);
		const probedAt = (/* @__PURE__ */ new Date()).toISOString();
		const operations = [];
		for (const operation of OPERATIONS_BY_SOURCE[source]) operations.push(await this.probeOperation(config, transport, source, operation, token, authenticated, probedAt));
		return {
			source,
			label: SOURCE_LABELS[source],
			probedAt,
			authenticated,
			operations
		};
	}
	async probeOperation(config, transport, source, operation, token, authenticated, probedAt) {
		const baseline = operationRequiresLogin(source, operation);
		const url = probeUrlFor(source, operation, config);
		const headers = source === "csdn" ? { ...CSDN_REQUEST_HEADERS } : void 0;
		const timeoutMs = Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS);
		const mode = authenticated ? "带已存凭据" : "匿名";
		try {
			const response = await transport({
				url,
				...headers === void 0 ? {} : { headers },
				...authenticated && token !== void 0 ? { token } : {},
				timeoutMs
			});
			const reachable = response.statusCode > 0;
			const requiresLogin = baseline || response.statusCode === 401;
			const hint = response.statusCode === 521 ? "（HTTP 521：反爬拦截，通常代表缺少 UA / Referer 或日志态已失效）" : "";
			return {
				operation,
				reachable,
				statusCode: response.statusCode,
				requiresLogin,
				evidence: `${operation} 本次实测：HTTP ${response.statusCode}（${mode}）${hint} ${LOGIN_REQUIREMENTS[source]}`,
				probedAt
			};
		} catch (error) {
			return {
				operation,
				reachable: false,
				statusCode: null,
				requiresLogin: baseline,
				evidence: `${operation} 本次实测：请求未得到应答（${mode}）—— ${describeError(error)} ${LOGIN_REQUIREMENTS[source]}`,
				probedAt
			};
		}
	}
	/**
	* Check the stored credential for one source.
	*
	* GitHub and Gitee both publish an endpoint that authenticates the caller, so
	* the answer is a real verdict. CSDN publishes none — it has no OAuth and no
	* token API — so the honest answer there is a comparison between an anonymous
	* and a cookie-carrying sample, reported as improved / unchanged / rejected
	* instead of a verdict this service cannot actually make.
	*/
	async validateCredential(source) {
		if (source === "csdn") return this.validateCsdnCredential();
		const config = await this.resolve();
		const token = await this.resolveToken(source);
		if (token === void 0) return {
			source,
			verdict: "unknown",
			statusCode: null,
			account: null,
			reason: `尚未配置 ${SOURCE_LABELS[source]} 凭据，无法校验。`
		};
		const url = `${(source === "github" ? config.github.apiBase || "https://api.github.com" : config.gitee.apiBase || "https://gitee.com/api/v5").replace(/\/+$/, "")}/user`;
		const transport = this.buildTransport(config, source === "github" ? resolveAccess(config).access : void 0);
		try {
			const response = await transport({
				url,
				token,
				timeoutMs: Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS)
			});
			if (response.statusCode === 200) return {
				source,
				verdict: "valid",
				statusCode: 200,
				account: accountFromUserPayload(response.body),
				reason: `HTTP 200：凭据有效，这是你自己的账号身份。`
			};
			if (response.statusCode === 401) return {
				source,
				verdict: "invalid",
				statusCode: 401,
				account: null,
				reason: "HTTP 401：凭据被拒绝（已过期、被撤销，或复制时少了字符）。"
			};
			if (response.statusCode === 403) return {
				source,
				verdict: "unknown",
				statusCode: 403,
				account: null,
				reason: "HTTP 403：凭据本身可能有效，但当前被限流或无权访问该端点，无法据此判断。"
			};
			return {
				source,
				verdict: "unknown",
				statusCode: response.statusCode,
				account: null,
				reason: `HTTP ${response.statusCode}：不是 200/401，无法据此判断凭据好坏。`
			};
		} catch (error) {
			return {
				source,
				verdict: "unknown",
				statusCode: null,
				account: null,
				reason: `校验请求未得到应答：${describeError(error)}`
			};
		}
	}
	/** CSDN: no validation endpoint exists, so compare anonymous with cookie. */
	async validateCsdnCredential() {
		const config = await this.resolve();
		const cookie = await this.resolveToken("csdn");
		if (cookie === void 0) return {
			source: "csdn",
			verdict: "unknown",
			statusCode: null,
			account: null,
			reason: "尚未配置 CSDN cookie，无法做对比校验。"
		};
		const url = buildCsdnSearchUrl("vue", config.csdn.apiBase.length > 0 ? { apiBase: config.csdn.apiBase } : {});
		const transport = this.buildTransport(config, void 0);
		const timeoutMs = Math.min(config.limits.timeoutMs, PROBE_TIMEOUT_MS);
		const anonymous = await this.sampleCsdn(transport, url, void 0, timeoutMs);
		const authenticated = await this.sampleCsdn(transport, url, cookie, timeoutMs);
		const anonOk = anonymous !== null && anonymous.statusCode >= 200 && anonymous.statusCode < 300;
		const withOk = authenticated !== null && authenticated.statusCode >= 200 && authenticated.statusCode < 300;
		const reasonBase = "CSDN 没有官方校验接口（无 OAuth、无 token API），这里只能做匿名 vs 携带 cookie 的抽样对比。";
		if (withOk && !anonOk) return {
			source: "csdn",
			verdict: "improved",
			statusCode: authenticated?.statusCode ?? null,
			account: null,
			reason: `${reasonBase} 匿名请求未成功、带 cookie 成功，说明 cookie 生效。`
		};
		if (withOk && anonOk) {
			const grew = (authenticated?.length ?? 0) > (anonymous?.length ?? 0) * 1.2;
			return {
				source: "csdn",
				verdict: grew ? "improved" : "unchanged",
				statusCode: authenticated?.statusCode ?? null,
				account: null,
				reason: `${reasonBase} 两种方式都成功，返回体${grew ? "明显变大，cookie 可能提高了成功率" : "大小相当，本次看不出差别"}。`
			};
		}
		if (anonymous !== null && anonOk && authenticated !== null && authenticated.statusCode >= 400) return {
			source: "csdn",
			verdict: "rejected",
			statusCode: authenticated.statusCode,
			account: null,
			reason: `${reasonBase} 匿名可用但带 cookie 被拒（HTTP ${authenticated.statusCode}），cookie 可能已失效或被风控。`
		};
		return {
			source: "csdn",
			verdict: "unknown",
			statusCode: authenticated?.statusCode ?? null,
			account: null,
			reason: `${reasonBase} 本次两次抽样都没能给出结论。`
		};
	}
	async sampleCsdn(transport, url, cookie, timeoutMs) {
		try {
			const headers = { ...CSDN_REQUEST_HEADERS };
			if (cookie !== void 0) headers["cookie"] = cookie;
			const response = await transport({
				url,
				headers,
				timeoutMs
			});
			return {
				statusCode: response.statusCode,
				length: response.body.length
			};
		} catch {
			return null;
		}
	}
	adapterFor(source) {
		const injected = this.deps.adapters;
		if (injected !== void 0) {
			const found = injected.find((candidate) => candidate.id === source);
			if (found !== void 0) return found;
		}
		switch (source) {
			case "github": return createGithubAdapter();
			case "gitee": return createGiteeAdapter();
			case "csdn": return createCsdnAdapter();
			default: return;
		}
	}
	buildTransport(config, access) {
		return (this.deps.createTransport ?? createTransport)({
			...access === void 0 ? {} : { access },
			localProxy: config.github.localProxy,
			retries: config.limits.retries,
			timeoutMs: config.limits.timeoutMs,
			...this.deps.web === void 0 ? {} : { web: this.deps.web },
			...this.deps.logger === void 0 ? {} : { logger: this.deps.logger }
		});
	}
	adapterOptions(config, transport, extra = {}) {
		const limit = extra.limit ?? config.limits.maxItems;
		return {
			transport,
			timeoutMs: config.limits.timeoutMs,
			maxItems: Math.min(limit, HARD_LIMITS.maxItems),
			retries: config.limits.retries,
			authenticated: extra.authenticated === true,
			transportId: this.plannedTransport(config),
			rawMirrors: config.github.rawMirrorBases,
			maxDepth: extra.maxDepth ?? config.limits.maxDepth,
			maxCodeChars: config.limits.maxCodeChars,
			...extra.token === void 0 ? {} : { token: extra.token },
			...extra.access === void 0 ? {} : { access: extra.access },
			...extra.signal === void 0 ? {} : { signal: extra.signal },
			...extra.apiBase === void 0 || extra.apiBase.length === 0 ? {} : { apiBase: extra.apiBase },
			...extra.htmlFallback === void 0 ? {} : { htmlFallback: extra.htmlFallback }
		};
	}
	/** Best-effort channel label for the `reason` wording. Informational only. */
	plannedTransport(config) {
		if (config.github.localProxy.trim().length > 0) return "node";
		return this.deps.web === void 0 ? "node" : "dsh-web";
	}
	/**
	* Endpoint base override for one source. Empty string = the adapter's built-in
	* base (`GITHUB_API_BASE` / `GITEE_API_BASE` / `CSDN_SEARCH_BASE`), which is
	* also what a mirror strategy composes from.
	*/
	apiBaseFor(source, access, config) {
		if (source === "github") return access?.apiBase ?? "";
		if (source === "gitee") return config.gitee.apiBase;
		return config.csdn.apiBase;
	}
	async resolveToken(target) {
		const credentials = this.context.get("credentials");
		if (credentials === void 0) return void 0;
		try {
			const value = (await credentials.resolve(CREDENTIAL_REFS[target]))?.value;
			return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
		} catch {
			return;
		}
	}
	sourceForUrl(url, priority) {
		const lower = url.toLowerCase();
		if (lower.includes("github")) return "github";
		if (lower.includes("gitee")) return "gitee";
		if (lower.includes("csdn")) return "csdn";
		return priority[0] ?? "github";
	}
};
/**
* Does this operation need a login, per the contract's measured facts?
*
* These baselines come from `LOGIN_REQUIREMENTS` (github code search → 401
* anonymous; Gitee has no `/search/code` endpoint and its web code search needs
* a session; CSDN article pages are anti-bot gated without a cookie). They are
* the STARTING point — `probeOperation()` upgrades `requiresLogin` to true when
* the live request answers 401.
*/
function operationRequiresLogin(source, operation) {
	if (source === "github") return operation === "code-search";
	if (source === "gitee") return operation === "repo-search" || operation === "code-search";
	return operation === "article-read";
}
/**
* The URL one probe hits.
*
* Every base comes from the resolved config (or the contract's built-in), and
* the file-read targets are public, well-known repositories so a failure means
* "this path is not readable" rather than "the probe invented a bad URL".
*/
function probeUrlFor(source, operation, config) {
	const base = (value, fallback) => (value.trim().length > 0 ? value.trim() : fallback).replace(/\/+$/, "");
	const query = `q=${encodeURIComponent("vue")}&per_page=1`;
	if (source === "github") {
		const root = base(config.github.apiBase, GITHUB_API_BASE);
		if (operation === "repo-search") return `${root}/search/repositories?${query}`;
		if (operation === "code-search") return `${root}/search/code?${query}`;
		return `${root}/repos/vuejs/core/contents/package.json`;
	}
	if (source === "gitee") {
		const root = base(config.gitee.apiBase, GITEE_API_BASE);
		if (operation === "repo-search") return `${root}/search/repositories?${query}`;
		if (operation === "code-search") return `${root}/search/code?${query}`;
		return `${root}/repos/mirrors/vue/contents/README.md`;
	}
	if (operation === "code-search") return buildCsdnSearchUrl("vue", config.csdn.apiBase.length > 0 ? { apiBase: config.csdn.apiBase } : {});
	return "https://blog.csdn.net/";
}
/**
* The caller's own identity out of a `/user` payload.
*
* This is the ONE field from a credential check that may travel back: it says
* WHO the user is, never WHAT they hold. Parsing is guarded because a proxy or a
* captive portal can answer 200 with HTML.
*/
function accountFromUserPayload(body) {
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed;
		for (const candidate of [
			record.login,
			record.username,
			record.name
		]) if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
		return null;
	} catch {
		return null;
	}
}
/**
* Classify anything an adapter threw.
*
* Adapters are supposed to return failures as VALUES (see `sources/types.ts`),
* so reaching this function means one of them threw. The taxonomy value is
* recovered from `failure` / `kind` when present, exactly as
* `classifyTransportError()` does, so a bug in an adapter still produces a
* classifiable outcome instead of a raw exception in the model's face.
*/
function classifyAdapterThrow(error) {
	if (typeof error === "object" && error !== null) {
		const explicit = error;
		const candidate = explicit.failure ?? explicit.kind;
		if (typeof candidate === "string" && FAILURE_KIND_VALUES.includes(candidate)) return candidate;
	}
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError") return "timeout";
	return "network";
}
const FAILURE_KIND_VALUES = [
	"network",
	"timeout",
	"empty",
	"rate-limited",
	"auth-required",
	"parse-failed",
	"not-code"
];
function describeError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return String(error);
	} catch {
		return "无法读取的错误对象";
	}
}
//#endregion
//#region src/settings.ts
/** One line the UI can show when the profile-backed settings page is unavailable. */
const SETTINGS_FALLBACK_NOTE = "本插件的设置 namespace 不在 DSH settings RPC 的白名单里时，设置页会显示为不可用；配置面板与设置页组件都改走插件自己的 /api/dsh-codehub/config 路由读写，功能不受影响。";
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Wrap the optional `settings` service.
*
* `ctx.get('settings')` — never `ctx.settings`. Reading an un-injected service
* property throws on this runtime, and an exception thrown while mounting a
* plugin can take the whole install down with it.
*/
function createSettingsBridge(ctx) {
	const service = ctx.get("settings");
	const available = service !== void 0;
	function descriptorFor() {
		if (service === void 0) return void 0;
		try {
			const list = service.describe({ redactSecrets: true });
			if (!Array.isArray(list)) return void 0;
			return list.find((item) => item !== void 0 && item !== null && item.ns === "dsh-codehub");
		} catch {
			return;
		}
	}
	async function readSettings() {
		if (service === void 0) return {
			available: false,
			value: void 0,
			revision: void 0
		};
		const descriptor = descriptorFor();
		if (descriptor === void 0) return {
			available: false,
			value: void 0,
			revision: void 0,
			error: "settings 服务里没有 dsh-codehub 这个 namespace（可能不在 RPC 白名单内）。"
		};
		return {
			available: true,
			value: isRecord$2(descriptor.value) ? descriptor.value : void 0,
			revision: typeof descriptor.revision === "number" ? descriptor.revision : void 0
		};
	}
	return {
		available,
		configure() {
			if (service === void 0) return () => void 0;
			const configure = service.configure;
			if (typeof configure !== "function") return () => void 0;
			try {
				const dispose = configure.call(service, { auto: true });
				return typeof dispose === "function" ? () => {
					try {
						dispose();
					} catch {}
				} : () => void 0;
			} catch {
				return () => void 0;
			}
		},
		read: readSettings,
		async patch(patch) {
			if (service === void 0) return {
				ok: false,
				verified: false,
				error: "当前上下文没有 settings 服务。"
			};
			try {
				await service.update(SETTINGS_NAMESPACE, patch);
			} catch (error) {
				return {
					ok: false,
					verified: false,
					error: messageOf$1(error)
				};
			}
			const settled = await readSettings();
			if (!settled.available) return {
				ok: true,
				verified: false,
				...settled.error === void 0 ? {} : { error: settled.error }
			};
			const settledRaw = settled.value;
			if (!isRecord$2(settledRaw)) return {
				ok: true,
				verified: false,
				error: "settings 未返回可比较的快照，无法确认写入是否生效。"
			};
			const expected = mergeConfigInput(settled.value, patch);
			let matched = true;
			for (const [key, value] of Object.entries(expected)) {
				const actual = settledRaw[key];
				if (isRecord$2(value)) {
					if (!isRecord$2(actual)) {
						matched = false;
						break;
					}
					for (const [innerKey, innerValue] of Object.entries(value)) {
						if (innerValue === null || innerValue === void 0) continue;
						if (actual[innerKey] !== innerValue) {
							matched = false;
							break;
						}
					}
				} else if (value !== null && value !== void 0 && actual !== value) matched = false;
				if (!matched) break;
			}
			return matched ? {
				ok: true,
				verified: true
			} : {
				ok: true,
				verified: false,
				error: "settings 没有把本次修改持久化（namespace 可能存在但只读）。"
			};
		}
	};
}
//#endregion
//#region src/routes.ts
/** Request bodies are tiny (a patch or one credential); anything larger is refused. */
const MAX_BODY_BYTES = 65536;
/** The ten paths this plugin owns, all under `contract.API_PREFIX`. */
const ROUTE_PATHS = {
	config: `${API_PREFIX}/config`,
	decisions: `${API_PREFIX}/decisions`,
	detect: `${API_PREFIX}/detect`,
	credentials: `${API_PREFIX}/credentials`,
	deepread: `${API_PREFIX}/deepread`,
	smoke: `${API_PREFIX}/smoke`,
	oauth: `${API_PREFIX}/oauth`,
	/**
	* The OAuth callback is the SAME path the provider is told to redirect to, so
	* it is read from the contract instead of being re-spelled here — a mismatch
	* between the registered Gitee callback and the route would be invisible.
	*/
	oauthCallback: OAUTH_CALLBACK_PATH,
	probe: `${API_PREFIX}/probe`,
	cookies: `${API_PREFIX}/cookies`,
	/** Starts a debuggable Chromium when the CDP port is not listening yet. */
	launchBrowser: `${API_PREFIX}/launch-browser`
};
/**
* True only for a request that arrived over a loopback socket.
*
* `true` is not returned for an empty/unknown `remoteAddress`: failing closed is
* the whole point of the fence.
*/
function isLoopbackRequest(req) {
	const address = typeof req.socket?.remoteAddress === "string" ? req.socket.remoteAddress : "";
	if (address.length === 0) return false;
	if (address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1") return true;
	if (address.startsWith("127.")) return true;
	if (address.startsWith("::ffff:127.")) return true;
	return false;
}
function writeJson(res, status, payload) {
	let body;
	try {
		body = JSON.stringify(payload ?? null);
	} catch {
		body = JSON.stringify({
			ok: false,
			error: "响应无法序列化。"
		});
	}
	res.statusCode = status;
	try {
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
	} catch {}
	res.end(body);
}
function setAllowHeader(res, methods) {
	try {
		res.setHeader("allow", methods.join(", "));
	} catch {}
}
/**
* Read and parse a JSON body with a hard size cap.
*
* The raw text is never logged: a credential arrives this way.
*/
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	try {
		for await (const chunk of req) {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			total += buffer.length;
			if (total > 65536) return {
				ok: false,
				status: 413,
				error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。`
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			status: 400,
			error: "读取请求体失败。"
		};
	}
	if (total === 0) return {
		ok: true,
		status: 200,
		value: {}
	};
	try {
		return {
			ok: true,
			status: 200,
			value: JSON.parse(Buffer.concat(chunks).toString("utf8"))
		};
	} catch {
		return {
			ok: false,
			status: 400,
			error: "请求体不是合法 JSON。"
		};
	}
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Answer a browser with a page instead of JSON.
*
* Only the OAuth callback uses this, and the HTML is produced by the flow
* engine: it is a self-closing page that carries no credential (docs/DESIGN.md
* §7.3) — the code/state pair never travels back to the browser.
*/
function writeHtml(res, status, html) {
	res.statusCode = status;
	try {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.setHeader("cache-control", "no-store");
	} catch {}
	res.end(html);
}
function requestUrl(req) {
	try {
		return new URL(req.url ?? "/", "http://127.0.0.1");
	} catch {
		return new URL("http://127.0.0.1/");
	}
}
function messageOf(error) {
	return scrubSecrets(error instanceof Error ? error.message : String(error));
}
/**
* Wrap a handler with the two guards that must run first: loopback, then method.
*
* The order matters — a non-local caller must be rejected before its method (or
* its body) is even considered.
*/
function fenced(methods, handler) {
	return async (req, res) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (!methods.includes(method)) {
			setAllowHeader(res, methods);
			writeJson(res, 405, {
				error: "method not allowed",
				allow: methods
			});
			return;
		}
		try {
			await handler(req, res);
		} catch (error) {
			writeJson(res, 500, {
				ok: false,
				error: "internal error",
				detail: messageOf(error)
			});
		}
	};
}
/**
* Register every route and return ONE disposer.
*
* A duplicate `(kind, path)` throws on this runtime, so each registration is
* guarded individually: one failed path must not take the others down.
*/
function registerRoutes(deps) {
	const log = deps.logger ?? createConsoleLogger();
	const disposers = [];
	const routes = [
		{
			kind: "exact",
			path: ROUTE_PATHS.config,
			handler: fenced(["GET", "PATCH"], (req, res) => handleConfig(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.decisions,
			handler: fenced(["GET"], (req, res) => handleDecisions(deps, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.detect,
			handler: fenced(["GET"], (req, res) => handleDetect(deps, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.credentials,
			handler: fenced(["POST", "DELETE"], (req, res) => handleCredentials(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.deepread,
			handler: fenced(["POST"], (req, res) => handleDeepRead(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.smoke,
			handler: fenced(["POST"], (req, res) => handleSmoke(deps, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.oauth,
			handler: fenced([
				"GET",
				"POST",
				"DELETE"
			], (req, res) => handleOAuth(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.oauthCallback,
			handler: fenced(["GET"], (req, res) => handleOAuthCallback(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.probe,
			handler: fenced(["POST"], (req, res) => handleProbe(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.cookies,
			handler: fenced(["POST"], (req, res) => handleCookies(deps, req, res))
		},
		{
			kind: "exact",
			path: ROUTE_PATHS.launchBrowser,
			handler: fenced(["POST"], (req, res) => handleLaunchBrowser(deps, req, res))
		}
	];
	for (const route of routes) try {
		disposers.push(deps.webServer.register(route));
	} catch (error) {
		log("注册路由失败", {
			path: route.path,
			reason: messageOf(error)
		});
	}
	return () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
		disposers.length = 0;
	};
}
/** The config view both `GET` and `PATCH` answer with. */
async function configPayload(deps) {
	const view = await deps.service.describeConfig();
	return {
		ok: true,
		config: view.config,
		credentials: view.credentials,
		unresolved: view.decisions,
		decided: view.decided,
		limits: view.limits,
		transport: view.transport,
		notes: view.notes,
		paths: view.paths,
		login: view.login,
		labels: { sources: SOURCE_LABELS },
		settings: {
			available: deps.settings.available,
			note: SETTINGS_FALLBACK_NOTE
		}
	};
}
async function handleConfig(deps, req, res) {
	if ((req.method ?? "GET").toUpperCase() === "GET") {
		writeJson(res, 200, await configPayload(deps));
		return;
	}
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const split = splitConfigPatch(body.value);
	if (!split.ok) {
		writeJson(res, 400, {
			ok: false,
			error: split.error
		});
		return;
	}
	const warnings = [];
	if (split.rejected.length > 0) warnings.push(`已忽略本插件不接受的字段：${split.rejected.join("、")}。凭据请走 /credentials，不要写进配置。`);
	if (split.local.localProxy !== void 0) {
		const outcome = await deps.store.write({ localProxy: split.local.localProxy });
		if (!outcome.ok) {
			writeJson(res, 500, {
				ok: false,
				error: `本机代理地址写入失败：${outcome.error ?? "未知原因"}`
			});
			return;
		}
	}
	const hasSettingsPatch = Object.keys(split.settings).length > 0;
	let settingsVerified = false;
	let settingsError;
	if (hasSettingsPatch) {
		const written = await deps.settings.patch(split.settings);
		settingsVerified = written.ok && written.verified;
		settingsError = written.error;
	}
	if (hasSettingsPatch && !settingsVerified) {
		const snapshot = mergeConfigInput((await deps.store.read().catch(() => ({}))).fallbackConfig, split.settings);
		const outcome = await deps.store.write({ fallbackConfig: snapshot });
		if (!outcome.ok) {
			writeJson(res, 500, {
				ok: false,
				error: `配置回退快照写入失败：${outcome.error ?? "未知原因"}`
			});
			return;
		}
		if (settingsError !== void 0 && settingsError.length > 0) warnings.push(settingsError);
		warnings.push("settings 未确认本次写入，已把配置存进 $DSH_HOME/dsh-codehub.json（0600）作为回退，功能不受影响。");
	}
	writeJson(res, 200, {
		...await configPayload(deps),
		warnings
	});
}
async function handleDecisions(deps, res) {
	const unresolved = await deps.service.getUnresolved();
	const state = await deps.service.resolve();
	const decided = {};
	for (const key of DECISION_KEYS) decided[key] = !unresolved.some((item) => item.key === key);
	writeJson(res, 200, {
		ok: true,
		unresolved,
		ask_user: decisionPrompt(unresolved),
		decided,
		decisionState: {
			sourcePriority: state.sourcePriority,
			githubAccessPriority: state.github.accessPriority,
			failoverEnabled: state.failover.enabled === void 0 ? null : state.failover.enabled,
			mergeSources: state.mergeSources === void 0 ? null : state.mergeSources
		}
	});
}
async function handleDetect(deps, res) {
	writeJson(res, 200, {
		ok: true,
		...await detectEnvironment({ localProxy: (await deps.service.resolve()).github.localProxy }),
		store: deps.store.filePath
	});
}
async function handleCredentials(deps, req, res) {
	const credentials = deps.ctx.get("credentials");
	if (credentials === void 0) {
		writeJson(res, 503, {
			ok: false,
			error: "credentials-service-unavailable"
		});
		return;
	}
	const method = (req.method ?? "POST").toUpperCase();
	const query = requestUrl(req);
	const body = method === "DELETE" ? {
		ok: true,
		status: 200,
		value: {}
	} : await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const rawSource = typeof record.source === "string" ? record.source.trim() : query.searchParams.get("source") ?? "";
	if (!CREDENTIAL_TARGETS.includes(rawSource)) {
		writeJson(res, 400, {
			ok: false,
			error: "`source` 必须是 github / gitee / csdn 之一。"
		});
		return;
	}
	const ref = CREDENTIAL_REFS[rawSource];
	if (method === "POST") {
		const kind = typeof record.kind === "string" ? record.kind.trim() : "token";
		if (kind !== "token" && kind !== "cookie") {
			writeJson(res, 400, {
				ok: false,
				error: "`kind` 只能是 token 或 cookie。"
			});
			return;
		}
		const value = record.value;
		if (typeof value !== "string" || value.trim().length === 0) {
			writeJson(res, 400, {
				ok: false,
				error: "`value` 必须是非空字符串。"
			});
			return;
		}
		try {
			await credentials.set(ref, value);
		} catch (error) {
			writeJson(res, 500, {
				ok: false,
				error: `写入凭据失败：${messageOf(error)}`
			});
			return;
		}
	} else try {
		await credentials.unset(ref);
	} catch (error) {
		writeJson(res, 500, {
			ok: false,
			error: `清除凭据失败：${messageOf(error)}`
		});
		return;
	}
	writeJson(res, 200, {
		ok: true,
		credentials: await deps.service.credentialStatus()
	});
}
async function handleDeepRead(deps, req, res) {
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const raw = typeof record.url === "string" ? record.url.trim() : "";
	if (raw.length === 0) {
		writeJson(res, 400, {
			ok: false,
			error: "`url` 必填。"
		});
		return;
	}
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		writeJson(res, 400, {
			ok: false,
			error: "`url` 不是合法地址。"
		});
		return;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		writeJson(res, 400, {
			ok: false,
			error: "只接受 http / https 地址。"
		});
		return;
	}
	let targets;
	if (Array.isArray(record.targets)) {
		targets = [];
		for (const item of record.targets) if (typeof item === "string" && DEEP_READ_TARGETS.includes(item)) targets.push(item);
	}
	const unresolved = await deps.service.getUnresolved();
	if (unresolved.length > 0) {
		writeJson(res, 409, {
			ok: false,
			error: "尚有决策点未确认，未发起任何网络请求。",
			unresolved,
			ask_user: decisionPrompt(unresolved)
		});
		return;
	}
	const notes = await deps.service.deepRead(raw, targets);
	writeJson(res, 200, {
		ok: true,
		url: raw,
		notes,
		reason: notes.length > 0 ? "" : "没有产出笔记：可能未选择深度阅读目标、该源不支持深读，或抓取失败。"
	});
}
async function handleSmoke(deps, res) {
	writeJson(res, 200, await deps.service.smoke());
}
/** Only these two sources have an OAuth flow; CSDN has none, by design. */
const OAUTH_SOURCES = ["github", "gitee"];
function isOAuthSource(value) {
	return typeof value === "string" && OAUTH_SOURCES.includes(value);
}
/** The single method each source has in the contract's login vocabulary. */
const OAUTH_METHOD_FOR = {
	github: "oauth-device",
	gitee: "oauth-code"
};
function isOAuthMethod(value) {
	return value === "oauth-device" || value === "oauth-code";
}
/** Read one optional string field out of a request body. */
function bodyString(body, key) {
	const value = body[key];
	return typeof value === "string" ? value.trim() : "";
}
/**
* The Gitee client secret, straight out of the credential service.
*
* It is resolved HERE, used for one exchange, and never stored on the flow
* record nor echoed (docs/DESIGN.md §7.3). A body-supplied secret is accepted as
* a fallback only because the panel may collect one before it is saved — it is
* treated exactly like the stored one: used, never logged, never returned.
*/
async function readGiteeSecret(deps) {
	const credentials = deps.ctx.get("credentials");
	if (credentials === void 0) return void 0;
	try {
		const value = (await credentials.resolve(GITEE_OAUTH_SECRET_REF))?.value;
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
	} catch {
		return;
	}
}
/** `http://<host><OAUTH_CALLBACK_PATH>` — the loopback default Gitee registers. */
function deriveRedirectUri(req) {
	return `http://${typeof req.headers?.host === "string" && req.headers.host.trim().length > 0 ? req.headers.host.trim() : "127.0.0.1"}${OAUTH_CALLBACK_PATH}`;
}
async function handleOAuth(deps, req, res) {
	const oauth = deps.oauth;
	if (oauth === void 0) {
		writeJson(res, 503, {
			ok: false,
			error: "oauth-engine-unavailable"
		});
		return;
	}
	const method = (req.method ?? "GET").toUpperCase();
	const query = requestUrl(req);
	if (method === "GET") {
		const flowId = query.searchParams.get("flowId")?.trim() ?? "";
		if (flowId.length === 0) {
			writeJson(res, 400, {
				ok: false,
				error: "`flowId` 必填。"
			});
			return;
		}
		const status = await oauth.status(flowId);
		writeJson(res, 200, {
			ok: true,
			flowId: status.flowId,
			status: status.state,
			reason: status.reason,
			interval: status.intervalMs,
			credentialConfigured: status.credentialConfigured
		});
		return;
	}
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const action = method === "DELETE" ? "cancel" : bodyString(record, "action") || "start";
	const config = await deps.service.resolve();
	if (action === "cancel") {
		const flowId = bodyString(record, "flowId") || (query.searchParams.get("flowId") ?? "").trim();
		if (flowId.length === 0) {
			writeJson(res, 400, {
				ok: false,
				error: "`flowId` 必填。"
			});
			return;
		}
		oauth.cancel(flowId);
		const settled = await oauth.status(flowId);
		writeJson(res, 200, {
			ok: true,
			flowId,
			status: settled.state,
			reason: settled.reason,
			interval: settled.intervalMs,
			credentialConfigured: settled.credentialConfigured
		});
		return;
	}
	if (action === "complete") {
		const code = bodyString(record, "code");
		if (code.length === 0) {
			writeJson(res, 400, {
				ok: false,
				error: "`code` 必填。"
			});
			return;
		}
		const clientId = bodyString(record, "clientId") || config.gitee.oauthClientId;
		const clientSecret = await readGiteeSecret(deps) ?? bodyString(record, "clientSecret");
		const redirectUri = bodyString(record, "redirectUri") || config.gitee.oauthRedirectUri || deriveRedirectUri(req);
		const outcome = await oauth.completeWithCode({
			code,
			clientId,
			...clientSecret.length === 0 ? {} : { clientSecret },
			redirectUri
		});
		writeJson(res, 200, {
			ok: outcome.ok,
			status: outcome.ok ? "done" : "error",
			reason: outcome.reason,
			interval: 0,
			credentialConfigured: outcome.credentialConfigured
		});
		return;
	}
	if (action !== "start") {
		writeJson(res, 400, {
			ok: false,
			error: "`action` 只能是 start / cancel / complete。"
		});
		return;
	}
	const source = record["source"];
	if (!isOAuthSource(source)) {
		writeJson(res, 400, {
			ok: false,
			error: "`source` 只能是 github 或 gitee（CSDN 没有 OAuth）。"
		});
		return;
	}
	const requestedMethod = record["method"];
	const sourceMethod = OAUTH_METHOD_FOR[source];
	if (requestedMethod !== void 0 && !isOAuthMethod(requestedMethod)) {
		writeJson(res, 400, {
			ok: false,
			error: "`method` 只能是 oauth-device 或 oauth-code。"
		});
		return;
	}
	if (isOAuthMethod(requestedMethod) && requestedMethod !== sourceMethod) {
		writeJson(res, 400, {
			ok: false,
			error: `不支持的方法组合：${SOURCE_LABELS[source]} 只能用 ${sourceMethod}（可用方法：${SOURCE_LOGIN_METHODS[source].join(" / ")}）。`
		});
		return;
	}
	const clientId = bodyString(record, "clientId") || (source === "github" ? config.github.oauthClientId : config.gitee.oauthClientId);
	if (clientId.length === 0) {
		writeJson(res, 400, {
			ok: false,
			error: source === "github" ? "尚未配置 github.oauthClientId：请先在 GitHub 建一个 OAuth App 并勾选 Enable Device Flow，把 Client ID 填进设置（或改用 PAT 粘贴）。" : "尚未配置 gitee.oauthClientId：请先在 Gitee 建第三方应用并把 Client ID 填进设置（或改用 PAT 粘贴）。"
		});
		return;
	}
	const secret = source === "gitee" ? await readGiteeSecret(deps) ?? bodyString(record, "clientSecret") : "";
	const redirectUri = source === "gitee" ? bodyString(record, "redirectUri") || config.gitee.oauthRedirectUri || deriveRedirectUri(req) : "";
	const requestHost = typeof req.headers?.host === "string" ? req.headers.host : "";
	const started = await oauth.start({
		source,
		method: sourceMethod,
		clientId,
		...secret.length === 0 ? {} : { clientSecret: secret },
		...redirectUri.length === 0 ? {} : { redirectUri },
		...requestHost.length === 0 ? {} : { requestHost }
	});
	if (started.ok === false) {
		writeJson(res, 200, {
			ok: false,
			status: "error",
			reason: `${started.reason} 仍可用的方式：${started.fallback.join(" / ")}。`,
			interval: 0,
			credentialConfigured: false
		});
		return;
	}
	if (started.kind === "device") {
		writeJson(res, 200, {
			ok: true,
			kind: "device",
			flowId: started.flowId,
			userCode: started.userCode,
			verificationUri: started.verificationUri,
			expiresIn: started.expiresInMs,
			interval: started.intervalMs,
			status: "pending",
			reason: "",
			credentialConfigured: false
		});
		return;
	}
	writeJson(res, 200, {
		ok: true,
		kind: "redirect",
		flowId: started.flowId,
		verificationUri: started.authorizeUrl,
		expiresIn: started.expiresInMs,
		interval: 0,
		status: "pending",
		reason: "",
		credentialConfigured: false
	});
}
async function handleOAuthCallback(deps, req, res) {
	const oauth = deps.oauth;
	if (oauth === void 0) {
		writeJson(res, 503, {
			ok: false,
			error: "oauth-engine-unavailable"
		});
		return;
	}
	const query = requestUrl(req);
	const params = {};
	for (const key of [
		"code",
		"state",
		"error"
	]) {
		const value = query.searchParams.get(key);
		if (value !== null) params[key] = value;
	}
	const outcome = await oauth.handleCallback(params);
	writeHtml(res, outcome.status, outcome.html);
}
async function handleProbe(deps, req, res) {
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const rawSource = bodyString(record, "source");
	if (rawSource.length > 0 && !SOURCES.includes(rawSource)) {
		writeJson(res, 400, {
			ok: false,
			error: "`source` 只能是 github / gitee / csdn 之一。"
		});
		return;
	}
	const useStoredCredential = record["useStoredCredential"] === true;
	if (rawSource.length > 0) {
		writeJson(res, 200, {
			ok: true,
			report: await deps.service.probe({
				source: rawSource,
				useStoredCredential
			})
		});
		return;
	}
	const reports = [];
	for (const source of SOURCES) reports.push(await deps.service.probe({
		source,
		useStoredCredential
	}));
	writeJson(res, 200, {
		ok: true,
		reports
	});
}
async function handleCookies(deps, req, res) {
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const config = await deps.service.resolve();
	if (config.csdn.cdpEnabled !== true) {
		writeJson(res, 403, {
			ok: false,
			error: "CSDN 的 CDP 抓取未启用（csdn.cdpEnabled = false）。它需要你显式开启，因为浏览器调试端口对本机任何进程开放。"
		});
		return;
	}
	if (record["consent"] !== true) {
		writeJson(res, 403, {
			ok: false,
			error: "缺少 consent: true。读取浏览器 cookie 需要你在界面上主动确认，本插件不会默认执行。"
		});
		return;
	}
	const credentials = deps.ctx.get("credentials");
	if (credentials === void 0) {
		writeJson(res, 503, {
			ok: false,
			error: "credentials-service-unavailable"
		});
		return;
	}
	const requestedPort = record["port"];
	const port = typeof requestedPort === "number" && Number.isFinite(requestedPort) ? Math.min(Math.max(Math.floor(requestedPort), 1), 65535) : config.csdn.cdpPort;
	const result = await (deps.captureCookies ?? captureBrowserCookies)({
		port,
		origins: CDP_COOKIE_HOSTS,
		consent: true,
		timeoutMs: Math.min(config.limits.timeoutMs, 1e4)
	});
	if (result.ok === false) {
		writeJson(res, result.failure === "consent-required" ? 403 : 502, {
			ok: false,
			error: result.reason
		});
		return;
	}
	try {
		await credentials.set(CREDENTIAL_REFS.csdn, result.cookieHeader);
	} catch (error) {
		writeJson(res, 500, {
			ok: false,
			error: `写入 CSDN cookie 失败：${messageOf(error)}`
		});
		return;
	}
	writeJson(res, 200, {
		ok: true,
		count: result.names.length,
		names: [...result.names],
		hosts: [...result.hosts],
		reason: `已把 ${result.names.length} 个 cookie 交给凭据服务；这里只回显名称，值不会离开凭据服务。`
	});
}
/**
* `POST /launch-browser` — start a debuggable Chromium when the port is silent.
*
* SAME TWO GATES AS `/cookies`, for the same reason: starting a browser whose
* debug port is open is the risky act, so it needs the feature switched on AND an
* explicit `consent: true` in the request. The response carries the loopback
* `webSocketDebuggerUrl` (not a secret) and never any credential.
*/
async function handleLaunchBrowser(deps, req, res) {
	const launcher = deps.launcher;
	if (launcher === void 0) {
		writeJson(res, 503, {
			ok: false,
			error: "launcher-unavailable"
		});
		return;
	}
	const body = await readJsonBody(req);
	if (!body.ok) {
		writeJson(res, body.status, {
			ok: false,
			error: body.error
		});
		return;
	}
	const record = isRecord$1(body.value) ? body.value : {};
	const config = await deps.service.resolve();
	if (config.csdn.cdpEnabled !== true) {
		writeJson(res, 403, {
			ok: false,
			error: "CSDN 的 CDP 抓取未启用（csdn.cdpEnabled = false）。先打开它，再启动调试浏览器。"
		});
		return;
	}
	if (record["consent"] !== true) {
		writeJson(res, 403, {
			ok: false,
			error: "缺少 consent: true。启动一个开着调试端口的浏览器需要你主动确认。"
		});
		return;
	}
	const requestedPort = record["port"];
	const port = typeof requestedPort === "number" && Number.isFinite(requestedPort) ? Math.min(Math.max(Math.floor(requestedPort), 1), 65535) : config.csdn.cdpPort;
	const requestedUrl = typeof record["url"] === "string" ? record["url"].trim() : "";
	const browserId = typeof record["browserId"] === "string" ? record["browserId"].trim() : "";
	const result = await launcher.launch({
		port,
		...requestedUrl.length === 0 ? {} : { url: requestedUrl },
		...browserId.length === 0 ? {} : { browserId }
	});
	if (result.ok === false) {
		writeJson(res, result.failure === "bad-port" ? 400 : 502, {
			ok: false,
			error: result.reason,
			failure: result.failure,
			...result.searched === void 0 ? {} : { searched: [...result.searched] }
		});
		return;
	}
	writeJson(res, 200, {
		ok: true,
		launched: result.launched,
		port: result.port,
		userDataDir: result.userDataDir,
		debuggerUrl: result.debuggerUrl,
		...result.browser === null ? {} : { browser: {
			id: result.browser.id,
			label: result.browser.label
		} },
		reason: result.reason
	});
}
//#endregion
//#region src/tool.ts
/**
* The tool description.
*
* Composed from the contract clause; the surrounding sentences only explain the
* decision gate and the note-shaped output, they do not restate the boundary.
*/
const LEARN_CODE_TOOL_DESCRIPTION = "检索 GitHub / Gitee / CSDN 上的代码用法，并提炼「实现思路 / API 用法 / 取舍 / 踩坑」四类要点；也可对单个仓库做深度阅读，产出思路笔记。仅用于学习用法，不返回可直接粘贴的代码交付物。本插件是「代码用法学习源」，不是代码搬运器。通过本插件拿到的结果只能用于：总结实现思路、提炼 API 用法、对比不同实现取舍、记录踩坑笔记。严禁把远端抓到的代码片段原样粘贴进用户项目，不允许生成「直接抄来的函数 / 文件」作为交付物。若用户确实需要某段逻辑，只能基于学到的思路、按用户项目既有风格重新手写，并主动说明「这是参考 <来源 URL> 思路重写的，非直接复制」。返回结构中的 is_verbatim_copy 恒为 false，code 字段仅作学习参考展示，不得作为交付物转述。未确认的决策点（源优先级、GitHub 访问方式、失败降级、多源合并）会让本工具直接拒绝执行：此时不发起任何网络请求，只返回要转述给用户的问题。";
const PARAM_PROPERTIES = {
	query: {
		type: "string",
		description: "要学习的主题、API 名称或问题，例如「cordis service 生命周期」或「undici proxy agent」。"
	},
	sources: {
		type: "array",
		items: {
			type: "string",
			enum: SOURCES
		},
		description: "可选：只查这些源，并以此顺序优先（仍受用户配置的源优先级约束）。省略 = 按用户配置的顺序查全部源。"
	},
	deepRead: {
		type: "boolean",
		description: "是否对命中的仓库做深度阅读，产出思路笔记 LearnNote（不是文件副本）。需要用户已选择深度阅读目标。"
	},
	maxItems: {
		type: "integer",
		description: `本次最多返回多少条。省略 = 用户配置值；再大也不会超过硬顶 ${HARD_LIMITS.maxItems}。`
	}
};
/** The compiled `parameters` schema. See the section header for why it is raw. */
const LEARN_CODE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: [...["query"]],
	properties: PARAM_PROPERTIES
};
TOOL_PARAMS.filter((name) => name in PARAM_PROPERTIES);
function readArgs(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("dsh-codehub: 工具入参必须是一个对象。");
	const record = raw;
	const query = record.query;
	if (typeof query !== "string" || query.trim().length === 0) throw new Error("dsh-codehub: 缺少必填参数 `query`（非空字符串）。");
	let sources;
	const rawSources = record.sources;
	if (rawSources !== void 0 && rawSources !== null) {
		if (!Array.isArray(rawSources)) throw new Error("dsh-codehub: `sources` 必须是数组。");
		sources = [];
		for (const item of rawSources) {
			if (typeof item !== "string" || !SOURCES.includes(item)) throw new Error(`dsh-codehub: \`sources\` 只接受 ${SOURCES.join(" / ")}，收到 ${String(item)}。`);
			const id = item;
			if (!sources.includes(id)) sources.push(id);
		}
	}
	const rawDeepRead = record.deepRead;
	if (rawDeepRead !== void 0 && rawDeepRead !== null && typeof rawDeepRead !== "boolean") throw new Error("dsh-codehub: `deepRead` 必须是布尔值。");
	let maxItems;
	const rawMaxItems = record.maxItems;
	if (rawMaxItems !== void 0 && rawMaxItems !== null) {
		if (typeof rawMaxItems !== "number" || !Number.isFinite(rawMaxItems) || rawMaxItems < 1) throw new Error("dsh-codehub: `maxItems` 必须是 ≥ 1 的整数。");
		maxItems = Math.min(Math.floor(rawMaxItems), HARD_LIMITS.maxItems);
	}
	return {
		query: query.trim(),
		...sources === void 0 ? {} : { sources },
		...typeof rawDeepRead === "boolean" ? { deepRead: rawDeepRead } : {},
		...maxItems === void 0 ? {} : { maxItems }
	};
}
/** Property names marked `required` in a local property record. */
function requiredNames(properties) {
	return Object.entries(properties).filter(([, spec]) => spec.required === true).map(([key]) => key);
}
/**
* Strip the internal `required` marker from every property spec.
*
* The marker must NOT reach the runtime: `required` on a property of an
* `output.schema` is the exact construct the validator rejects. It is only ever
* read back by `requiredNames()`.
*/
function stripRequired(properties) {
	return Object.fromEntries(Object.entries(properties).map(([key, spec]) => {
		const { required: _marker, ...rest } = spec;
		return [key, rest];
	}));
}
/** Build one object schema with `required` hoisted to the array form. */
function objectSchema(properties) {
	return {
		type: "object",
		additionalProperties: false,
		required: requiredNames(properties),
		properties: stripRequired(properties)
	};
}
const RESULT_SCHEMA = objectSchema({
	source: {
		type: "string",
		enum: SOURCES,
		required: true,
		description: "命中的源。"
	},
	url: {
		type: "string",
		required: true,
		description: "可直接打开的来源地址。"
	},
	title: {
		type: "string",
		required: true
	},
	language: {
		type: "string",
		required: true,
		description: "识别到的语言；未知时为空字符串。"
	},
	code: {
		type: "string",
		required: true,
		description: `仅作学习参考的节选，首行固定是「${LEARNING_ONLY_BANNER}」，长度不超过用户配置的 maxCodeChars。`
	},
	codeTruncated: {
		type: "boolean",
		required: true,
		description: "节选是否因超限被截断。"
	},
	learned_summary: {
		type: "string",
		required: true,
		description: "提炼出的思路 / 用法 / 取舍 / 坑。不是代码的改写。"
	},
	is_verbatim_copy: {
		type: "boolean",
		required: true,
		const: false,
		description: "结构上恒为 false：本工具不存在「返回可直接粘贴的代码」这种结果。"
	},
	stars: {
		oneOf: [{ type: "integer" }, { type: "null" }],
		required: true,
		description: "来源给出的星标数，未知时 null。"
	},
	updatedAt: {
		oneOf: [{ type: "string" }, { type: "null" }],
		required: true,
		description: "ISO-8601 更新时间，未知时 null。"
	},
	confidence: {
		type: "string",
		enum: CONFIDENCE_LEVELS,
		required: true
	},
	reason: {
		type: "string",
		required: true,
		description: "这一条为什么出现、置信度为什么是这样。"
	}
});
const NOTE_SCHEMA = objectSchema({
	url: {
		type: "string",
		required: true
	},
	title: {
		type: "string",
		required: true
	},
	approach: {
		type: "string",
		required: true,
		description: "实现思路（散文），不是源码。"
	},
	apiContract: {
		type: "array",
		required: true,
		items: { type: "string" }
	},
	tradeoffs: {
		type: "array",
		required: true,
		items: { type: "string" }
	},
	pitfalls: {
		type: "array",
		required: true,
		items: { type: "string" }
	},
	sourceUrls: {
		type: "array",
		required: true,
		items: { type: "string" },
		description: "每条结论的来源地址，保持可追溯。"
	}
});
const FAILURE_SCHEMA = objectSchema({
	source: {
		type: "string",
		enum: SOURCES,
		required: true
	},
	kind: {
		type: "string",
		enum: FAILURE_KINDS,
		required: true
	},
	reason: {
		type: "string",
		required: true
	}
});
const DECISION_SCHEMA = objectSchema({
	key: {
		type: "string",
		enum: DECISION_KEYS,
		required: true
	},
	detail: {
		type: "string",
		required: true
	},
	ask: {
		type: "string",
		required: true,
		description: "可以直接转述给用户的问题。"
	},
	control: {
		type: "string",
		required: true,
		description: "告诉用户去哪里点。"
	}
});
const LEARN_CODE_OUTPUT_SCHEMA = objectSchema({
	ok: {
		type: "boolean",
		required: true,
		description: "false = 业务性拒绝（未决策 / 已禁用 / 无结果），详见 reason 与 ask_user。"
	},
	query: {
		type: "string",
		required: true
	},
	results: {
		type: "array",
		required: true,
		items: RESULT_SCHEMA
	},
	notes: {
		type: "array",
		required: true,
		items: NOTE_SCHEMA,
		description: "深度阅读产出的思路笔记（可能为空）。"
	},
	failures: {
		type: "array",
		required: true,
		items: FAILURE_SCHEMA,
		description: "每个失败源及其分类。"
	},
	unresolved_decisions: {
		type: "array",
		required: true,
		items: DECISION_SCHEMA,
		description: "未确认的决策点；非空时 ok 必为 false，且未发起任何网络请求。"
	},
	ask_user: {
		type: "string",
		required: true,
		description: "要转述给用户的问题；ok 为 true 时是空字符串。"
	},
	reason: {
		type: "string",
		required: true
	},
	degraded: {
		type: "boolean",
		required: true,
		description: "是否因用户已同意自动降级而切换过源。"
	},
	merged: {
		type: "boolean",
		required: true,
		description: "结果是否来自多源合并去重。"
	},
	sources_queried: {
		type: "array",
		required: true,
		items: {
			type: "string",
			enum: SOURCES
		}
	},
	deep_read: {
		type: "boolean",
		required: true,
		description: "本次是否真的产出了深度阅读笔记。"
	}
});
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/** Every block carries the banner, so no fragment can be shown without it. */
function bannerBlock(body) {
	return {
		type: "text",
		text: `${LEARNING_ONLY_BANNER}\n${body}`
	};
}
function stripBanner(code) {
	if (!code.startsWith("【仅学习参考 · 不得直接粘贴进用户项目】")) return code;
	return code.slice(21).replace(/^\n/, "");
}
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
function textOf(value) {
	return typeof value === "string" ? value : "";
}
function renderOutcome(rawValue) {
	if (!isRecord(rawValue)) return [bannerBlock("工具没有返回结果对象。请重试；若持续出现，请检查 host 侧日志。")];
	const ok = rawValue.ok === true;
	const results = asArray(rawValue.results);
	const failures = asArray(rawValue.failures);
	const decisions = asArray(rawValue.unresolved_decisions);
	const notes = asArray(rawValue.notes);
	const queried = asArray(rawValue.sources_queried).map((item) => textOf(item)).filter((item) => item.length > 0);
	const blocks = [];
	const header = [
		`query: ${textOf(rawValue.query)}`,
		`ok: ${ok ? "true" : "false"}`,
		`已查询：${queried.length > 0 ? queried.map((id) => labelOf(id)).join(" → ") : "（无）"}`
	];
	if (failures.length > 0) header.push(`失败：${failures.map((item) => `${labelOf(textOf(item.source))}=${textOf(item.kind)}`).join("、")}`);
	if (rawValue.degraded === true) header.push("已按用户设置自动降级到下一个源。");
	if (rawValue.reason !== void 0) header.push(`说明：${textOf(rawValue.reason)}`);
	blocks.push(bannerBlock(header.join("\n")));
	results.forEach((item, index) => {
		if (!isRecord(item)) return;
		const meta = [
			textOf(item.language).length > 0 ? textOf(item.language) : "语言未知",
			typeof item.stars === "number" ? `${item.stars} stars` : "stars 未知",
			textOf(item.updatedAt).length > 0 ? `更新于 ${textOf(item.updatedAt)}` : "更新时间未知",
			`置信度 ${textOf(item.confidence)}`
		].join(" · ");
		const body = [
			`[${index + 1}/${results.length}] ${labelOf(textOf(item.source))} · ${textOf(item.title)}`,
			textOf(item.url),
			meta,
			`思路：${textOf(item.learned_summary)}`,
			`代码节选（仅学习参考，禁止直接粘贴进用户项目${item.codeTruncated === true ? "，已截断" : ""}）：`,
			stripBanner(textOf(item.code)),
			`判定理由：${textOf(item.reason)}`
		].join("\n");
		blocks.push(bannerBlock(body));
	});
	if (decisions.length > 0) {
		const body = ["本工具现在拒绝执行，并且没有发起任何网络请求。请先把下面的问题问用户：", ...decisions.map((item) => `- ${textOf(item.ask)}（设置位置：${textOf(item.control)}；缺什么：${textOf(item.detail)}）`)].join("\n");
		blocks.push(bannerBlock(body));
	} else if (!ok) {
		const ask = textOf(rawValue.ask_user);
		blocks.push(bannerBlock(ask.length > 0 ? `需要用户确认：${ask}` : "本次未得到可用结果，请调整关键词或访问方式后重试。"));
	}
	if (notes.length > 0) {
		const body = notes.map((note, index) => {
			const lines = [`[笔记 ${index + 1}/${notes.length}] ${textOf(note.title)}`, textOf(note.url)];
			if (textOf(note.approach).length > 0) lines.push(`思路：${textOf(note.approach)}`);
			const sections = [
				["API 契约", note.apiContract],
				["取舍", note.tradeoffs],
				["坑", note.pitfalls],
				["来源", note.sourceUrls]
			];
			for (const [label, value] of sections) {
				const items = asArray(value).map((item) => textOf(item)).filter((item) => item.length > 0);
				if (items.length > 0) lines.push(`${label}：${items.join("；")}`);
			}
			return lines.join("\n");
		}).join("\n\n");
		blocks.push(bannerBlock(body));
	}
	return blocks;
}
function labelOf(source) {
	if (source === "github" || source === "gitee" || source === "csdn") return SOURCE_LABELS[source];
	return source;
}
function refusalOutcome(query, reason, askUser) {
	return {
		ok: false,
		query,
		results: [],
		notes: [],
		failures: [],
		unresolved_decisions: [],
		ask_user: askUser,
		reason,
		degraded: false,
		merged: false,
		sources_queried: [],
		deep_read: false
	};
}
/**
* Build the tool definition.
*
* The timeout is composed with `AbortSignal.any([exec.signal, AbortSignal.timeout(limits.timeoutMs)])`
* (see `composeSignal`), so a caller cancellation and our own budget both stop
* the request, and the definition-level `timeoutMs` is only the contract's hard
* cap — a backstop, never a tighter bound than the user's own setting.
*/
function buildLearnCodeTool(deps = {}) {
	return {
		name: TOOL_NAME,
		description: LEARN_CODE_TOOL_DESCRIPTION,
		parameters: LEARN_CODE_PARAMETERS,
		timeoutMs: HARD_LIMITS.timeoutMs,
		output: {
			schema: LEARN_CODE_OUTPUT_SCHEMA,
			render: (_args, value) => renderOutcome(value)
		},
		execute: async (rawArgs, exec) => {
			const args = readArgs(rawArgs);
			const service = deps.service;
			if (service === void 0) throw new Error("dsh-codehub: codeSource 服务尚未挂载，无法执行查询。");
			const limits = deps.getLimits?.() ?? { timeoutMs: HARD_LIMITS.timeoutMs };
			const signal = composeSignal([exec?.signal, timeoutSignal(limits.timeoutMs)]);
			try {
				return await service.search(args.query, {
					...args.sources === void 0 ? {} : { sources: args.sources },
					...args.deepRead === void 0 ? {} : { deepRead: args.deepRead },
					...args.maxItems === void 0 ? {} : { maxItems: args.maxItems },
					...signal === void 0 ? {} : { signal }
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return refusalOutcome(args.query, `查询过程中出错：${detail}`, "这次查询失败了。要我换个关键词或访问方式再试一次吗？");
			}
		}
	};
}
/**
* A ready-made instance for import-time inspection (tests read `description`).
* Its `execute` refuses because no service is wired — which is exactly the
* "caller used it wrongly" path and therefore a throw, not a silent no-op.
*/
const LEARN_CODE_TOOL = buildLearnCodeTool();
//#endregion
//#region src/index.ts
/** `Symbol.for`, so the marker is shared even if the module is loaded twice. */
const MOUNT_KEY = Symbol.for("dsh-codehub.mounted");
/** `globalThis` viewed as a symbol-keyed registry. */
const registry = globalThis;
/** Diagnostics: is this plugin currently mounted in this process? */
function isMounted() {
	return registry[MOUNT_KEY] !== void 0;
}
/**
* Mount the plugin.
*
* @param ctx   the Cordis context (services reached with `ctx.get`, never as
*              properties — an un-injected service property throws here).
* @param config the resolved configuration; every field is optional, and the
*              four decisions are deliberately absent until the user answers.
*/
function apply(ctx, config = {}) {
	const log = createConsoleLogger();
	const previous = registry[MOUNT_KEY];
	if (previous !== void 0) {
		try {
			previous.dispose();
		} catch {}
		delete registry[MOUNT_KEY];
	}
	const mount = mountAll(ctx, config, log);
	registry[MOUNT_KEY] = mount;
	log("已挂载", {
		plugin: PACKAGE_NAME,
		enabled: config.enabled !== false
	});
}
function mountAll(ctx, config, log) {
	const disposers = [];
	/** One `ctx.effect` group. A failure is logged, never thrown. */
	function group(label, body) {
		try {
			const dispose = ctx.effect(body, label);
			if (typeof dispose === "function") disposers.push(dispose);
		} catch (error) {
			log("挂载分组失败", {
				group: label,
				reason: describe(error)
			});
		}
	}
	const tools = ctx.get("tools");
	const webServer = ctx.get("webServer");
	const systemPrompt = ctx.get("systemPrompt");
	const web = ctx.get("web");
	const store = new LocalConfigStore();
	const settings = createSettingsBridge(ctx);
	const getConfig = () => config;
	let service;
	const currentService = () => service;
	let oauth;
	try {
		oauth = createOAuthService({
			post: buildPostTransport(config, store, log),
			writeCredential: async (ref, value) => {
				const credentials = ctx.get("credentials");
				if (credentials === void 0) throw new Error("credentials 服务不可用，无法保存登录结果。");
				await credentials.set(ref, value);
			},
			readCredential: async (ref) => {
				const credentials = ctx.get("credentials");
				if (credentials === void 0) return void 0;
				try {
					const value = (await credentials.resolve(ref))?.value;
					return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
				} catch {
					return;
				}
			},
			credentialRefFor: (source) => CREDENTIAL_REFS[source],
			probeHost: probeProviderHost,
			logger: log
		});
	} catch (error) {
		oauth = void 0;
		log("OAuth 引擎构造失败，/oauth 路由将返回 503", { reason: describe(error) });
	}
	let launcher;
	try {
		launcher = createBrowserLauncher({});
	} catch (error) {
		launcher = void 0;
		log("浏览器 launcher 构造失败，/launch-browser 将返回 503", { reason: describe(error) });
	}
	group("dsh-codehub: service", () => {
		service = new CodeSource(ctx, {
			getConfig,
			store,
			settings,
			logger: log,
			...web === void 0 ? {} : { web }
		});
		log("codeSource 服务已注册", { sources: SOURCES.length });
		return () => {
			service = void 0;
		};
	});
	group("dsh-codehub: tool", () => {
		if (tools === void 0) {
			log("tools 服务不可用，未注册 learn_code_from_web");
			return;
		}
		const definition = buildLearnCodeTool({
			get service() {
				return currentService();
			},
			getLimits: () => currentService()?.getLimits() ?? { timeoutMs: HARD_LIMITS.timeoutMs }
		});
		const dispose = tools.register(definition);
		log("工具已注册");
		return () => {
			if (typeof dispose === "function") dispose();
		};
	});
	group("dsh-codehub: routes", () => {
		const active = currentService();
		if (webServer === void 0) {
			log("webServer 服务不可用，未注册 /api/dsh-codehub/*");
			return;
		}
		if (active === void 0) {
			log("codeSource 未就绪，未注册 /api/dsh-codehub/*");
			return;
		}
		return registerRoutes({
			webServer,
			ctx,
			service: active,
			store,
			settings,
			logger: log,
			...oauth === void 0 ? {} : { oauth },
			...launcher === void 0 ? {} : { launcher }
		});
	});
	group("dsh-codehub: prompt", () => {
		const controller = createPromptSection(systemPrompt, {
			enabled: config.announceToAgent !== false,
			log
		});
		return () => controller.dispose();
	});
	group("dsh-codehub: settings", () => settings.configure());
	const record = { dispose: () => {
		for (const dispose of disposers.reverse()) try {
			dispose();
		} catch {}
		disposers.length = 0;
	} };
	try {
		const guard = ctx.effect(() => () => {
			if (registry[MOUNT_KEY] === record) delete registry[MOUNT_KEY];
		}, "dsh-codehub: mount guard");
		if (typeof guard === "function") disposers.push(guard);
	} catch (error) {
		log("挂载守卫注册失败", { reason: describe(error) });
	}
	return record;
}
function describe(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return String(error);
	} catch {
		return "无法读取的错误对象";
	}
}
/** How long the reachability preflight may take. Short: it gates a user action. */
const HOST_PROBE_TIMEOUT_MS = 5e3;
/** The provider hosts this plugin may probe. Anything else is not ours to dial. */
function isProbeableHost(host) {
	return isOfficialPostHost(host.replace(/^https?:\/\//, "").split("/")[0] ?? "");
}
/**
* Value-free reachability preflight for the OAuth engine (`probeHost`).
*
* WHY IT EXISTS: this machine cannot open `github.com` (TCP 443 times out,
* docs/DESIGN.md §7.1), so a device flow would hang and then fail with a
* transport error. Answering "unreachable" BEFORE the first request is what lets
* the panel offer the PAT path instead.
*
* Never throws: a preflight that threw would be indistinguishable from a broken
* flow, and the engine must be able to turn a `false` into a sentence.
*/
async function probeProviderHost(host, signal) {
	if (!isProbeableHost(host)) return {
		reachable: false,
		detail: `不在可达性预检白名单里（只预检 github.com / gitee.com 及其子域）：${host}`
	};
	const target = host.startsWith("http") ? host : `https://${host}`;
	try {
		const response = await createTransport({
			transport: "node",
			retries: 0,
			timeoutMs: HOST_PROBE_TIMEOUT_MS,
			logger: () => {}
		})({
			url: target,
			timeoutMs: HOST_PROBE_TIMEOUT_MS,
			...signal === void 0 ? {} : { signal }
		});
		return {
			reachable: response.statusCode > 0,
			detail: `HTTP ${response.statusCode}`
		};
	} catch (error) {
		return {
			reachable: false,
			detail: describe(error)
		};
	}
}
/**
* The POST seam the OAuth engine gets (`createPostTransport`).
*
* The proxy address is read LAZILY from a mutable box: the transport must be
* built synchronously during mount, while the winning address lives in the 0600
* store and can only be read asynchronously. `resolveConfig()` lets the store
* beat the schema field, and the login exchange has to follow the same rule —
* otherwise a user who set the proxy only in the store would see the credential
* exchange leave untunneled.
*/
function buildPostTransport(config, store, log) {
	const box = { localProxy: readConfiguredProxy(config) };
	store.read().then((stored) => {
		const value = typeof stored.localProxy === "string" ? stored.localProxy.trim() : "";
		if (value.length > 0) box.localProxy = value;
	}).catch((error) => {
		log("读取本机代理地址失败，OAuth 将按配置字段里的地址出网", { reason: describe(error) });
	});
	return createPostTransport(box);
}
/** `github.localProxy` off the (tolerant) Cordis config object. */
function readConfiguredProxy(config) {
	const group = config.github;
	return typeof group?.localProxy === "string" ? group.localProxy.trim() : "";
}
//#endregion
export { Config, LEARN_CODE_TOOL, LEARN_CODE_TOOL_DESCRIPTION, PROMPT_SECTION, PROMPT_SECTION_NAME, apply, evaluateDecisions, inject, isLoopbackRequest, isMounted, name, redactForDelivery, unresolvedDecisions };
