import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { clickSolver, mountSolver } from "./solver-bridge";

const translations = {
  "zh-chs": { title: "配装工作台", offline: "离线桌面版", solve: "从零求解", upgrade: "优化现有配装", import: "导入 DIM CSV", parameters: "配装参数", results: "查看结果", empty: "让下一套配装，有据可循。", hint: "在左侧设置六维目标，或导入 DIM 护甲清单，再开始求解。结果与方案详情会显示在这里。", privacy: "数据仅保存在本机", shortcut: "Ctrl + Enter 开始求解", loading: "正在加载本地求解器…", error: "加载失败，请重启应用。", linkError: "无法打开链接，请检查默认浏览器设置。", free: "完全免费 · 谨防付费转售" },
  "zh-cht": { title: "配裝工作台", offline: "離線桌面版", solve: "從零求解", upgrade: "最佳化現有配裝", import: "匯入 DIM CSV", parameters: "配裝參數", results: "查看結果", empty: "讓下一套配裝，有據可循。", hint: "在左側設定六維目標，或匯入 DIM 護甲清單，再開始求解。結果與方案詳情會顯示在這裡。", privacy: "資料僅儲存在本機", shortcut: "Ctrl + Enter 開始求解", loading: "正在載入本機求解器…", error: "載入失敗，請重新啟動應用程式。", linkError: "無法開啟連結，請檢查預設瀏覽器設定。", free: "完全免費 · 謹防付費轉售" },
  en: { title: "Loadout workbench", offline: "Offline desktop", solve: "Build from scratch", upgrade: "Optimize loadout", import: "Import DIM CSV", parameters: "Parameters", results: "View results", empty: "A clearer path to your next loadout.", hint: "Set your stat targets on the left, or import your DIM armor CSV, then start a search. Results and armor details appear here.", privacy: "Data stays on this device", shortcut: "Ctrl + Enter to search", loading: "Loading local solver…", error: "Could not load the solver. Restart the app.", linkError: "Could not open the link. Check your default browser settings.", free: "Always free · Never pay a reseller" },
};
type Language = keyof typeof translations;

export function DesktopApp() {
  const host = useRef<HTMLDivElement>(null);
  const languageHost = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [language, setLanguage] = useState<Language>("zh-chs");
  const [mode, setMode] = useState("solve");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<"error" | "linkError" | null>(null);
  const t = translations[language];

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let observer: MutationObserver | undefined;
    let disposed = false;
    const sync = () => {
      const value = (document.getElementById("pageLanguage") as HTMLSelectElement)?.value;
      setLanguage(value in translations ? value as Language : "zh-chs");
      setMode(document.body.classList.contains("is-upgrade-mode") ? "upgrade" : "solve");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter" && !event.repeat) {
        event.preventDefault();
        clickSolver(document.body.classList.contains("is-upgrade-mode") ? "btnUpgradeAnalyze" : "btnSolve");
      }
    };
    const onLink = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !isTauri() || !/^https?:/.test(anchor.href)) return;
      event.preventDefault();
      // The Rust capability independently restricts allowed HTTPS destinations.
      void openUrl(anchor.href).catch(() => setError("linkError"));
    };
    void mountSolver(host.current!, languageHost.current!).then(() => {
      if (disposed) return;
      sync();
      setReady(true);
      observer = new MutationObserver(sync);
      observer.observe(host.current!, { subtree: true, attributes: true, attributeFilter: ["class", "hidden", "aria-pressed"] });
      document.addEventListener("change", sync);
      document.addEventListener("keydown", onKey);
      document.addEventListener("click", onLink);
    }).catch(cause => { console.error(cause); setError("error"); });
    return () => {
      disposed = true;
      observer?.disconnect();
      document.removeEventListener("change", sync);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onLink);
    };
  }, []);

  function jump(selector: string) {
    const element = host.current?.querySelector<HTMLElement>(selector);
    element?.scrollIntoView({ block: "start" });
    element?.focus({ preventScroll: true });
  }

  return <div className="desktop-app">
    <header className="desktop-topbar">
      <div className="desktop-brand"><span className="desktop-mark" aria-hidden="true">T5</span><strong>{t.title}</strong><span className="desktop-offline">{t.offline}</span></div>
      <span className="desktop-privacy">{t.privacy}</span>
    </header>
    <div className="desktop-body">
      <nav className="desktop-nav" aria-label={t.title}>
        <span className="desktop-nav-caption">DESTINY 2 / ARMOR 3.0</span>
        <button disabled={!ready} aria-pressed={mode === "solve"} onClick={() => clickSolver("modeSolveButton")}>{t.solve}</button>
        <button disabled={!ready} aria-pressed={mode === "upgrade"} onClick={() => clickSolver("modeUpgradeButton")}>{t.upgrade}</button>
        <div className="desktop-nav-divider" />
        <button disabled={!ready} onClick={() => clickSolver("dimCsvFile")}>{t.import}</button>
        <button disabled={!ready} onClick={() => jump(".desktop-inputs")}>{t.parameters}</button>
        <button disabled={!ready} onClick={() => jump(".desktop-output")}>{t.results}</button>
        <div ref={languageHost} className="desktop-language" />
        <small className="desktop-free">{t.free}</small>
      </nav>
      <div className="desktop-workspace">
        {!ready && <p className="desktop-startup" role="status">{error ? t.error : t.loading}</p>}
        {error && ready && <p role="alert" className="desktop-error">{t[error]} <button onClick={() => setError(null)} aria-label="Close">×</button></p>}
        <div ref={host} className="desktop-solver" />
      </div>
    </div>
    <footer className="desktop-status"><span>{t.privacy}</span><span>{t.shortcut}</span></footer>
  </div>;
}
