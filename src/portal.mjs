import { getTerm } from "./core/terminology.mjs";

const LANGUAGE_STORAGE_KEY = "d2_armor_page_language_v1";
const LANGUAGE_META = Object.freeze({
  "zh-chs": { htmlLang: "zh-CN" },
  "zh-cht": { htmlLang: "zh-Hant" },
  en: { htmlLang: "en" },
});

const COPY = Object.freeze({
  "zh-chs": {
    documentTitle: "命运2 T5配装求解器",
    description: "命运2 Armor 3.0 六维属性配装求解器：在线零安装使用，或下载完全离线、数据不出本机的版本。",
    skipToContent: "跳到主要内容",
    brandHome: "命运2 T5配装求解器首页",
    brandName: "命运2 配装求解器",
    languageLabel: "网页语言",
    freeNotice: "本工具完全免费",
    fraudNotice: "如果你付费购买，说明你被骗了。",
    heroEyebrow: "DESTINY 2 / ARMOR 3.0",
    heroTitle: "设定属性目标，快速规划配装方案",
    heroLead: "结合已有护甲信息计算出最合理的配装方案与刷装规划。",
    capabilitiesLabel: "核心能力",
    capabilityOne: "导入 DIM CSV 或通过 Bungie 登录读取库存",
    capabilityTwo: `计算 5 件护甲、${getTerm("armorSetBonus", "zh-chs")}约束与${getTerm("tuningMod", "zh-chs")}`,
    capabilityThree: "明确显示可达性、属性缺口与待刷装备",
    routeTitle: "选择使用方式",
    onlineLabel: "推荐 / 在线",
    onlineTitle: "在线使用",
    onlineState: "零安装",
    onlineDescription: "直接进入求解器。支持 Bungie OAuth 登录读取真实库存，也可手动导入 DIM CSV。",
    onlineMetaOne: "浏览器即开即用",
    onlineMetaTwo: "数据仅在当前浏览器处理",
    openApp: "进入在线求解器",
    openDevelopmentApp: "进入开发测试版",
    offlineLabel: "隐私 / 本地",
    offlineTitle: "下载离线版",
    offlineState: "无服务器",
    offlineDescription: "解压后双击 index.html。无需安装、无需 CDN，DIM 数据与配装记录 100% 留在本机。",
    downloadRelease: "下载最新正式版",
    actionsBuild: "Actions 抢先构建",
    previewTitle: "同一套配装引擎，两种运行方式",
    previewDescription: "在线版与离线版共享同一套配装引擎与 Armor 3.0 规则，门户只负责帮你选择入口。",
    statsLabel: "六维属性",
    statHealth: getTerm("health", "zh-chs"),
    statMelee: "近战",
    statGrenade: "手雷",
    statSuper: getTerm("super", "zh-chs"),
    statClass: "职业",
    statWeapons: "武器",
    screenshotAlt: "命运2 T5配装求解器的目标属性与库存输入界面",
    screenshotCaption: "真实应用界面",
    trustGridTitle: "可信，来自可验证的边界",
    privacyTitle: "数据留在浏览器",
    privacyDescription: "目标属性、DIM 清单与保存方案不发送到项目服务器；离线版运行时完全不依赖服务器。",
    staticTitle: "没有后端账户",
    staticDescription: "应用是静态浏览器程序。在线登录由 Bungie OAuth 完成，项目不建立自己的账号系统。",
    openTitle: "源码与构建公开",
    openDescription: "源代码、Release 与每次推送的 Actions 构建记录都可在 GitHub 检查。",
    offlineGuideTitle: "三步进入完全离线工作台",
    offlineGuideDescription: "适合网络受限、在意隐私，或希望把整个工具随身保存的玩家。",
    stepDownload: "下载 Release 压缩包",
    stepExtract: "解压到任意本地目录",
    stepOpen: "双击 index.html 打开",
    footerProduct: "命运2 T5配装求解器",
    footerMaintainer: "维护者 MIGO-OvO",
    footerOriginal: "致谢原版作者 · B站 UID 57597346",
    footerGroup: "反馈群 1104108070",
    languageChanged: "网页语言已切换为简体中文",
  },
  "zh-cht": {
    documentTitle: "天命2 T5配裝求解器",
    description: "天命2 Armor 3.0 六維數值配裝求解器：線上免安裝使用，或下載完全離線、資料不離開本機的版本。",
    skipToContent: "跳至主要內容",
    brandHome: "天命2 T5配裝求解器首頁",
    brandName: "天命2 配裝求解器",
    languageLabel: "網頁語言",
    freeNotice: "本工具完全免費",
    fraudNotice: "如果你付費購買，代表你受騙了。",
    heroEyebrow: "DESTINY 2 / ARMOR 3.0",
    heroTitle: "設定屬性目標，快速規劃配裝方案",
    heroLead: "結合已有防具資訊，計算出最合理的配裝方案與刷裝規劃。",
    capabilitiesLabel: "核心能力",
    capabilityOne: "匯入 DIM CSV 或透過 Bungie 登入讀取庫存",
    capabilityTwo: `計算 5 件防具、${getTerm("armorSetBonus", "zh-cht")}限制與${getTerm("tuningMod", "zh-cht")}`,
    capabilityThree: "清楚顯示可達性、數值缺口與待取得裝備",
    routeTitle: "選擇使用方式",
    onlineLabel: "推薦 / 線上",
    onlineTitle: "線上使用",
    onlineState: "免安裝",
    onlineDescription: "直接進入求解器。支援 Bungie OAuth 登入讀取真實庫存，也可手動匯入 DIM CSV。",
    onlineMetaOne: "瀏覽器即開即用",
    onlineMetaTwo: "資料只在目前瀏覽器處理",
    openApp: "進入線上求解器",
    openDevelopmentApp: "進入開發測試版",
    offlineLabel: "隱私 / 本機",
    offlineTitle: "下載離線版",
    offlineState: "無伺服器",
    offlineDescription: "解壓縮後雙擊 index.html。無需安裝、無需 CDN，DIM 資料與配裝紀錄 100% 留在本機。",
    downloadRelease: "下載最新正式版",
    actionsBuild: "Actions 搶先建置",
    previewTitle: "同一套配裝引擎，兩種執行方式",
    previewDescription: "線上版與離線版共享同一套配裝引擎與 Armor 3.0 規則，入口網站只負責協助你選擇路徑。",
    statsLabel: "六維數值",
    statHealth: getTerm("health", "zh-cht"),
    statMelee: "近戰",
    statGrenade: "手榴彈",
    statSuper: getTerm("super", "zh-cht"),
    statClass: "職業",
    statWeapons: "武器",
    screenshotAlt: "天命2 T5配裝求解器的目標數值與庫存輸入介面",
    screenshotCaption: "真實應用介面",
    trustGridTitle: "可信，來自可驗證的邊界",
    privacyTitle: "資料留在瀏覽器",
    privacyDescription: "目標數值、DIM 清單與已儲存配裝不會傳送到專案伺服器；離線版執行時完全不依賴伺服器。",
    staticTitle: "沒有後端帳號",
    staticDescription: "應用程式是靜態瀏覽器程式。線上登入由 Bungie OAuth 完成，專案不建立自己的帳號系統。",
    openTitle: "原始碼與建置公開",
    openDescription: "原始碼、Release 與每次推送的 Actions 建置紀錄都可在 GitHub 查驗。",
    offlineGuideTitle: "三步進入完全離線工作台",
    offlineGuideDescription: "適合網路受限、在意隱私，或希望把整個工具隨身保存的玩家。",
    stepDownload: "下載 Release 壓縮檔",
    stepExtract: "解壓縮到任意本機目錄",
    stepOpen: "雙擊 index.html 開啟",
    footerProduct: "天命2 T5配裝求解器",
    footerMaintainer: "維護者 MIGO-OvO",
    footerOriginal: "感謝原版作者 · Bilibili UID 57597346",
    footerGroup: "回饋群 1104108070",
    languageChanged: "網頁語言已切換為繁體中文",
  },
  en: {
    documentTitle: "Destiny 2 T5 Armor Solver",
    description: "A Destiny 2 Armor 3.0 six-stat loadout solver. Use it online with no setup, or download a fully offline build that keeps data on your device.",
    skipToContent: "Skip to main content",
    brandHome: "Destiny 2 T5 Armor Solver home",
    brandName: "Destiny 2 Armor Solver",
    languageLabel: "Page language",
    freeNotice: "This tool is completely free",
    fraudNotice: "If you paid for it, you were scammed.",
    heroEyebrow: "DESTINY 2 / ARMOR 3.0",
    heroTitle: "Set stat targets, plan loadouts fast",
    heroLead: "Combine your existing armor to compute the best loadout plan and farming roadmap.",
    capabilitiesLabel: "Core capabilities",
    capabilityOne: "Import a DIM CSV or read inventory through Bungie login",
    capabilityTwo: "Solve five armor pieces, set constraints, and Tuning Mods",
    capabilityThree: "See reachability, stat shortfalls, and what remains to farm",
    routeTitle: "Choose how to use it",
    onlineLabel: "Recommended / Online",
    onlineTitle: "Use online",
    onlineState: "No setup",
    onlineDescription: "Open the solver directly. Sign in through Bungie OAuth to read real inventory, or import a DIM CSV manually.",
    onlineMetaOne: "Runs immediately in your browser",
    onlineMetaTwo: "Data is processed in this browser",
    openApp: "Open the online solver",
    openDevelopmentApp: "Open development preview",
    offlineLabel: "Private / Local",
    offlineTitle: "Download offline",
    offlineState: "No server",
    offlineDescription: "Unzip and double-click index.html. No installation or CDN; DIM data and saved loadouts stay 100% on your device.",
    downloadRelease: "Download latest release",
    actionsBuild: "Actions preview build",
    previewTitle: "One loadout engine, two ways to run it",
    previewDescription: "Online and offline builds share the same loadout engine and Armor 3.0 rules. This portal only helps you choose an entry point.",
    statsLabel: "Six armor stats",
    statHealth: getTerm("health", "en"),
    statMelee: "Melee",
    statGrenade: "Grenade",
    statSuper: getTerm("super", "en"),
    statClass: "Class",
    statWeapons: "Weapons",
    screenshotAlt: "Target stat and inventory input interface in Destiny 2 T5 Armor Solver",
    screenshotCaption: "Actual application interface",
    trustGridTitle: "Trust through verifiable boundaries",
    privacyTitle: "Data stays in the browser",
    privacyDescription: "Targets, DIM inventory, and saved loadouts are not sent to a project server. The offline build runs without any server dependency.",
    staticTitle: "No backend account",
    staticDescription: "This is a static browser app. Online login goes through Bungie OAuth; the project does not create its own account system.",
    openTitle: "Open source and builds",
    openDescription: "Source, Releases, and Actions build records for every push can be inspected on GitHub.",
    offlineGuideTitle: "Three steps to a fully offline workbench",
    offlineGuideDescription: "Built for restricted networks, privacy-conscious players, or anyone who wants a portable copy of the whole tool.",
    stepDownload: "Download the Release archive",
    stepExtract: "Extract it to any local folder",
    stepOpen: "Double-click index.html",
    footerProduct: "Destiny 2 T5 Armor Solver",
    footerMaintainer: "Maintained by MIGO-OvO",
    footerOriginal: "Original author credit · Bilibili UID 57597346",
    footerGroup: "Feedback group 1104108070",
    languageChanged: "Page language changed to English",
  },
});

