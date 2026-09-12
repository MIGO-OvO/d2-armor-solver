import html from "virtual:solver-template";

/** Only checked-in app HTML is injected. Never pass inventory/user HTML here.
 * React owns the shell; the existing renderer exclusively owns this subtree.
 * Reusing it preserves the certified solver and all three language variants.
 */
export async function mountSolver(host: HTMLElement, languageHost: HTMLElement) {
  host.innerHTML = html;
  const main = host.querySelector<HTMLElement>("main.container")!;
  // Move the existing control instead of duplicating its persistence/i18n logic.
  languageHost.append(main.querySelector(".language-switcher")!);
  const inputs = document.createElement("section");
  inputs.className = "desktop-inputs";
  inputs.tabIndex = 0;
  inputs.setAttribute("aria-label", "配装参数 / Loadout parameters");
  const output = document.createElement("section");
  output.className = "desktop-output";
  output.tabIndex = 0;
  output.setAttribute("aria-label", "求解结果 / Solver results");
  const content = document.createElement("div");
  content.className = "desktop-content";

  for (const selector of [".header", ".notice--free", ".solver-mode-switch",
    "#inventoryImportCard", "#upgradeBuildCard", ".workspace-grid", ".cmd-bar"]) {
    const node = main.querySelector(selector);
    if (!node) throw new Error(`Missing solver input: ${selector}`);
    inputs.append(node);
  }
  for (const selector of ["#messages", "#loading", "#resultWorkspace", ".footer"]) {
    const node = main.querySelector(selector);
    if (!node) throw new Error(`Missing solver output: ${selector}`);
    output.append(node);
  }
  // Overlays (help drawer, saved-plan drawer, save dialog, toasts) stay fixed
  // over the whole window; they are moved only so the output column owns every
  // non-input surface the renderer produces.
  for (const selector of ["#overlayScrim", "#programIntroDrawer", "#savedBuildsDrawer",
    "#saveBuildDialog", "#toastStack"]) {
    const node = main.querySelector(selector);
    if (!node) throw new Error(`Missing solver overlay: ${selector}`);
    output.append(node);
  }
  content.append(inputs, output);
  main.append(content);
  const workspace = inputs.querySelector(".workspace-grid")!;
  workspace.prepend(workspace.querySelector("#inputCard")!);
  await import("../src/app.mjs");
}

export function clickSolver(id: string) {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (button && !button.disabled) button.click();
}
