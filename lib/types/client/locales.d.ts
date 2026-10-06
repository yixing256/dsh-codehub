/**
 * dsh-codehub — browser-half dictionaries (zh / en).
 *
 * The dictionary is a FLAT dot-key map. `en` is typed as `Record<LocaleKey, string>`
 * so a key added to `zh` without an English counterpart is a compile error — the
 * two languages cannot drift.
 *
 * `zh` is the source of truth for keys; `en` mirrors it. The runtime hands each
 * seat a `t` already bound to `LOCALE_NAMESPACE`; `useTranslate` prefers that,
 * and falls back to the translate bound at `apply()` time (some seats — the
 * keyed `main` seat and the `shell.overlay` seats — are registered without a
 * `locale` field, so they may receive no `t` at all).
 *
 * Anti-copy / provenance strings are deliberately NOT in this dictionary: the
 * rendered banner, the local-proxy scope note and the CSDN provenance note come
 * from `src/contract.ts` constants, so the single source of truth for them is
 * the contract and never a translated copy.
 */
export declare const zh: {
    readonly 'panel.title': "DSH CodeHub";
    readonly 'panel.subtitle': "代码用法学习源 · 不是代码搬运器";
    readonly 'panel.hostReady': "已连接 host 路由";
    readonly 'panel.hostUnavailable': "未接入 host（/api/dsh-codehub/config 不可达）";
    readonly 'panel.loading': "加载中…";
    readonly 'panel.refresh': "重新读取配置";
    readonly 'panel.refreshing': "读取中…";
    readonly 'panel.save': "保存到 host";
    readonly 'panel.saving': "保存中…";
    readonly 'panel.saved': "已保存到 host";
    readonly 'panel.autoSaved': "已自动保存";
    readonly 'panel.preferenceSaved': "已保存自动保存设置";
    readonly 'panel.autoSavePending': "正在自动保存…";
    readonly 'panel.autoSaveToggle': "自动保存";
    readonly 'panel.saveNow': "立即保存";
    readonly 'panel.dirtyManual': "有未保存的改动（自动保存已关闭）";
    readonly 'panel.revertHint': "取消已排期的写入，并回到 host 当前的值";
    readonly 'panel.dirty': "有未保存的改动";
    readonly 'panel.clean': "与 host 配置一致";
    readonly 'panel.revert': "撤销改动";
    readonly 'panel.describeConfig': "配置接口：GET / PATCH /api/dsh-codehub/config";
    readonly 'banner.resultsTitle': "学习参考用输出";
    readonly 'decisions.title': "尚未决定的选项";
    readonly 'decisions.hint': "这些项没配置前，agent 调用 learn_code_from_web 会被直接拒绝，并先来问你。";
    readonly 'decisions.empty': "四个决策点都已配置。";
    readonly 'decisions.control': "设置位置";
    readonly 'decisions.refresh': "重新检查";
    readonly 'decisions.unavailable': "暂时读不到决策点状态（/api/dsh-codehub/decisions 不可达）。";
    readonly 'source.title': "源优先级";
    readonly 'source.hint': "拖拽排序，或使用上移 / 下移按钮（按钮是键盘与触屏的降级路径）。";
    readonly 'source.empty': "尚未设置优先级 —— 空列表表示「未决策」，agent 会先问你。";
    readonly 'source.moveUp': "上移";
    readonly 'source.moveDown': "下移";
    readonly 'source.dragHandle': "拖拽排序";
    readonly 'source.remove': "移出";
    readonly 'source.add': "加入";
    readonly 'source.preset': "填入推荐顺序 GitHub → Gitee → CSDN";
    readonly 'source.reset': "清空（回到未决策）";
    readonly 'github.title': "GitHub 访问方式";
    readonly 'github.hint': "每一项都必须由你主动勾选；插件不内置代理、不自动改 hosts。";
    readonly 'github.requirement': "前置条件";
    readonly 'github.tokenCarried': "会带 token";
    readonly 'github.tokenStripped': "不带 token";
    readonly 'github.tokenMirrorConflict': "已同时勾选「携带 token」的方式与「镜像转发」的方式：镜像路径会在构造请求时强制剥离 token，长期凭据不会交给第三方转发站。";
    readonly 'github.wattNote': "Watt Toolkit 需你自行安装并勾选 GitHub；插件只做检测，不自带也不内置。";
    readonly 'risk.stable': "稳定";
    readonly 'risk.temporary': "临时";
    readonly 'risk.privacy-risk': "有隐私风险";
    readonly 'risk.not-recommended': "不推荐";
    readonly 'failover.title': "失败自动降级";
    readonly 'failover.hint': "某个源失败（网络 / 超时 / 限流 / 需要登录）时自动切到下一个源。";
    readonly 'merge.title': "多源合并";
    readonly 'merge.hint': "多个源都命中时合并去重，而不是只用最高优先级的那个源。";
    readonly 'tristate.undecided': "未定";
    readonly 'tristate.on': "开";
    readonly 'tristate.off': "关";
    readonly 'tristate.undecidedNote': "尚未决定，agent 会先问你";
    readonly 'account.github': "GitHub Token 登录";
    readonly 'account.gitee': "Gitee 登录";
    readonly 'account.csdn': "CSDN 登录";
    readonly 'account.status': "登录状态";
    readonly 'account.configured': "已配置";
    readonly 'account.notConfigured': "未配置";
    readonly 'account.login': "登录";
    readonly 'account.relogin': "重新登录";
    readonly 'account.logout': "登出";
    readonly 'account.loggingOut': "清除中…";
    readonly 'account.githubHint': "选择「官方直连 API / Token 登录」时才会带上；镜像与第三方转发路径一律剥离 token。";
    readonly 'account.giteeHint': "无 token 时仍可查公开端点；空结果会标成 auth-required，不会伪造数据。";
    readonly 'account.csdnHint': "匿名搜索可用；受限结果会降低 confidence。";
    readonly 'account.neverShown': "界面只显示「已配置 / 未配置」，不显示值本身。";
    readonly 'account.browserLogin': "浏览器登录";
    readonly 'account.import': "令牌或 Cookie 导入";
    readonly 'account.guide': "获取向导";
    readonly 'account.loginRequirement': "登录要求";
    readonly 'account.noBrowserLogin': "该源不支持浏览器登录";
    readonly 'mirror.title': "镜像源列表";
    readonly 'mirror.hint': "不预填任何数据；列表为空 = 该方式不可用，插件不会兜底。";
    readonly 'mirror.webTitle': "网页 / API 代理基址（ghproxy、ghfast.top 等）";
    readonly 'mirror.rawTitle': "raw 文件镜像基址";
    readonly 'mirror.webPlaceholder': "https://ghproxy.net/";
    readonly 'mirror.rawPlaceholder': "https://ghproxy.net/https://raw.githubusercontent.com";
    readonly 'mirror.add': "添加一行";
    readonly 'mirror.remove': "删除这一行";
    readonly 'mirror.empty': "（空列表，未预填任何数据）";
    readonly 'mirror.rawNote': "本机实测 raw.githubusercontent.com 不可直连，使用 raw 文件必须依赖这里填的镜像。";
    readonly 'proxy.placeholder': "127.0.0.1:7890";
    readonly 'proxy.empty': "未填写 = 该方式不出现在可用路径里。";
    readonly 'limits.title': "超时 / 重试 / 上限";
    readonly 'limits.hint': "可以调小，不能超过硬顶；硬顶由插件强制收敛。";
    readonly 'limits.timeoutMs': "单次请求超时 (ms)";
    readonly 'limits.retries': "重试次数";
    readonly 'limits.maxDepth': "递归深度上限";
    readonly 'limits.maxItems': "单次最大条目数";
    readonly 'limits.maxCodeChars': "单条代码片段最大字符数";
    readonly 'limits.hardCap': "硬顶";
    readonly 'deepread.title': "深度阅读目标";
    readonly 'deepread.hint': "未选 = 只做浅搜索。深读产出的是思路笔记（LearnNote），不是文件副本。";
    readonly 'deepread.readme': "README";
    readonly 'deepread.entry': "入口文件";
    readonly 'deepread.core': "核心模块";
    readonly 'deepread.tests': "测试";
    readonly 'entry.title': "显示位置";
    readonly 'entry.hint': "默认侧边栏和设置页都显示。改完点「保存」生效，不用重新加载页面。";
    readonly 'entry.sidebar': "侧边栏面板";
    readonly 'entry.sidebarDesc': "侧边栏顶部显示 GitHub 猫标 + codehub，点开是完整面板。";
    readonly 'entry.settings': "设置页";
    readonly 'entry.settingsDesc': "在设置里增加一节「DSH CodeHub 设置」。";
    readonly 'entry.both': "侧边栏 + 设置页（默认）";
    readonly 'entry.bothDesc': "两处都显示，也是最省事的选项。";
    readonly 'entry.current': "当前生效";
    readonly 'entry.inSync': "与已保存的设置一致";
    readonly 'entry.unsaved': "已改动，点保存后才生效";
    readonly 'entry.save': "保存显示位置";
    readonly 'entry.saving': "保存中…";
    readonly 'csdn.endpoint': "搜索端点";
    readonly 'csdn.options.title': "CSDN 抓取选项";
    readonly 'csdn.options.hint': "CSDN 只作补充源。这两项都只影响 CSDN，不改变其它两个源的行为。";
    readonly 'csdn.articleFetch': "搜索没给代码时，补抓一次文章页";
    readonly 'csdn.articleFetch.hint': "实测：搜索接口 30 条里只有约 6 条带正文，而文章页匿名就能取到代码。开启后按「递归深度上限」的预算补抓（默认 1 篇），reason 里会标明代码来自文章页。";
    readonly 'csdn.cdp.label': "实验性：从本机浏览器读取 Cookie（CDP）";
    readonly 'csdn.cdp.hint': "勾选并保存后，凭据获取向导里的「CDP 抓取」方式才可用；读取前还会再要你确认一次。";
    readonly 'csdn.cdp.warn': "安全代价：调试端口对本机任何进程开放。默认关闭，只在这次读取里使用。";
    readonly 'csdn.cdp.howTo': "用法：点「启动调试浏览器」（会一并打开 CSDN 登录页），在打开的窗口里登录 CSDN，然后到「凭据获取向导」→ CSDN → ② 令牌 / Cookie 手动导入 → CDP 抓取，勾选同意后点「读取 Cookie」。";
    readonly 'csdn.cdp.off': "当前关闭：向导里的 CDP 抓取方式会拒绝执行（需要你显式开启）。";
    readonly 'csdn.cdp.port': "调试端口";
    readonly 'csdn.cdp.launch': "启动调试浏览器";
    readonly 'csdn.cdp.launching': "正在启动…";
    readonly 'csdn.cdp.launchHint': "端口上已有可调试的浏览器时会直接复用，不会重复启动。";
    readonly 'csdn.cdp.launched': "已启动调试浏览器。";
    readonly 'csdn.cdp.alreadyRunning': "端口上已有可调试的浏览器，直接复用。";
    readonly 'summary.row.csdnCdp': "CSDN 抓取";
    readonly 'tools.title': "环境探测与自检";
    readonly 'tools.detectRun': "探测系统代理 / SOCKS5 / Watt / hosts";
    readonly 'tools.detecting': "探测中…";
    readonly 'tools.detectEmpty': "尚未探测。";
    readonly 'tools.smokeRun': "运行连通性自检";
    readonly 'tools.smokeRunning': "自检中…";
    readonly 'tools.smokeEmpty': "尚未运行自检。";
    readonly 'tools.results': "结果";
    readonly 'connect.title': "连通性";
    readonly 'connect.hint': "固定三行：GitHub / Gitee / CSDN。失败行的下一行直接给出失败原因，界面不渲染任何原始报文。";
    readonly 'connect.empty': "尚未检测。匿名自检只走公开端点，不带任何凭据。";
    readonly 'connect.runSmoke': "运行匿名自检";
    readonly 'connect.smokeRunning': "自检中…";
    readonly 'connect.runProbe': "用已保存凭据验证";
    readonly 'connect.probeRunning': "验证中…";
    readonly 'connect.status.undetected': "未检测";
    readonly 'connect.status.running': "检测中";
    readonly 'connect.status.ok': "连通";
    readonly 'connect.status.failed': "失败";
    readonly 'connect.reasonLabel': "失败原因";
    readonly 'connect.copyReason': "复制原因";
    readonly 'connect.reasonCopied': "已复制原因";
    readonly 'connect.copyFailed': "复制失败，请手动选中文本复制。";
    readonly 'connect.requiresLogin': "需要登录";
    readonly 'connect.noLoginNeeded': "无需登录";
    readonly 'connect.loginRequirement': "登录要求";
    readonly 'connect.evidence': "实测证据";
    readonly 'connect.smokeFailed': "自检请求失败：";
    readonly 'connect.probeFailed': "验证请求失败：";
    readonly 'summary.title': "我配置了什么";
    readonly 'summary.savedToHost': "已保存到 host";
    readonly 'summary.changeCount': "项改动";
    readonly 'summary.noChanges': "没有改动需要保存";
    readonly 'summary.hostValue': "与 host 一致的当前值";
    readonly 'summary.dirtyNote': "有未保存的改动；下表始终是 host 回读值，不含草稿。";
    readonly 'summary.modified': "本次修改";
    readonly 'summary.notProvided': "未提供";
    readonly 'summary.mirrorWeb': "网页/API";
    readonly 'summary.mirrorRaw': "raw";
    readonly 'summary.row.sourcePriority': "源优先级顺序";
    readonly 'summary.row.githubAccess': "GitHub 访问方式";
    readonly 'summary.row.failover': "自动降级";
    readonly 'summary.row.merge': "多源合并";
    readonly 'summary.row.accounts': "账号登录状态";
    readonly 'summary.row.mirrors': "镜像数量";
    readonly 'summary.row.localProxy': "本机代理";
    readonly 'summary.row.limits': "关键 limits";
    readonly 'summary.row.deepRead': "深读目标";
    readonly 'summary.row.entryPlacement': "显示位置";
    readonly 'decisions.remainingPrefix': "开始使用前还差";
    readonly 'decisions.remainingSuffix': "项";
    readonly 'decisions.expand': "展开这一项";
    readonly 'decisions.collapse': "收起";
    readonly 'decisions.decideNow': "现在就定";
    readonly 'decisions.ready': "已就绪";
    readonly 'decisions.readyHint': "可直接执行，无需再确认决策点。";
    readonly 'decisions.notProvided': "未提供：该项仍未决定。";
    readonly 'decisions.located': "已定位到该控件，请在那里选择。";
    readonly 'decisions.optionalNote': "未配置的可选项（token / 镜像 / 本机代理 / CSDN 登录）不算未完成项，只影响对应的访问方式。";
    readonly 'guide.title': "凭据获取向导";
    readonly 'guide.intro': "按步骤做一遍即可：每一步都给出要打开的页面，以及需要粘回来的值。";
    readonly 'guide.family.oauth': "① 浏览器登录（OAuth）";
    readonly 'guide.family.oauthHint': "由浏览器完成授权，插件自动把 token 写进凭据服务——你不用看到、也不用复制任何密钥。";
    readonly 'guide.family.manual': "② 令牌 / Cookie 手动导入";
    readonly 'guide.family.manualHint': "你从浏览器里复制一段值粘回来；适合不想注册 OAuth 应用、或该平台没有 OAuth 的情况。";
    readonly 'guide.family.noOauth': "这个平台没有 OAuth（没有可授权的开放接口），只能用下面的手动导入方式。";
    readonly 'guide.kind.token': "令牌";
    readonly 'guide.kind.cookie': "Cookie";
    readonly 'guide.steps': "步骤";
    readonly 'guide.why': "为什么需要这一步";
    readonly 'guide.open': "打开";
    readonly 'guide.copyLink': "复制链接";
    readonly 'guide.linkCopied': "已复制链接";
    readonly 'guide.copyFailed': "复制失败，请手动选中链接复制。";
    readonly 'guide.pasteValues': "需要粘回的值（只用于本次请求，提交后立即清空）";
    readonly 'guide.saveValues': "保存到凭据服务";
    readonly 'guide.saving': "提交中…";
    readonly 'guide.start': "开始浏览器登录";
    readonly 'guide.starting': "正在发起…";
    readonly 'guide.startFailed': "无法发起浏览器登录：";
    readonly 'guide.userCode': "在打开的页面里输入这个用户码";
    readonly 'guide.openVerification': "打开授权页";
    readonly 'guide.polling': "正在等待授权结果…";
    readonly 'guide.cancel': "取消本次登录";
    readonly 'guide.cancelled': "本次登录已取消。";
    readonly 'guide.callback': "回调地址（必须与 Gitee 应用里登记的一致）";
    readonly 'guide.copyCallback': "复制回调地址";
    readonly 'guide.callbackCopied': "已复制回调地址";
    readonly 'guide.callbackDerived': "回调地址由当前页面地址推导；端口变化后需要重新登记。";
    readonly 'guide.manualCode': "手动粘贴 code（回调没回来时用）";
    readonly 'guide.manualCodePlaceholder': "把地址栏里 code= 后面那串粘到这里";
    readonly 'guide.submitCode': "提交 code";
    readonly 'guide.submitting': "提交中…";
    readonly 'guide.status.pending': "等待授权";
    readonly 'guide.status.slow_down': "等待授权（已放慢轮询）";
    readonly 'guide.status.done': "已配置";
    readonly 'guide.status.expired': "已过期";
    readonly 'guide.status.error': "失败";
    readonly 'guide.status.unknown': "状态未知";
    readonly 'guide.statusConfigured': "凭据已写入 DSH 凭据服务，页面不会再显示它的值。";
    readonly 'guide.cdpWarning': "开启浏览器调试端口后，本机上的任何程序都能通过该端口读取你浏览器的会话。插件默认关闭这个能力，只在本次操作里使用。";
    readonly 'guide.cdpEnabled': "CDP 抓取已启用；可在面板「CSDN 抓取选项」里关闭。";
    readonly 'guide.cdpDisabledNotice': "CDP 抓取当前关闭，下面的启动与读取都会失败。开启后会立即保存。";
    readonly 'guide.cdpEnable': "启用 CDP 抓取并保存";
    readonly 'guide.cdpEnabling': "正在启用…";
    readonly 'guide.cdpEnableHint': "与面板「CSDN 抓取选项」里的开关相同。";
    readonly 'guide.cdpEnableFailed': "启用没有保存成功（host 拒绝了写入）。请在面板「CSDN 抓取选项」里勾选并保存。";
    readonly 'guide.cdpLaunchNeedsEnable': "需要先启用 CDP 抓取。";
    readonly 'guide.cdpConsent': "我已了解风险";
    readonly 'guide.cdpPort': "调试端口";
    readonly 'guide.cdpRead': "读取 Cookie";
    readonly 'guide.cdpReading': "读取中…";
    readonly 'guide.cdpResult': "读取结果（只显示名称与数量，不显示值）";
    readonly 'guide.cdpCount': "cookie 数量";
    readonly 'guide.cdpNames': "cookie 名称";
    readonly 'guide.cdpHosts': "来源主机";
    readonly 'guide.cdpNone': "尚未读取。";
    readonly 'guide.noOAuth': "CSDN 没有 OAuth，只能用 Cookie：请改用 Cookie 向导。";
    readonly 'login.githubTitle': "登录 GitHub";
    readonly 'login.giteeTitle': "登录 Gitee";
    readonly 'login.csdnTitle': "登录 CSDN";
    readonly 'login.githubTokenLabel': "GitHub 个人访问令牌（PAT）";
    readonly 'login.tokenLabel': "Gitee 私人令牌（access_token）";
    readonly 'login.cookieLabel': "CSDN Cookie";
    readonly 'login.tokenPlaceholder': "粘贴 token（提交后输入框立即清空）";
    readonly 'login.cookiePlaceholder': "粘贴 cookie（提交后输入框立即清空）";
    readonly 'login.serviceUnavailable': "本机凭证服务不可用（503）—— 请确认 DSH 凭证服务已就绪后重试。";
    readonly 'login.submit': "提交凭据";
    readonly 'login.submitting': "提交中…";
    readonly 'login.clear': "清除已配置凭据";
    readonly 'login.clearing': "清除中…";
    readonly 'login.empty': "内容不能为空。";
    readonly 'login.cancel': "取消";
    readonly 'login.security': "凭据只存在 DSH 凭证服务里，不会写进配置文件，也不会进 git。";
    readonly 'login.once': "值只在提交时传输一次：不回显、不写入 localStorage、提交后立即清空输入框。";
    readonly 'login.status': "当前状态";
    readonly 'login.type': "凭据类型";
    readonly 'login.typeToken': "token";
    readonly 'login.typeCookie': "cookie";
    readonly 'settings.title': "DSH CodeHub 设置";
    readonly 'settings.intro': "与侧边栏面板共用同一份配置（GET / PATCH /api/dsh-codehub/config），字段一致，布局更适合表单。";
    readonly 'settings.syncReady': "settingsScope 可用：保存时会顺带同步到 DSH settings。";
    readonly 'settings.syncLoading': "settingsScope 正在加载。";
    readonly 'settings.syncUnavailable': "settingsScope 不可用（本 namespace 不在白名单内）—— 配置仍通过插件自己的路由读写，不受影响。";
    readonly 'settings.syncAbsent': "没有探测到 settingsScope 服务，仅使用插件自己的路由。";
    readonly 'settings.syncPull': "从 DSH settings 拉取";
    readonly 'settings.pullDone': "已从 DSH settings 拉取到草稿（保存在 host 前不会生效）。";
    readonly 'settings.pullEmpty': "settingsScope 没有可拉取的配置。";
    readonly 'settings.formHint': "表单布局 · 与面板同源";
    readonly 'error.timeout': "请求超时";
    readonly 'error.network': "网络请求失败";
    readonly 'error.parse': "响应不是合法 JSON";
    readonly 'error.http': "请求被拒绝";
    readonly 'error.unavailable': "host 路由不可达";
    readonly 'error.unknown': "未知错误";
    readonly 'error.retry': "重试";
    readonly 'common.dash': "—";
    readonly 'common.close': "关闭";
    readonly 'common.none': "无";
    readonly 'common.notConfigured': "未配置";
};
/** Every dictionary key. Adding a key to `zh` without `en` fails to compile. */
export type LocaleKey = keyof typeof zh;
/** A translate function bound to this plugin's dictionary. */
export type Translate = (key: LocaleKey) => string;
export declare const en: Record<LocaleKey, string>;
export declare function setActiveTranslate(next: Translate | null): void;
/** Translate through the active binding, falling back to the zh dictionary. */
export declare function translateNow(key: LocaleKey): string;
/**
 * Plain `Record<string, string>` copies for `ctx.locale.register`.
 *
 * The literal-typed dictionaries are what give us compile-time key parity; the
 * registration API wants an index-signature map, so the copies keep that
 * boundary explicit instead of relying on an implicit index signature.
 */
export declare function dictionaries(): {
    zh: Record<string, string>;
    en: Record<string, string>;
};
/**
 * Resolve the translate for a seat: the prop the renderer passed wins, then the
 * binding captured at apply time, then the raw zh dictionary.
 */
export declare function useTranslate(props: {
    t?: Translate;
}): Translate;