const languageSelect = document.getElementById("portalLanguage");
const status = document.getElementById("portalStatus");
const description = document.querySelector('meta[name="description"]');

function normalizeLanguage(language) {
  return Object.hasOwn(LANGUAGE_META, language) ? language : "zh-chs";
}

function readStoredLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "zh-chs";
  }
}

function writeStoredLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language still changes for this page when storage is unavailable.
  }
}

function applyLanguage(language, { announce = false, persist = true } = {}) {
  const normalized = normalizeLanguage(language);
  const copy = COPY[normalized];

  document.documentElement.lang = LANGUAGE_META[normalized].htmlLang;
  document.title = copy.documentTitle;
  if (description) description.content = copy.description;
  languageSelect.value = normalized;

  for (const element of document.querySelectorAll("[data-i18n]")) {
    const value = copy[element.dataset.i18n];
    if (value !== undefined) element.textContent = value;
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    const value = copy[element.dataset.i18nAria];
    if (value !== undefined) element.setAttribute("aria-label", value);
  }
  for (const element of document.querySelectorAll("[data-i18n-alt]")) {
    const value = copy[element.dataset.i18nAlt];
    if (value !== undefined) element.setAttribute("alt", value);
  }

  if (persist) writeStoredLanguage(normalized);
  if (announce) status.textContent = copy.languageChanged;
}

languageSelect.addEventListener("change", event => {
  applyLanguage(event.currentTarget.value, { announce: true });
});

window.addEventListener("storage", event => {
  if (event.key === LANGUAGE_STORAGE_KEY && event.newValue) {
    applyLanguage(event.newValue, { persist: false });
  }
});

applyLanguage(readStoredLanguage(), { persist: false });
