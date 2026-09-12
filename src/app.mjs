/* global __BUNGIE_OAUTH_CLIENT_ID__ */
import {
  ARCHETYPES,
  DEFAULT_TARGETS,
  EXOTIC_CLASSES,
  EXOTIC_CLASS_LABELS,
  SOLUTION_PREVIEW_COUNT,
  STATS,
  STAT_COLORS,
  STAT_LABELS,
  applyStaticTranslations,
  createExoticConfig,
  getArchetypeLabel,
  getExoticArchetypeLabel,
  getExoticLanguage,
  getExoticPerkName,
  getPageLanguage,
  icon,
  joinLocalized,
  l,
  localeCode,
  normalizeArchetypeId,
  setStatLabels,
  t,
  term,
} from "./core/armor-model.mjs";
import {
  analyzeUpgradeAsync,
  calculateReachabilityAsync,
  solveInventoryParallelAsync,
  solveLoadoutAsync,
  cancelAllSearches,
} from "./core/armor-engine-client.mjs";
import {
  createBalancedTargetPlan,
} from "./core/budget.mjs";
import {
  createTargetConstraints,
  visibleConstraintsToArmor,
} from "./core/target-constraints.mjs";
import { rankInventoryPlans } from "./core/inventory-plan.mjs";
import { createCanonicalId, createSolutionDisplayModel, assertSolutionConsistency, EXECUTION_STATUS, SOLVER_V3_SCHEMA_VERSION } from "./core/solver-v3-contract.mjs";
import {
  SAVED_BUILD_LIMIT,
  SAVED_BUILD_SCHEMA_VERSION,
  buildRepository,
} from "./core/build-repository.mjs";
import {
  BUILD_CHANNEL,
  BUILD_COMMIT_SHA,
  IS_DEVELOPMENT_BUILD,
  channelStorageKey,
} from "./core/build-channel.mjs";
import {
  UPGRADE_SLOTS,
  applyManualUpgradeModifiers,
  createUpgradePieceFromItem,
  finalizeUpgradeTotals,
  getManualUpgradeArmorTotals,
  getUpgradeConfig,
  getUpgradeModifierBudget,
  normalizeUpgradePiece,
  resolveCurrentLoadoutTotals,
} from "./core/upgrade-optimizer.mjs";
import {certifiedFeasible, proofPresentation} from "./core/solver-presentation.mjs";
import {
  EXECUTION_BLOCK_CATEGORY,
  summarizeBlockedReasons,
} from "./core/armor-mod-assignment.mjs";

let searchProfile = "balanced";
let searchUiRevision = 0;
let lastSearchResult = null;
function searchProofLabel(result, search = result?.search) {
  const labels = {
    exact: ['精确解 · 已证明','精確解 · 已證明','Exact solution · proven'],
    feasible: ['满足规则 · 已证明','滿足規則 · 已證明','Rules satisfied · proven'],
    feasibleSearching: ['满足规则 · 搜索未完成','滿足規則 · 搜尋未完成','Rules satisfied · search incomplete'],
    infeasible: ['已证明不可行','已證明不可行','Infeasibility proven'],
    limited: ['未找到达标解 · 已达到搜索上限','未找到達標解 · 已達搜尋上限','No qualifying solution · search limit reached'],
    searching: ['继续搜索中 · 当前候选未达标','繼續搜尋中 · 目前候選未達標','Searching · current candidate does not meet rules'],
    invalid: ['输入无效 · 请检查条件','輸入無效 · 請檢查條件','Invalid input · check the constraints'],
    unverified: ['尚未验证 · 请重新求解','尚未驗證 · 請重新求解','Not verified · solve again'],
  };
  return l(...labels[proofPresentation(result, search).key]);
}
// Inventory existence is a different proposition from theoretical feasibility.
// Its proof and termination stay local to the owned-armor message/results.
function inventoryProofLabel(result, search = result?.search) {
  const proof = proofPresentation(result, search);
  const labels = {
    EXACT_TARGET_PROVEN: ['已有护甲：找到无需刷取的精确组合 · 已证明','已有防具：找到無需取得新防具的精確組合 · 已證明','Owned armor: exact no-farming loadout found · proven'],
    RULE_FEASIBLE_PROVEN: ['已有护甲：找到无需刷取的达标组合 · 已证明','已有防具：找到無需取得新防具的達標組合 · 已證明','Owned armor: qualifying no-farming loadout found · proven'],
    INFEASIBLE_PROVEN: ['已有护甲：已证明不存在无需刷取的达标组合','已有防具：已證明不存在無需取得新防具的達標組合','Owned armor: no qualifying no-farming loadout exists · proven'],
    SEARCH_LIMIT_REACHED: ['已有护甲：暂未找到无需刷取的达标组合','已有防具：暫未找到無需取得新防具的達標組合','Owned armor: no qualifying no-farming loadout found yet'],
    INVALID_INPUT: ['已有护甲：输入无效 · 请检查条件','已有防具：輸入無效 · 請檢查條件','Owned armor: invalid input · check the constraints'],
  };
  const label = l(...(labels[proof.status] ||
    ['已有护甲：尚未验证','已有防具：尚未驗證','Owned armor: not verified']));
  const termination = proof.running ? 'running' : proof.termination;
  const endings = {
    running: ['库存搜索进行中','庫存搜尋進行中','Inventory search running'],
    completed: ['库存搜索已完成','庫存搜尋已完成','Inventory search completed'],
    budget: ['库存搜索已达到上限','庫存搜尋已達到上限','Inventory search limit reached'],
    cancelled: ['库存搜索已取消','庫存搜尋已取消','Inventory search cancelled'],
  };
  return endings[termination] ? `${label} · ${l(...endings[termination])}` : label;
}
// Command Bar is owned exclusively by the global/theory search.
function renderSearchStatus(result, search = result?.search) {
  if (result) lastSearchResult = result;
  const status = document.getElementById('searchStatus');
  if (!status) return;
  status.textContent = result ? searchProofLabel(result, search)
    : l('正在搜索…','正在搜尋…','Searching…');
  document.getElementById('searchStatistics').textContent = search
    ? `${Math.round(search.elapsedMs)} ms · ${search.nodes.toLocaleString()} ${l('节点','節點','nodes')}` : '';
  document.getElementById('cancelSearch').disabled = !search?.running;
}
function beginSearch() {
  lastSearchResult = null;
  const revision = ++searchUiRevision;
  renderSearchStatus(null, {running: true, elapsedMs: 0, nodes: 0});
  return revision;
}

function setSearchProfile(value) {
  stopSearches();
  searchProfile = ['fast','balanced','deep'].includes(value) ? value : 'balanced';
  saveCurrentDraft();
  renderSearchControls();
}
function renderSearchControls() {
  document.getElementById('searchProfileLabel').textContent = l('搜索深度','搜尋深度','Search depth');
  const select = document.getElementById('searchProfile');
  ['fast','balanced','deep'].forEach((mode, index) => {
    select.options[index].textContent = l(...{
      fast: ['快速','快速','Fast'], balanced: ['均衡','均衡','Balanced'], deep: ['深度','深度','Deep'],
    }[mode]);
  });
  select.value = searchProfile;
  document.getElementById('cancelSearch').textContent = l('停止搜索','停止搜尋','Stop search');
  document.getElementById('searchProfileHelp').textContent = searchProfile === 'deep'
    ? l('每项搜索预算 120 秒，扩大搜索并尝试证明。可随时停止；搜索未完成不代表无解。','每項搜尋預算 120 秒，擴大搜尋並嘗試證明。可隨時停止；搜尋未完成不代表無解。','120-second budget per search; wider search and proof attempts. Stop at any time; an incomplete search does not mean impossible.')
    : searchProfile === 'fast' ? l('约 200 ms 搜索预算，优先返回已验证候选。','約 200 ms 搜尋預算，優先回傳已驗證候選。','About 200 ms search budget; verified candidates first.')
      : l('先显示已验证结果，再继续搜索至 3 秒。','先顯示已驗證結果，再繼續搜尋至 3 秒。','Show verified results first, then continue searching for up to 3 seconds.');
  syncCommandBarLabels();
}
function stopSearches() {
  searchUiRevision++;
  cancelAllSearches();
  document.getElementById('loading')?.classList.remove('show');
  document.getElementById('btnSolve')?.removeAttribute('disabled');
  document.getElementById('btnUpgradeAnalyze')?.removeAttribute('disabled');
  document.querySelectorAll('.set-requirement-head select').forEach(control => { control.disabled = false; });
  if (lastSearchResult?.search) lastSearchResult.search = {...lastSearchResult.search, running: false, termination: 'cancelled'};
  document.getElementById('cancelSearch')?.setAttribute('disabled', '');
  const status = document.getElementById('searchStatus');
  if (status) status.textContent = l('搜索已停止，已验证结果保留','搜尋已停止，已驗證結果保留','Search stopped; verified results retained');
}
import {
  detectEquippedClass,
  filterArmorItems,
  normalizeDimItem,
  parseCsv,
  pickCurrentLoadout,
} from "./core/dim-csv.mjs";
import {
  ApiError,
  ApiKeyError,
  FatalTokenError,
  NetworkError,
  NoMembershipError,
  ThrottleError,
  buildAuthorizeUrl,
  bungieFetch,
  clearToken,
  exchangeCodeForToken,
  getToken,
  hasToken,
  resolveMemberships,
  saveToken,
} from "./core/bungie-api.mjs";
import {
  ARMOR_COMPONENTS,
  buildArmorInventory,
  extractSubclassFragments,
} from "./core/bungie-inventory.mjs";
import {
  LOADOUT_WRITE_COMPONENTS,
  BungieLoadoutApplyError,
  applyBungieArmorItemAction,
  applyCustomLoadoutPlan,
  buildBungieArmorItemActionPlan,
  buildCustomLoadoutPlan,
  equipSavedLoadout,
  extractBungieLoadoutState,
  getFragmentAdjustments,
  mapSavedLoadoutArmor,
} from "./core/bungie-loadout.mjs";
import {
  getActiveSetBonuses,
  getArmorSetByHash,
  getSetBonusText,
  getSetCategoryName,
  getSetMeta,
  getSetName,
  getSetPieceCounts,
  listArmorSets,
} from "./core/armor-sets.mjs";
import { ARMOR_SET_CATEGORY_ORDER } from "./core/armor-sets.data.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./core/armor-mods.data.mjs";

document.documentElement.dataset.buildChannel = BUILD_CHANNEL;
if (IS_DEVELOPMENT_BUILD) {
  const banner = document.getElementById("developmentBuildBanner");
  const commit = document.getElementById("developmentBuildCommit");
  if (commit) commit.textContent = BUILD_COMMIT_SHA.slice(0, 7) || "LOCAL";
  if (banner) banner.hidden = false;
  document.title = `DEV · ${document.title}`;
}

let lastTargets = null;
let lastFragments = null;
let lastNumPlus5 = 0;
let lastNumPlus10 = 0;
let lastNumPlus3 = 0;
let allSolutions = [];
let currentSolutionIdx = 0;
let lastExoticSettings = null;

// Per-stat priority (1=high, 2=mid, 3=low; 0 = none, key omitted) and fuzzy
// constraint mode ('=' exact, '>=' at-least, '<=' at-most, 'range' min–max).
// Both apply to the from-scratch solver (normal and Exotic Class Item modes).
let statPriority = {};
let statFuzzyMode = {};
const FUZZY_MODE_ORDER = ['=', '>=', '<=', 'range'];
const FUZZY_MODE_SYMBOL = { '=': '=', '>=': '≥', '<=': '≤', 'range': '↔' };

function getUpgradeStatOptions(selectedValue, excludedValue = '') {
  return STATS
    .filter(stat => stat !== excludedValue)
    .map(stat => `<option value="${stat}" ${stat === selectedValue ? 'selected' : ''}>${STAT_LABELS[stat]}</option>`)
    .join('');
}

// ============================================================
// UI HELPERS
// ============================================================

function priorityLevelName(level) {
  return l(
    ['无', '高', '中', '低'][level] || '无',
    ['無', '高', '中', '低'][level] || '無',
    ['None', 'High', 'Mid', 'Low'][level] || 'None'
  );
}

function fuzzyModeName(mode) {
  return l(
    { '=': '精确', '>=': '至少', '<=': '至多', range: '区间' }[mode] || '精确',
    { '=': '精確', '>=': '至少', '<=': '至多', range: '區間' }[mode] || '精確',
    { '=': 'Exact', '>=': 'At least', '<=': 'At most', range: 'Range' }[mode] || 'Exact'
  );
}

function getStatInputHTML(prefix, stat, val) {
  const isUpgradeRequired = upgradeRequiredStats.includes(stat);
  const priority = statPriority[stat] || 0;
  const fuzzy = statFuzzyMode[stat] || '=';
  const priorityTitle = `${l('优先级', '優先級', 'Priority')}：${priorityLevelName(priority)}`;
  const fuzzyTitle = `${l('规则', '規則', 'Rule')}：${fuzzyModeName(fuzzy)}`;
  return `
    <div class="input-group target-stat-group">
      <div class="stat-label" style="color:${STAT_COLORS[stat]};display:flex;align-items:center;justify-content:space-between;">
        <span class="icon-text stat-name target-stat-name">${icon(stat)}<span>${STAT_LABELS[stat]}</span></span>
        <label class="lock-control exotic-only">
          <input type="checkbox" id="targetLock_${stat}" aria-label="${STAT_LABELS[stat]} ${t('lock')}" style="accent-color:var(--accent);width:13px;height:13px;">${icon('lock', { size: 'sm' })}<span>${t('lock')}</span>
        </label>
        <label class="required-control">
          <input type="checkbox" id="upgradeRequired_${stat}" ${isUpgradeRequired ? 'checked' : ''}
            aria-label="${STAT_LABELS[stat]} ${t('upgradeRequiredStat')}"
            onchange="updateUpgradeRequiredStat('${stat}',this.checked)"><span class="required-label-long">${t('upgradeRequiredStat')}</span><span class="required-label-short">${t('upgradeRequiredStatShort')}</span>
        </label>
      </div>
      <input type="number" id="${prefix}_${stat}" value="${val||0}" aria-describedby="rangeHint_${stat}"
        inputmode="numeric" min="0" max="200" aria-label="${STAT_LABELS[stat]}"
        style="border-color:${(val||0)!==0?STAT_COLORS[stat]:'var(--border)'}">
      <input type="number" id="targetMax_${stat}" value="0" class="range-max-input"${fuzzy !== 'range' ? ' hidden' : ''}
        inputmode="numeric" min="0" max="200" aria-label="${STAT_LABELS[stat]} ${l('上限', '上限', 'max')}"
        placeholder="${l('上限', '上限', 'max')}">
      <div class="stat-range-hint" id="rangeHint_${stat}" aria-live="polite"></div>
      <div class="stat-mode-controls" role="group" aria-label="${STAT_LABELS[stat]} ${l('优先级与规则', '優先級與規則', 'priority and rule')}">
        <button type="button" class="stat-mode-control priority-badge${priority ? ' is-active' : ''}" id="priorityBadge_${stat}" data-level="${priority}" onclick="cyclePriority('${stat}')" title="${priorityTitle}" aria-label="${priorityTitle}">
          <span class="stat-mode-label">${l('优先', '優先', 'Priority')}</span><span class="stat-mode-value">${priorityLevelName(priority)}</span>
        </button>
        <button type="button" class="stat-mode-control fuzzy-badge${fuzzy !== '=' ? ' is-active' : ''}" id="fuzzyBadge_${stat}" data-mode="${fuzzy}" onclick="cycleFuzzyMode('${stat}')" title="${fuzzyTitle}" aria-label="${fuzzyTitle}">
          <span class="stat-mode-label">${l('规则', '規則', 'Rule')}</span><span class="stat-mode-value">${FUZZY_MODE_SYMBOL[fuzzy]} ${fuzzyModeName(fuzzy)}</span>
        </button>
      </div>
    </div>`;
}

function syncPriorityUI(stat) {
  const badge = document.getElementById('priorityBadge_' + stat);
  if (!badge) return;
  const level = statPriority[stat] || 0;
  const value = badge.querySelector('.stat-mode-value');
  if (value) value.textContent = priorityLevelName(level);
  badge.dataset.level = String(level);
  badge.classList.toggle('is-active', level > 0);
  const title = `${l('优先级', '優先級', 'Priority')}：${priorityLevelName(level)}`;
  badge.title = title;
  badge.setAttribute('aria-label', title);
}

function cyclePriority(stat) {
  const current = statPriority[stat] || 0;
  const next = (current + 1) % 4;
  if (next === 0) delete statPriority[stat];
  else statPriority[stat] = next;
  syncPriorityUI(stat);
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function syncStatModeUI(stat) {
  const badge = document.getElementById('fuzzyBadge_' + stat);
  const maxInput = document.getElementById('targetMax_' + stat);
  const mode = statFuzzyMode[stat] || '=';
  if (badge) {
    const value = badge.querySelector('.stat-mode-value');
    if (value) value.textContent = `${FUZZY_MODE_SYMBOL[mode]} ${fuzzyModeName(mode)}`;
    badge.dataset.mode = mode;
    badge.classList.toggle('is-active', mode !== '=');
    const title = `${l('规则', '規則', 'Rule')}：${fuzzyModeName(mode)}`;
    badge.title = title;
    badge.setAttribute('aria-label', title);
  }
  if (maxInput) maxInput.hidden = mode !== 'range';
}

function cycleFuzzyMode(stat) {
  const current = statFuzzyMode[stat] || '=';
  const index = FUZZY_MODE_ORDER.indexOf(current);
  const next = FUZZY_MODE_ORDER[(index + 1) % FUZZY_MODE_ORDER.length];
  if (next === '=') delete statFuzzyMode[stat];
  else statFuzzyMode[stat] = next;
  syncStatModeUI(stat);
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function renderInputs() {
  const targetGrid = document.getElementById('targetGrid');
  targetGrid.innerHTML = STATS.map(s => getStatInputHTML('target', s, DEFAULT_TARGETS[s])).join('');
  const fragGrid = document.getElementById('fragmentGrid');
  fragGrid.innerHTML = STATS.map(s => `
    <div class="input-group fragment-stat-control">
      <label class="icon-text stat-name fragment-stat-name" style="color:${STAT_COLORS[s]}">${icon(s)}<span>${STAT_LABELS[s]}</span></label>
      <div class="fragment-stepper">
        <button type="button" class="icon-btn" onclick="adjFragment('${s}',-10)" aria-label="${STAT_LABELS[s]} -10" title="${STAT_LABELS[s]} -10">${icon('caret-down')}</button>
        <span id="fragVal_${s}" class="fragment-value">0</span>
        <button type="button" class="icon-btn" onclick="adjFragment('${s}',10)" aria-label="${STAT_LABELS[s]} +10" title="${STAT_LABELS[s]} +10">${icon('caret-up')}</button>
      </div>
    </div>`).join('');
  updateBudget();
}

function resetTargetStats() {
  for (const stat of STATS) {
    const input = document.getElementById('target_' + stat);
    if (input) {
      input.value = DEFAULT_TARGETS[stat];
      input.style.borderColor = DEFAULT_TARGETS[stat] !== 0 ? STAT_COLORS[stat] : 'var(--border)';
    }
    const lock = document.getElementById('targetLock_' + stat);
    if (lock) lock.checked = false;
    const required = document.getElementById('upgradeRequired_' + stat);
    if (required) required.checked = false;
    const maxInput = document.getElementById('targetMax_' + stat);
    if (maxInput) maxInput.value = 0;
    delete statPriority[stat];
    delete statFuzzyMode[stat];
    syncPriorityUI(stat);
    syncStatModeUI(stat);
  }
  upgradeRequiredStats = [];
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
  saveUpgradeDraft();
}

function adjFragment(stat, delta) {
  const el = document.getElementById('fragVal_' + stat);
  let val = parseInt(el.textContent) || 0;
  val += delta;
  el.textContent = val;
  el.style.color = val !== 0 ? STAT_COLORS[stat] : '';
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
  saveUpgradeDraft();
  updateUpgradeBudgetSummary();
}

function getVal(id) { return parseInt(document.getElementById(id)?.value) || 0; }
function getFragVal(stat) { return parseInt(document.getElementById('fragVal_' + stat)?.textContent) || 0; }

function getTargetBudgetUsage(budget) {
  let targetSum = 0;
  let armorNeeded = 0;
  for (const stat of STATS) {
    const target = getVal('target_' + stat);
    const fragment = getFragVal(stat);
    targetSum += target;
    armorNeeded += target === 0 ? 0 : Math.max(0, target - fragment);
  }
  return { targetSum, armorNeeded, diff: armorNeeded - budget };
}

// Find an exact budget match while ensuring every value changed by the
// automatic action lands on a multiple of 5. A small dynamic program lets the
// reductions stay balanced without falling back to one-point adjustments.
function getBalancedTargetPlan(budget) {
  const targets = Object.fromEntries(STATS.map(s => [s, getVal('target_' + s)]));
  const fragments = Object.fromEntries(STATS.map(s => [s, getFragVal(s)]));
  const lockedStats = STATS.filter(
    stat => document.getElementById('targetLock_' + stat)?.checked
  );
  return createBalancedTargetPlan({
    targets,
    fragments,
    lockedStats,
    budget,
  });
}

function isOnlyPlus5Tuning() {
  return document.getElementById('onlyPlus5Tuning')?.checked === true;
}

function getEnabledPlus3Count() {
  if (isOnlyPlus5Tuning()) return 0;
  return document.getElementById('usePlus3')?.checked ? (getPlus3Count() || 0) : 0;
}

function syncPlus3PreferenceUI() {
  const onlyPlus5 = isOnlyPlus5Tuning();
  const plus3 = document.getElementById('usePlus3');
  const countRow = document.getElementById('plus3CountRow');
  if (plus3) {
    plus3.disabled = onlyPlus5;
    if (onlyPlus5) plus3.setAttribute('aria-describedby', 'onlyPlus5TuningHint');
    else plus3.removeAttribute('aria-describedby');
  }
  if (countRow) {
    countRow.style.display = !onlyPlus5 && plus3?.checked ? 'flex' : 'none';
    countRow.setAttribute('aria-hidden', String(onlyPlus5 || !plus3?.checked));
  }
  document.querySelector('.plus3-panel')?.classList.toggle('is-plus5-only', onlyPlus5);
}

function updateBudget() {
  const n5 = getVal('numPlus5');
  const n10 = getVal('numPlus10');
  const n3 = getEnabledPlus3Count();
  const budget = 450 + n3 * 3 + n5 * 5 + n10 * 10;
  const modBudget = n3 * 3 + n5 * 5 + n10 * 10;
  document.getElementById('budgetInfo').innerHTML = l(
    `<span>属性总预算</span><strong>${budget}</strong><small>基础 450 + 模组 ${modBudget}</small>`,
    `<span>數值總預算</span><strong>${budget}</strong><small>基礎 450 + 模組 ${modBudget}</small>`,
    `<span>Total stat budget</span><strong>${budget}</strong><small>450 base + ${modBudget} from mods</small>`
  );

  // Compute armor needed vs budget (with fragments factored in)
  const { targetSum, armorNeeded, diff } = getTargetBudgetUsage(budget);
  const sumEl = document.getElementById('targetSumDisplay');
  if (targetSum > 0) {
    const balancePlan = diff === 0 ? null : getBalancedTargetPlan(budget);
    const fixBtn = diff === 0 ? '' :
      `<button class="btn budget-fix-btn" onclick="balanceTargetsToBudget()"${balancePlan ? '' : ' disabled'}>`
      + `${icon('refresh')}${l(
          diff > 0 ? '自动降低至预算' : '自动补足至预算',
          diff > 0 ? '自動降低至預算' : '自動補足至預算',
          diff > 0 ? 'Trim to budget' : 'Fill to budget'
        )}</button>`;

    let tone, mark, deltaLabel, guidance;
    if (diff > 0) {
      tone = 'health';
      mark = 'block';
      deltaLabel = l(`超出 ${diff} 点`, `超出 ${diff} 點`, `${diff} points over`);
      guidance = balancePlan ? l(
        '按 5 点步进均匀降低未锁定目标',
        '按 5 點步進平均降低未鎖定目標',
        'Evenly trims unlocked targets in steps of 5'
      ) : l(
        '锁定项或预算尾数导致无法按 5 点步进自动匹配',
        '鎖定項或預算尾數導致無法按 5 點步進自動匹配',
        'Locks or the budget remainder prevent an exact step-of-5 match'
      );
    } else if (diff < 0) {
      tone = 'warning';
      mark = 'warn';
      deltaLabel = l(`剩余 ${-diff} 点`, `剩餘 ${-diff} 點`, `${-diff} points unused`);
      guidance = balancePlan ? l(
        '按 5 点步进均匀补足未锁定目标',
        '按 5 點步進平均補足未鎖定目標',
        'Evenly fills unlocked targets in steps of 5'
      ) : l(
        '锁定项或预算尾数导致无法按 5 点步进自动匹配',
        '鎖定項或預算尾數導致無法按 5 點步進自動匹配',
        'Locks or the budget remainder prevent an exact step-of-5 match'
      );
    } else {
      tone = 'success';
      mark = 'check';
      deltaLabel = l('刚好匹配', '剛好匹配', 'Exact match');
      guidance = l('目标总值与当前预算一致', '目標總值與目前預算一致', 'Targets match the current budget');
    }
    sumEl.innerHTML = `<div class="budget-balance is-${tone}">`
      + `${icon(mark)}<div class="budget-balance-content">`
      + `<div class="budget-balance-head"><div class="budget-equation">`
      + `<span>${l('护甲需求', '防具需求', 'Armor need')}</span><strong>${armorNeeded}</strong>`
      + `<span class="budget-equation-arrow" aria-hidden="true">→</span>`
      + `<span>${l('预算', '預算', 'Budget')}</span><strong>${budget}</strong>`
      + `</div><span class="budget-delta">${deltaLabel}</span></div>`
      + `<div class="budget-balance-foot"><span class="budget-guidance">${guidance}</span>${fixBtn}</div>`
      + `</div></div>`;
    sumEl.style.cssText = 'display:block;';
  } else {
    sumEl.style.display = 'none';
  }

  // Show per-stat minimums always (based on n3 and fragments)
  const minsDiv = document.getElementById('statMins');
  const armorBase = n3 * 6;
  const availSlots = 5 - n3;
  const noTuneBase = armorBase + availSlots * 5;

  // Count total -5 slots needed by all below-baseline targets
  let totalNeeded = 0;
  const slotInfo = [];
  for (const s of STATS) {
    const adj = Math.max(0, (getVal('target_' + s) || 0) - getFragVal(s));
    if (adj < noTuneBase) {
      const deficit = noTuneBase - adj;
      const needed = Math.ceil(deficit / 5);
      totalNeeded += needed;
      slotInfo.push({ s, adj, deficit, needed });
    }
  }
  const slotsOK = totalNeeded <= availSlots;
  let lines = [];
  for (const s of STATS) {
    const f = getFragVal(s);
    const finalMin = Math.max(0, armorBase + f);
    const tval = getVal('target_' + s);
    const below = tval > 0 && tval < finalMin;
    lines.push(l(
      `<span class="minimum-stat${below ? ' is-invalid' : ''}"><span style="color:${STAT_COLORS[s]}">${STAT_LABELS[s]}</span><strong>${finalMin}</strong>${below ? `<em>目标 ${tval} 过低</em>` : ''}</span>`,
      `<span class="minimum-stat${below ? ' is-invalid' : ''}"><span style="color:${STAT_COLORS[s]}">${STAT_LABELS[s]}</span><strong>${finalMin}</strong>${below ? `<em>目標 ${tval} 過低</em>` : ''}</span>`,
      `<span class="minimum-stat${below ? ' is-invalid' : ''}"><span style="color:${STAT_COLORS[s]}">${STAT_LABELS[s]}</span><strong>${finalMin}</strong>${below ? `<em>target ${tval} is too low</em>` : ''}</span>`
    ));
  }
  const hasBelowMinimum = STATS.some(s => {
    const tval = getVal('target_' + s);
    return tval > 0 && tval < Math.max(0, armorBase + getFragVal(s));
  });
  const baseExplain = n3 > 0
    ? l(
      `每件+3护甲：大师杰作5 + 免费1 = <strong>6点</strong>，${n3}件 × 6 = <strong>${armorBase}点</strong>。`,
      `每件+3防具：大師之作5 + 免費1 = <strong>6點</strong>，${n3}件 × 6 = <strong>${armorBase}點</strong>。`,
      `Each +3 armor piece: 5 Masterwork + 1 free point = <strong>6</strong>; ${n3} × 6 = <strong>${armorBase}</strong>.`
    )
    : l(
      `未启用+3模式，+5/-5调整可将属性降至0，护甲基础最低<strong>0点</strong>。`,
      `未啟用+3模式，+5/-5調校可將數值降至0，防具基礎最低<strong>0點</strong>。`,
      `Without +3 mode, +5/-5 Tuning can reduce a stat to 0; the minimum armor base is <strong>0</strong>.`
    );
  const needsAttention = hasBelowMinimum || !slotsOK;
  minsDiv.innerHTML = `
    <details class="minimum-details" ${needsAttention ? 'open' : ''}>
      <summary>
        <span class="minimum-summary-label">${l('各属性最低可达值','各數值最低可達值','Minimum reachable stats')}</span>
        <span class="minimum-summary-status${needsAttention ? ' is-warning' : ''}">${needsAttention
          ? l('需要检查','需要檢查','Needs attention')
          : l('按需展开','按需展開','Expand for details')}</span>
      </summary>
      <div class="minimum-content">
        <div>${baseExplain}</div>
        <div class="minimum-stat-list">${lines.join('')}</div>
        <div class="tuning-slot-status${!slotsOK ? ' is-error' : ''}">
          ${(() => {
            if (availSlots === 0) return icon('hint') + ' ' + l(
              `全部5件使用+3模式，无-5调整槽可用。所有属性最低为护甲基础${armorBase}点+碎片。`,
              `全部5件使用+3模式，沒有-5調校欄位可用。所有數值最低為防具基礎${armorBase}點+碎片。`,
              `All five pieces use +3 mode, so no -5 Tuning slot is available. Every stat minimum is ${armorBase} armor points plus Fragments.`
            );
            if (!slotsOK) {
              const slotLines = slotInfo.map(d => l(
                `${STAT_LABELS[d.s]}需${d.needed}个-5槽（设为${getVal('target_'+d.s)}，比基准${noTuneBase}低${d.deficit}）`,
                `${STAT_LABELS[d.s]}需${d.needed}個-5欄位（設為${getVal('target_'+d.s)}，比基準${noTuneBase}低${d.deficit}）`,
                `${STAT_LABELS[d.s]} needs ${d.needed} -5 slot(s) (target ${getVal('target_'+d.s)}, ${d.deficit} below baseline ${noTuneBase})`
              )
              ).join('<br>');
              return `<span style="color:var(--health);">${icon('block')} ` + l(
                `<strong>调整槽不足！</strong>${availSlots}个槽可用，但需${totalNeeded}个：<br>${slotLines}<br>请提高低属性目标或增加+3件数。`,
                `<strong>調校欄位不足！</strong>${availSlots}個欄位可用，但需${totalNeeded}個：<br>${slotLines}<br>請提高低數值目標或增加+3件數。`,
                `<strong>Not enough Tuning slots.</strong> ${availSlots} available, ${totalNeeded} required:<br>${slotLines}<br>Raise low targets or use more +3 pieces.`
              ) + '</span>';
            }
            return icon('check') + ' ' + l(
              `调整槽足够（${availSlots}个，已用${totalNeeded}个）。基准为${noTuneBase}点，低于该值的属性由-5调整压低。`,
              `調校欄位足夠（${availSlots}個，已用${totalNeeded}個）。基準為${noTuneBase}點，低於該值的數值由-5調校壓低。`,
              `Tuning slots are sufficient (${totalNeeded} of ${availSlots} used). Baseline: ${noTuneBase}; -5 Tuning lowers stats below it.`
            );
          })()}
        </div>
      </div>
    </details>`;
  minsDiv.style.display = 'block';
  if (calculatorMode === 'upgrade') updateUpgradeTargetBudget();
}

// The solver only accepts targets whose armor requirement equals the budget.
// Spread the surplus/deficit across unlocked stats so the user does not have to
// do the arithmetic by hand. Locked stats and the 0-200 range are respected.
function balanceTargetsToBudget() {
  const n5 = getVal('numPlus5');
  const n10 = getVal('numPlus10');
  const n3 = getEnabledPlus3Count();
  const budget = 450 + n3 * 3 + n5 * 5 + n10 * 10;

  const targets = getBalancedTargetPlan(budget);
  if (!targets) return;

  for (const s of STATS) {
    const input = document.getElementById('target_' + s);
    if (input) input.value = targets[s];
  }
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function togglePlus3() {
  if (isOnlyPlus5Tuning()) document.getElementById('usePlus3').checked = false;
  syncPlus3PreferenceUI();
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function toggleOnlyPlus5Tuning() {
  if (isOnlyPlus5Tuning()) document.getElementById('usePlus3').checked = false;
  syncPlus3PreferenceUI();
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function sync5to10() {
  let n5 = Math.max(0, Math.min(5, getVal('numPlus5')));
  document.getElementById('numPlus5').value = n5;
  document.getElementById('numPlus10').value = 5 - n5;
  updateBudget();
}

function sync10to5() {
  let n10 = Math.max(0, Math.min(5, getVal('numPlus10')));
  document.getElementById('numPlus10').value = n10;
  document.getElementById('numPlus5').value = 5 - n10;
  updateBudget();
}

function adjPlus3(delta) {
  const el = document.getElementById('plus3CountVal');
  let val = parseInt(el.textContent) || 1;
  val = Math.max(1, Math.min(5, val + delta));
  el.textContent = val;
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
}

function getPlus3Count() {
  return parseInt(document.getElementById('plus3CountVal')?.textContent) || 1;
}

function getFragments() {
  const f = {};
  for (const s of STATS) f[s] = getFragVal(s);
  return f;
}

function toggleExoticMode({ syncInventory = true, refreshInventory = true } = {}) {
  invalidateOwnedPlanCache();
  const enabled = document.getElementById('useExoticMode')?.checked;
  const showSettings = enabled && calculatorMode !== 'upgrade';
  document.getElementById('exoticSettingsBody').style.display = showSettings ? 'block' : 'none';
  // Lock is an Exotic-only control; reveal it and, when leaving Exotic mode,
  // clear any stale locks so they cannot leak into auto-balance protection.
  document.getElementById('inputCard')?.classList.toggle('is-exotic-mode', enabled);
  if (!enabled) {
    for (const stat of STATS) {
      const lock = document.getElementById('targetLock_' + stat);
      if (lock) lock.checked = false;
    }
  }
  if (showSettings) updateExoticFramework();
  if (syncInventory && calculatorMode === 'solve') {
    if (enabled) {
      const classId = document.getElementById('exoticClass')?.value || 'hunter';
      importClassFilter = classId;
      inventoryExoticSlotFilter = 'classItem';
      inventoryFixedExoticKey = getExoticClassItemKey(classId);
    } else if (inventoryExoticSlotFilter === 'classItem') {
      inventoryExoticSlotFilter = '';
      inventoryFixedExoticKey = '';
    }
    renderUpgradeImportPanel();
  } else {
    updateInventorySolveOptions({ refreshPlans: refreshInventory });
  }
}

function renderExoticInputs() {
  const classSelect = document.getElementById('exoticClass');
  classSelect.innerHTML = Object.entries(EXOTIC_CLASSES)
    .map(([id]) => `<option value="${id}">${EXOTIC_CLASS_LABELS[id][getExoticLanguage()]}</option>`).join('');
  classSelect.value = 'hunter';
  updateExoticPerkOptions();
}

function initializePageLanguage() {
  let language = buildRepository.readLanguage() || 'zh-chs';
  if (!['zh-chs', 'zh-cht', 'en'].includes(language)) language = 'zh-chs';
  document.getElementById('pageLanguage').value = language;
  setStatLabels(language);
  applyStaticTranslations();
}

function changePageLanguage() {
  const language = getPageLanguage();
  const controlState = document.getElementById('target_health') ? collectDraftState() : null;
  const exoticSelection = {
    classId: document.getElementById('exoticClass')?.value,
    primaryPerkId: document.getElementById('exoticPrimaryPerk')?.value,
    secondaryPerkId: document.getElementById('exoticSecondaryPerk')?.value,
  };
  setStatLabels(language);
  buildRepository.writeLanguage(language);
  applyStaticTranslations();
  renderSearchControls();
  if (controlState) {
    renderInputs();
    for (const stat of STATS) {
      document.getElementById('target_' + stat).value = controlState.targets[stat];
      const maxInput = document.getElementById('targetMax_' + stat);
      if (maxInput && controlState.targetMax?.[stat] !== undefined) {
        maxInput.value = controlState.targetMax[stat];
      }
      document.getElementById('targetLock_' + stat).checked = controlState.targetLocks[stat];
      const fragment = document.getElementById('fragVal_' + stat);
      fragment.textContent = controlState.fragments[stat];
      fragment.style.color = controlState.fragments[stat] !== 0 ? STAT_COLORS[stat] : '';
    }
  }
  const classSelect = document.getElementById('exoticClass');
  if (classSelect) {
    classSelect.innerHTML = Object.entries(EXOTIC_CLASSES)
      .map(([id]) => `<option value="${id}">${EXOTIC_CLASS_LABELS[id][language]}</option>`).join('');
    classSelect.value = EXOTIC_CLASSES[exoticSelection.classId] ? exoticSelection.classId : 'hunter';
  }
  updateExoticPerkOptions();
  if (exoticSelection.primaryPerkId) document.getElementById('exoticPrimaryPerk').value = exoticSelection.primaryPerkId;
  if (exoticSelection.secondaryPerkId) document.getElementById('exoticSecondaryPerk').value = exoticSelection.secondaryPerkId;
  updateExoticFramework();
  updateBudget();
  updateRealtimeRanges();
  renderSavedBuilds();
  renderUpgradeBuildEditor();
  renderUpgradeImportPanel();
  if (lastUpgradeAnalysis) renderUpgradeAnalysis(lastUpgradeAnalysis);
  if (lastInventoryResult?.results?.length) renderInventoryResults(lastInventoryResult);
  saveCurrentDraft();
  saveUpgradeDraft();
  if (allSolutions.length > 0 && lastTargets && lastFragments) {
    displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments);
  }
}

function getSelectedExoticClassData() {
  return EXOTIC_CLASSES[document.getElementById('exoticClass')?.value]
    || EXOTIC_CLASSES.hunter;
}

function updateExoticPerkOptions() {
  const data = getSelectedExoticClassData();
  const primary = document.getElementById('exoticPrimaryPerk');
  const secondary = document.getElementById('exoticSecondaryPerk');
  const oldPrimary = primary.value;
  const oldSecondary = secondary.value;
  const brackets = getPageLanguage() === 'en' ? [' (', ')'] : ['（', '）'];
  primary.innerHTML = data.primary.map(perk =>
    `<option value="${perk[0]}">${getExoticPerkName(perk[0], perk[1])} · ${getExoticArchetypeLabel(perk[4])}${brackets[0]}${STAT_LABELS[perk[2]]}/${STAT_LABELS[perk[3]]}${brackets[1]}</option>`
  ).join('');
  secondary.innerHTML = data.secondary
    .map(perk => `<option value="${perk[0]}">${getExoticPerkName(perk[0], perk[1])}</option>`).join('');
  primary.value = data.primary.some(perk => perk[0] === oldPrimary) ? oldPrimary : data.primary[0][0];
  secondary.value = data.secondary.some(perk => perk[0] === oldSecondary) ? oldSecondary : data.secondary[0][0];
  updateExoticFramework();
  if (document.getElementById('useExoticMode')?.checked && inventoryExoticSlotFilter === 'classItem') {
    const classId = document.getElementById('exoticClass')?.value || 'hunter';
    if (importClassFilter !== classId || inventoryFixedExoticKey !== getExoticClassItemKey(classId)) {
      importClassFilter = classId;
      inventoryFixedExoticKey = getExoticClassItemKey(classId);
      renderUpgradeImportPanel();
    }
  }
}

function updateExoticFramework() {
  const settings = getExoticSettings();
  const summary = document.getElementById('exoticFrameworkSummary');
  if (!summary || !settings) return;
  const c = settings.config;
  const frameworkText = getPageLanguage() === 'en'
    ? `Fixed archetype: ${getExoticArchetypeLabel(c.archetype)} · ${STAT_LABELS[c.primary]} 30 / ${STAT_LABELS[c.secondary]} 25 / ${STAT_LABELS[c.tertiary]} 20; all other stats are 5`
    : getPageLanguage() === 'zh-cht'
      ? `固定原型：${getExoticArchetypeLabel(c.archetype)} · ${STAT_LABELS[c.primary]} 30 / ${STAT_LABELS[c.secondary]} 25 / ${STAT_LABELS[c.tertiary]} 20；其餘三項各5`
      : `固定框架：${getExoticArchetypeLabel(c.archetype)} · ${STAT_LABELS[c.primary]} 30 / ${STAT_LABELS[c.secondary]} 25 / ${STAT_LABELS[c.tertiary]} 20；其余三项各5`;
  summary.innerHTML = `<strong>${settings.classLabel}</strong> · ${settings.primaryPerkName} + ${settings.secondaryPerkName}<br>${frameworkText}` +
    ` <a href="https://www.light.gg/db/items/${settings.itemHash}/" target="_blank" rel="noopener" style="color:var(--accent);">${t('viewLightgg')}</a>`;
}

function getExoticSettings() {
  if (!document.getElementById('useExoticMode')?.checked) return null;
  const data = getSelectedExoticClassData();
  const primary = data.primary.find(perk => perk[0] === document.getElementById('exoticPrimaryPerk')?.value) || data.primary[0];
  const secondary = data.secondary.find(perk => perk[0] === document.getElementById('exoticSecondaryPerk')?.value) || data.secondary[0];
  const primaryMeta = { id: primary[0], name: primary[1], primary: primary[2], secondary: primary[3], archetype: primary[4] };
  const secondaryMeta = { id: secondary[0], name: secondary[1], order: secondary[2] };
  return {
    classId: document.getElementById('exoticClass')?.value || 'hunter',
    classLabel: EXOTIC_CLASS_LABELS[document.getElementById('exoticClass')?.value || 'hunter'][getExoticLanguage()],
    itemHash: data.itemHash,
    primaryPerkId: primaryMeta.id,
    primaryPerkName: getExoticPerkName(primaryMeta.id, primaryMeta.name),
    secondaryPerkId: secondaryMeta.id,
    secondaryPerkName: getExoticPerkName(secondaryMeta.id, secondaryMeta.name),
    priorityOrder: [],
    config: createExoticConfig(primaryMeta, secondaryMeta),
  };
}

function buildExoticConstraints(settings, _fragments) {
  return settings ? {} : null;
}

// Whether any stat carries a priority level or a non-exact fuzzy constraint.
// When true the exact-budget validation is relaxed so the solver distributes
// the surplus/deficit by priority instead of demanding an exact sum.
function buildUserConstraints(fragments) {
  const target = Object.fromEntries(STATS.map(stat => [stat, getVal("target_" + stat)]));
  return visibleConstraintsToArmor(target, fragments, buildVisibleTargetConstraints());
}

// Use the same default-exact rules as the from-scratch solver. Required-stat
// checkboxes still provide fallback ordering when no complete plan exists.
function buildUpgradeFuzzyConstraints(fragments) {
  return buildUserConstraints(fragments);
}

function buildVisibleTargetConstraints() {
  return createTargetConstraints({modes: statFuzzyMode, priorityLevels: statPriority,
    targetValues: Object.fromEntries(STATS.map(stat => [stat, getVal('target_' + stat)])),
    maximumValues: Object.fromEntries(STATS.map(stat => [stat, getVal('targetMax_' + stat)])),
  });
}

function hasNonExactTargetRules() {
  return STATS.some(stat => (statFuzzyMode[stat] || '=') !== '=');
}

function solutionSatisfiesCurrentTargetRules(solution) {
  return certifiedFeasible(solution);
}

async function calculateExoticRanges(exoticConfig, numPlus5, numPlus10, numPlus3, fragments) {
  const reachable = await calculateReachabilityAsync({
    fixedPiece: exoticConfig,
    numPlus5,
    numPlus10,
    numPlus3,
    fragments,
    lockedTargets: {},
  });
  return reachable.ranges;
}

let realtimeRangeTimer = null;
let realtimeRangeRevision = 0;
let draftSaveTimer = null;
const nearestTargetCache = new Map();
let nearestTargetSuggestion = null;

function collectDraftState() {
  const exotic = getExoticSettings();
  const onlyPlus5Tuning = isOnlyPlus5Tuning();
  return {
    language: getPageLanguage(),
    targets: Object.fromEntries(STATS.map(s => [s, getVal('target_' + s)])),
    targetMax: Object.fromEntries(STATS.map(s => [s, getVal('targetMax_' + s)])),
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
    targetLocksExplicit: true,
    statPriority: { ...statPriority },
    statFuzzyMode: { ...statFuzzyMode },
    fragments: Object.fromEntries(STATS.map(s => [s, getFragVal(s)])),
    searchProfile,
    numPlus5: getVal('numPlus5'),
    numPlus10: getVal('numPlus10'),
    onlyPlus5Tuning,
    n3Enabled: !onlyPlus5Tuning && (document.getElementById('usePlus3')?.checked || false),
    numPlus3: getPlus3Count(),
    exotic: exotic ? {
      enabled: true,
      classId: exotic.classId,
      primaryPerkId: exotic.primaryPerkId,
      secondaryPerkId: exotic.secondaryPerkId,
      priorityOrder: exotic.priorityOrder,
    } : { enabled: false },
  };
}

function saveCurrentDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    buildRepository.writeCurrentDraft(collectDraftState());
  }, 250);
}

function loadCurrentDraft() {
  const draft = buildRepository.readCurrentDraft();
  if (!draft) return;
  searchProfile = ['fast','balanced','deep'].includes(draft.searchProfile) ? draft.searchProfile : 'balanced';
  renderSearchControls();
  const draftLanguage = draft.language || draft.exotic?.language;
  if (['zh-chs', 'zh-cht', 'en'].includes(draftLanguage) && draftLanguage !== getPageLanguage()) {
    document.getElementById('pageLanguage').value = draftLanguage;
    changePageLanguage();
  }

  for (const stat of STATS) {
    if (draft.targets && draft.targets[stat] !== undefined) {
      document.getElementById('target_' + stat).value = draft.targets[stat];
    }
    const maxInput = document.getElementById('targetMax_' + stat);
    if (maxInput && draft.targetMax && draft.targetMax[stat] !== undefined) {
      maxInput.value = draft.targetMax[stat];
    }
    if (draft.statPriority?.[stat]) statPriority[stat] = draft.statPriority[stat];
    if (draft.statFuzzyMode?.[stat]) statFuzzyMode[stat] = draft.statFuzzyMode[stat];
    const lock = document.getElementById('targetLock_' + stat);
    if (lock) {
      // Drafts saved before manual-lock behavior may contain locks that were
      // added automatically while typing. Do not restore those accidental locks.
      lock.checked = draft.targetLocksExplicit ? !!draft.targetLocks?.[stat] : false;
    }
    const fragment = document.getElementById('fragVal_' + stat);
    if (fragment && draft.fragments && draft.fragments[stat] !== undefined) {
      fragment.textContent = draft.fragments[stat];
      fragment.style.color = draft.fragments[stat] !== 0 ? STAT_COLORS[stat] : '';
    }
  }
  for (const stat of STATS) {
    syncPriorityUI(stat);
    syncStatModeUI(stat);
  }
  if (draft.numPlus5 !== undefined) document.getElementById('numPlus5').value = draft.numPlus5;
  if (draft.numPlus10 !== undefined) document.getElementById('numPlus10').value = draft.numPlus10;
  document.getElementById('onlyPlus5Tuning').checked = draft.onlyPlus5Tuning === true;
  document.getElementById('usePlus3').checked = !draft.onlyPlus5Tuning && !!draft.n3Enabled;
  if (draft.numPlus3 !== undefined) document.getElementById('plus3CountVal').textContent = draft.numPlus3;
  syncPlus3PreferenceUI();

  document.getElementById('useExoticMode').checked = !!draft.exotic?.enabled;
  toggleExoticMode();
  if (draft.exotic?.enabled) {
    if (draft.exotic.classId && EXOTIC_CLASSES[draft.exotic.classId]) {
      document.getElementById('exoticClass').value = draft.exotic.classId;
      updateExoticPerkOptions();
    }
    if (draft.exotic.primaryPerkId) document.getElementById('exoticPrimaryPerk').value = draft.exotic.primaryPerkId;
    if (draft.exotic.secondaryPerkId) document.getElementById('exoticSecondaryPerk').value = draft.exotic.secondaryPerkId;
    updateExoticFramework();
  }
  updateBudget();
  scheduleRealtimeRanges();
}

function clearRangeHints() {
  for (const stat of STATS) {
    const hint = document.getElementById('rangeHint_' + stat);
    if (!hint) continue;
    hint.textContent = '';
    hint.className = 'stat-range-hint';
  }
}

function showInvalidCombinationHints(invalidStats) {
  for (const stat of STATS) {
    const hint = document.getElementById('rangeHint_' + stat);
    if (!hint) continue;
    if (!invalidStats.includes(stat)) {
      hint.textContent = '';
      hint.className = 'stat-range-hint';
      hint.title = '';
      continue;
    }
    hint.textContent = l(
      '当前锁定组合不可达',
      '目前鎖定組合不可達',
      'Locked combination is unreachable'
    );
    hint.className = 'stat-range-hint is-active is-outside';
    hint.title = l(
      '该数值与其他锁定属性无法组成真实护甲方案',
      '此數值與其他鎖定數值無法組成真實防具方案',
      'This value cannot form a real armor combination with the other locked stats'
    );
  }
}

function getRangeValues(range) {
  if (Array.isArray(range?.values) && range.values.length > 0) {
    return [...new Set(range.values)].sort((a, b) => a - b);
  }
  if (Number.isFinite(range?.min) && Number.isFinite(range?.max)) {
    return range.min === range.max ? [range.min] : null;
  }
  return [];
}

function isReachableValue(range, value) {
  const values = getRangeValues(range);
  if (values === null) {
    if (range?.exactValuesKnown === false && value !== range.min && value !== range.max) return null;
    return value >= range.min && value <= range.max;
  }
  return values.includes(value);
}

function formatReachableRange(range) {
  const values = getRangeValues(range);
  if (values === null) {
    const suffix = range?.exactValuesKnown === false
      ? l('（中间值输入后验证）', '（中間值輸入後驗證）', ' (verify intermediate values)')
      : '';
    return `${range.min}–${range.max}${suffix}`;
  }
  if (values.length === 0) return '—';
  if (values.length === 1) return String(values[0]);

  const segments = [];
  const remaining = new Set(values);

  for (let index = 0; index < values.length;) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end++;
    if (end - index + 1 >= 5) {
      const run = values.slice(index, end + 1);
      run.forEach(value => remaining.delete(value));
      segments.push({ first: run[0], text: `${run[0]}–${run.at(-1)}` });
    }
    index = end + 1;
  }

  for (let residue = 0; residue < 5; residue++) {
    const lane = values.filter(value => remaining.has(value) && ((value % 5) + 5) % 5 === residue);
    let start = 0;
    while (start < lane.length) {
      if (start === lane.length - 1) {
        segments.push({ first: lane[start], text: String(lane[start]) });
        break;
      }
      const step = lane[start + 1] - lane[start];
      let end = start + 1;
      while (end + 1 < lane.length && lane[end + 1] - lane[end] === step) end++;
      const run = lane.slice(start, end + 1);
      if (run.length >= 3) {
        const stepText = step === 1 ? '' : l(`（步进${step}）`, `（步進${step}）`, ` (step ${step})`);
        segments.push({ first: run[0], text: `${run[0]}–${run.at(-1)}${stepText}` });
      } else {
        segments.push({
          first: run[0],
          text: run.join(l('、', '、', ', ')),
        });
      }
      start = end + 1;
    }
  }
  return segments.sort((a, b) => a.first - b.first)
    .map(segment => segment.text)
    .join(' / ');
}

function updateInlineRangeHints(ranges, _lockedStats = [], invalidStats = []) {
  for (const stat of STATS) {
    const hint = document.getElementById('rangeHint_' + stat);
    if (!hint) continue;
    const range = ranges?.[stat];
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      hint.textContent = '';
      hint.className = 'stat-range-hint';
      continue;
    }
    const target = getVal('target_' + stat);
    const reachability = isReachableValue(range, target);
    const outside = invalidStats.includes(stat) || reachability === false;
    const unverified = !outside && reachability === null;
    const rangeText = formatReachableRange(range);
    hint.textContent = l(
      `可达 ${rangeText}`,
      `可達 ${rangeText}`,
      `Reachable ${rangeText}`
    );
    hint.className = `stat-range-hint is-active${outside ? ' is-outside' : ''}${unverified ? ' is-unverified' : ''}`;
    hint.title = outside
      ? l('当前目标不是实际可达值','目前目標不是真實可達值','Current target is not an actual reachable value')
      : unverified
        ? l('该中间值会在输入后进行精确验证','該中間值會在輸入後進行精確驗證','This intermediate value will be verified after entry')
        : l('当前目标是实际可达值','目前目標是真實可達值','Current target is an actual reachable value');
    hint.setAttribute('aria-label', hint.title);
  }
}

async function getNearestTargetSuggestion(exoticSettings, numPlus5, numPlus10, numPlus3, fragments) {
  const targets = Object.fromEntries(STATS.map(stat => [
    stat, getVal('target_' + stat),
  ]));
  const cacheKey = [
    exoticSettings.config.baseStats ? STATS.map(stat => exoticSettings.config.baseStats[stat]).join(',') : '',
    numPlus5, numPlus10, numPlus3,
    STATS.map(stat => fragments[stat] || 0).join(','),
    STATS.map(stat => getVal('target_' + stat)).join(','),
    exoticSettings.priorityOrder.join(','),
    JSON.stringify(buildUserConstraints(fragments)),
  ].join('|');
  const cached = nearestTargetCache.get(cacheKey);
  if (cached) return cached;

  const result = (await solveLoadoutAsync({
    target: targets,
    fragments,
    targetDomain: 'visible',
    numPlus5,
    numPlus10,
    numPlus3,
    constraints: buildVisibleTargetConstraints(),
    exoticSettings,
    runtimeOptions: { fastMode: true },
  }))[0];
  if (!result) return null;

  const totals = Object.fromEntries(STATS.map(stat => [
    stat, Math.max(0, Math.min(200, result.totals[stat] + (fragments[stat] || 0))),
  ]));
  const distance = STATS.reduce((sum, stat) =>
    sum + Math.abs(totals[stat] - getVal('target_' + stat)), 0);
  const suggestion = { totals, distance, score: result.score };
  nearestTargetCache.set(cacheKey, suggestion);
  if (nearestTargetCache.size > 12) {
    nearestTargetCache.delete(nearestTargetCache.keys().next().value);
  }
  return suggestion;
}

function applyNearestTargetSuggestion() {
  stopSearches();
  if (!nearestTargetSuggestion) return;
  for (const stat of STATS) {
    const input = document.getElementById('target_' + stat);
    if (input) input.value = nearestTargetSuggestion.totals[stat];
  }
  updateBudget();
  updateRealtimeRanges();
  saveCurrentDraft();
}

function buildNearestSuggestionHTML(suggestion) {
  if (!suggestion) return '';
  const values = STATS.map(stat => `${STAT_LABELS[stat]} ${suggestion.totals[stat]}`);
  return `<div class="range-advice">
    <div>${l(
      '建议先使用这组可实际达成的六维目标：',
      '建議先使用這組可實際達成的六維目標：',
      'Try this reachable six-stat target instead:'
    )}</div>
    <strong>${joinLocalized(values)}</strong>
    <div style="margin-top:4px;color:var(--text-dim);">${l(
      `与当前目标总差值 ${suggestion.distance} 点；应用后仍可继续微调。`,
      `與目前目標總差值 ${suggestion.distance} 點；套用後仍可繼續微調。`,
      `Total distance from the current target: ${suggestion.distance}. You can fine-tune after applying it.`
    )}</div>
    <button class="btn" type="button" onclick="applyNearestTargetSuggestion()">${l('应用这组建议','套用這組建議','Apply suggestion')}</button>
  </div>`;
}

function resetRealtimeRangeUI() {
  realtimeRangeRevision++;
  const summary = document.getElementById('realtimeRangeSummary');
  nearestTargetSuggestion = null;
  clearRangeHints();
  if (summary) {
    summary.style.display = 'none';
    summary.innerHTML = '';
  }
}

async function updateRealtimeRanges() {
  const revision = ++realtimeRangeRevision;
  const summary = document.getElementById('realtimeRangeSummary');
  if (!summary) return;
  if (calculatorMode === 'upgrade') {
    resetRealtimeRangeUI();
    return;
  }
  const exoticSettings = getExoticSettings();
  if (!exoticSettings?.config) {
    resetRealtimeRangeUI();
    return;
  }

  const locks = STATS.filter(stat => document.getElementById('targetLock_' + stat)?.checked);
  const fragments = getFragments();
  const numPlus5 = getVal('numPlus5');
  const numPlus10 = getVal('numPlus10');
  const numPlus3 = getEnabledPlus3Count();
  const lockedTargets = Object.fromEntries(
    locks.map(stat => [stat, getVal('target_' + stat)])
  );
  let reachable;
  try {
    reachable = await calculateReachabilityAsync({
      fixedPiece: exoticSettings.config,
      numPlus5,
      numPlus10,
      numPlus3,
      fragments,
      lockedTargets,
    });
  } catch (error) {
    if (revision === realtimeRangeRevision) {
      // Every other solver call site treats an AbortError as superseded work and
      // returns quietly; this probe has to do the same. `#inputCard`'s input
      // listener (and `scheduleRealtimeRanges`, which calls `stopSearches()`)
      // cancels the in-flight probe 180ms before the next one starts, so a
      // cancellation is routine and must not be reported as a failure.
      if (error.name !== 'AbortError') {
        console.error('Reachability calculation failed', error);
      }
      // The stale hint still has to go: after a stop nothing re-probes, so
      // keeping it would describe the previous inputs.
      resetRealtimeRangeUI();
    }
    return;
  }
  if (revision !== realtimeRangeRevision) return;

  if (!certifiedFeasible(reachable) && reachable.certificate?.status !== 'INFEASIBLE_PROVEN') {
    clearRangeHints();
    summary.textContent = searchProofLabel(reachable);
    summary.style.display = 'block';
    return;
  }
  if (reachable.certificate?.status === 'INFEASIBLE_PROVEN') {
    try {
      nearestTargetSuggestion = await getNearestTargetSuggestion(
        exoticSettings, numPlus5, numPlus10, numPlus3, fragments
      );
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
      // The suggestion solve is cancelled by the same stop that cancels the
      // probe (`stopSearches()` cancels every operation). Letting the rejection
      // escape here would surface as an unhandled promise rejection, so fall
      // through and render the unreachable panel without a suggestion — the
      // reachability proof itself is unaffected. The revision check below still
      // hands the summary to a newer probe when one is on its way.
      nearestTargetSuggestion = null;
    }
    if (revision !== realtimeRangeRevision) return;
    showInvalidCombinationHints(locks);
    summary.innerHTML = `<div class="range-panel">
      <div class="range-panel-head">
        <div class="range-panel-title">${l('当前六维组合不可达','目前六維組合不可達','Current six-stat target is unreachable')}</div>
        <div class="range-panel-caption">${l('请调整锁定值或应用下方建议','請調整鎖定值或套用下方建議','Adjust the locked values or apply the suggestion below')}</div>
      </div>
      <div class="msg error" style="margin:0;">
        ${l(
          '当前锁定值没有真实可达的护甲组合。请降低标红属性，或直接应用下方建议。',
          '目前鎖定值沒有真實可達的防具組合。請降低標紅數值，或直接套用下方建議。',
          'No real armor combination reaches the locked values. Lower the red stats or apply the suggestion below.'
        )}
      </div>
      ${buildNearestSuggestionHTML(nearestTargetSuggestion)}
    </div>`;
    summary.style.display = 'block';
    return;
  }

  nearestTargetSuggestion = null;
  // Reachable ranges live inline under each stat input (rangeHint_*); a separate
  // summary grid would duplicate the same values in two places. Only the
  // unreachable error + suggestion keeps the summary element.
  updateInlineRangeHints(reachable.ranges, locks);
  summary.innerHTML = '';
  summary.style.display = 'none';
}

function scheduleRealtimeRanges() {
  stopSearches();
  clearTimeout(realtimeRangeTimer);
  if (calculatorMode === 'upgrade') {
    resetRealtimeRangeUI();
    return;
  }
  realtimeRangeTimer = setTimeout(updateRealtimeRanges, 180);
}

// ============================================================
// SOLVE
// ============================================================

async function solve() {
  const msgs = document.getElementById('messages');
  const results = document.getElementById('results');
  const loading = document.getElementById('loading');
  ownedArmorActionStatus = null;
  clearInventoryResults();
  msgs.innerHTML = '';
  delete msgs.dataset.imperfectShown;
  results.classList.remove('show');
  document.getElementById('refineCard').style.display = 'none';
  document.getElementById('floatJump').style.display = 'none';

  const targets = {};
  for (const s of STATS) targets[s] = getVal('target_' + s);
  const fragments = getFragments();
  let numPlus5 = getVal('numPlus5');
  let numPlus10 = getVal('numPlus10');
  const numPlus3 = getEnabledPlus3Count();
  const exoticSettings = getExoticSettings();
  if (exoticSettings && !exoticSettings.config) {
    msgs.innerHTML = `<div class="msg error">${icon('block')}${l(
      '异域职业物品的属性框架无效，请重新选择特性。',
      '異域職業物品的數值原型無效，請重新選擇特長。',
      'The Exotic Class Item stat archetype is invalid. Select its perks again.'
    )}</div>`;
    return;
  }

  // Store for refinement
  lastTargets = targets;
  lastFragments = fragments;
  lastNumPlus5 = numPlus5;
  lastNumPlus10 = numPlus10;
  lastNumPlus3 = numPlus3;
  lastExoticSettings = exoticSettings;
  lastNumPlus10 = numPlus10;

  // Validation: mod count
  if (numPlus5 + numPlus10 > 5) {
    const excess = numPlus5 + numPlus10 - 5;
    numPlus5 = Math.max(0, numPlus5 - excess);
    if (numPlus5 + numPlus10 > 5) numPlus10 = 5 - numPlus5;
    document.getElementById('numPlus5').value = numPlus5;
    document.getElementById('numPlus10').value = numPlus10;
    updateBudget();
    msgs.innerHTML += `<div class="msg warn">${icon('warn')}${l(
      `模组总数超过5个，已自动调整为${numPlus5}个+5 + ${numPlus10}个+10。`,
      `模組總數超過5個，已自動調整為${numPlus5}個+5 + ${numPlus10}個+10。`,
      `More than five mods were selected; adjusted to ${numPlus5} × +5 and ${numPlus10} × +10.`
    )}</div>`;
  }

  // Only the core may interpret visible targets and clamp intervals.
  const adjTarget = { ...targets };
  lastNumPlus5 = numPlus5;
  lastNumPlus10 = numPlus10;

  // Run solver
  const revision = beginSearch();
  loading.classList.add('show');
  loading.setAttribute('aria-busy', 'true');
  document.getElementById('btnSolve').disabled = true;

  try {
    const solverConstraints = buildVisibleTargetConstraints();
    // Inventory existence is a separate search, not a match against the
    // representative theory witnesses returned below. Keep both proof scopes.
    const inventoryMessage = importedInventory.length || manualOwnedItems.length
      ? await solveInventoryRequirement({targets, fragments, requiredStats: [],
        onlyPlus5Tuning: numPlus3 === 0,
        constraints: visibleConstraintsToArmor(targets, fragments, solverConstraints),
        modifierBudget: {numPlus5, numPlus10, numPlus3},
      }) : '';
    if (revision !== searchUiRevision) return;
    msgs.innerHTML = inventoryMessage || '';
    loading.classList.add('show');
    loading.setAttribute('aria-busy', 'true');
    document.getElementById('btnSolve').disabled = true;
    const solvedSolutions = await solveLoadoutAsync({
      searchProfile,
      target: adjTarget,
      fragments,
      targetDomain: 'visible',
      numPlus5,
      numPlus10,
      numPlus3,
      constraints: solverConstraints,
      exoticSettings,
    }, {onProgress: (partial, search) => {
      if (revision !== searchUiRevision) return;
      renderSearchStatus(partial, search);
      if (partial?.[0]) {
        allSolutions = partial; currentSolutionIdx = 0;
        displayAllResults(partial[0], targets, fragments, {scroll: false, refreshList: false});
      }
    }});
    if (revision !== searchUiRevision) return;
    allSolutions = solvedSolutions;
    currentSolutionIdx = 0;
    renderSearchStatus(solvedSolutions);
    // The global search state lives in the command bar and nowhere else, so the
    // theoretical proof label is not repeated as a message banner here.
    msgs.innerHTML = inventoryMessage || '';
    if (allSolutions[0]) {
      refreshInventoryPlansFromSolutions({rerender: false});
      displayAllResults(allSolutions[0], targets, fragments, {forceOwnedPlan: true, scroll: !lastInventoryResult?.results?.length});
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Armor solver failed', error);
    msgs.innerHTML += '<div class="msg error">' + icon('block') + l(
      '求解过程中发生错误，请重试。',
      '求解過程中發生錯誤，請重試。',
      'The solver failed. Please try again.'
    ) + '</div>';
  } finally {
    if (revision === searchUiRevision) {
      loading.classList.remove('show');
      loading.setAttribute('aria-busy', 'false');
      document.getElementById('btnSolve').disabled = false;
    }
  }
}

// ============================================================
// DISPLAY RESULTS
// ============================================================

function buildRefineCard(targets, finalTotals) {
  // The matrix is an editor, so switching plans or receiving a progressive
  // update must not silently discard the reader's pending constraint edits.
  const pendingEdits = new Map();
  for (const stat of STATS) {
    for (const id of [`prio_${stat}`, `le100_${stat}`, `force0_${stat}`]) {
      const control = document.getElementById(id);
      if (control) pendingEdits.set(id, control.checked);
    }
  }
  // Grid: [stat name, exact, <=100, force minimum, current diff]
  const scrollLabel = l(
    '横向滚动查看全部约束',
    '橫向捲動查看全部限制',
    'Scroll horizontally to review every constraint'
  );
  let html = `<div class="constraint-scroll-hint" aria-hidden="true">${icon('arrow-right', { size: 'sm' })}<span>${scrollLabel}</span></div>`;
  html += `<div class="constraint-matrix" role="table" tabindex="0" aria-label="${scrollLabel}"><div class="constraint-grid" role="rowgroup">`;
  html += `
    <div role="columnheader">${l('属性','數值','Stat')}</div>
    <div role="columnheader">${l('精确达成','精確達成','Exact')}<small>${l('锁定当前目标','鎖定目前目標','Match target')}</small></div>
    <div role="columnheader">${l('不超过 100','不超過 100','At most 100')}<small>${l('限制属性上限','限制數值上限','Cap the result')}</small></div>
    <div role="columnheader">${l('限制为 0','限制為 0','Require zero')}<small>${l('由求解器验证可达性','由求解器驗證可達性','Solver verifies feasibility')}</small></div>
    <div role="columnheader">${l('当前结果','目前結果','Current')}<small>${l('相对目标','相對目標','vs target')}</small></div>`;

  for (const s of STATS) {
    const diff = finalTotals[s] - targets[s];
    const notExact = diff !== 0;
    const notOver100 = finalTotals[s] <= 100;
    // Force-minimum: checked when at the achievable minimum (armor base + fragments)
    const statMin = 0;
    const atMinimum = finalTotals[s] === statMin;
    const exactLabel = l(
      `${STAT_LABELS[s]}：精确达成目标 ${targets[s]}`,
      `${STAT_LABELS[s]}：精確達成目標 ${targets[s]}`,
      `${STAT_LABELS[s]}: exactly match ${targets[s]}`
    );
    const capLabel = l(
      `${STAT_LABELS[s]}：不超过 100`,
      `${STAT_LABELS[s]}：不超過 100`,
      `${STAT_LABELS[s]}: stay at or below 100`
    );
    const minLabel = l(
      `${STAT_LABELS[s]}：限制为 ${statMin}`,
      `${STAT_LABELS[s]}：限制為 ${statMin}`,
      `${STAT_LABELS[s]}: require ${statMin}`
    );
    const status = notExact
      ? `<span class="constraint-status">${l('差','差','Off by')} ${diff > 0 ? '+' : ''}${diff}</span>`
      : `<span class="constraint-status is-met">${icon('check', { size: 'sm' })}${l('已达成','已達成','Met')}</span>`;

    html += `
      <div class="constraint-cell constraint-stat" role="rowheader" style="color:${STAT_COLORS[s]};">
        <span>${STAT_LABELS[s]}</span><small>${l('目标','目標','Target')} ${targets[s]} · ${l('当前','目前','Now')} ${finalTotals[s]}</small>
      </div>
      <label class="constraint-cell constraint-toggle" role="cell" title="${exactLabel}">
        <input type="checkbox" id="prio_${s}" aria-label="${exactLabel}" ${notExact ? '' : 'checked'} onchange="updateRefineActionState()" style="accent-color:${STAT_COLORS[s]};">
      </label>
      <label class="constraint-cell constraint-toggle" role="cell" title="${capLabel}">
        <input type="checkbox" id="le100_${s}" aria-label="${capLabel}" ${notOver100 ? 'checked' : ''} onchange="updateRefineActionState()" style="accent-color:var(--accent);">
      </label>
      <label class="constraint-cell constraint-toggle" role="cell" title="${minLabel}">
        <input type="checkbox" id="force0_${s}" aria-label="${minLabel}" ${atMinimum ? 'checked' : ''} onchange="updateRefineActionState()" style="accent-color:var(--accent);">
      </label>
      <div class="constraint-cell constraint-result" role="cell">${status}</div>`;
  }
  html += '</div></div>';
  document.getElementById('refineCheckboxes').innerHTML = html;
  for (const [id, checked] of pendingEdits) {
    const control = document.getElementById(id);
    if (control) control.checked = checked;
  }
  document.getElementById('refineCost').innerHTML = '';
  updateRefineActionState();
}

function resetConstraints() {
  for (const s of STATS) {
    const prio = document.getElementById('prio_' + s);
    const le100 = document.getElementById('le100_' + s);
    const force0 = document.getElementById('force0_' + s);
    if (prio) prio.checked = false;
    if (le100) le100.checked = false;
    if (force0) force0.checked = false;
  }
  updateRefineActionState();
}

function updateRefineActionState() {
  const button = document.getElementById('btnRefine');
  if (!button) return;
  const hasSelection = document.querySelector('#refineCheckboxes input[type="checkbox"]:checked');
  button.disabled = !hasSelection;
}

function readConstraints() {
  const priorities = {};
  const le100 = {};   // must be ≤ 100
  const force0 = {};  // must be exactly 0
  for (const s of STATS) {
    priorities[s] = document.getElementById('prio_' + s)?.checked || false;
    le100[s] = document.getElementById('le100_' + s)?.checked || false;
    force0[s] = document.getElementById('force0_' + s)?.checked || false;
  }
  return { exact: priorities, priorities: {}, le100, force0 };
}

async function refineWithPriorities() {
  if (!lastTargets || allSolutions.length === 0) return;

  const constraints = readConstraints();
  if (lastExoticSettings) {
    Object.assign(constraints, buildExoticConstraints(lastExoticSettings, lastFragments));
  }
  const hasConstraint = Object.values(constraints.exact).some(v=>v) ||
                        Object.values(constraints.le100).some(v=>v) ||
                        Object.values(constraints.force0).some(v=>v);
  if (!hasConstraint) {
    alert(l('请至少选择一个优化目标或约束条件。','請至少選擇一個最佳化目標或限制條件。','Select at least one optimization goal or constraint.'));
    return;
  }
  // Validate before entering the search UI state: an empty refinement must
  // never flash "searching…" and immediately return.
  const revision = beginSearch();

  const adjTarget = {...lastTargets};

  // Show loading
  document.getElementById('loading').classList.add('show');

  try {
    const newSolutions = await solveLoadoutAsync({
      searchProfile,
      targetDomain: 'visible',
      target: adjTarget,
      fragments: lastFragments,
      numPlus5: lastNumPlus5,
      numPlus10: lastNumPlus10,
      numPlus3: lastNumPlus3,
      constraints,
      exoticSettings: lastExoticSettings,
    }, {onProgress: (partial, search) => {
      if (revision !== searchUiRevision) return;
      renderSearchStatus(partial, search);
      if (partial?.[0]) { allSolutions = partial; currentSolutionIdx = 0; displayAllResults(partial[0], lastTargets, lastFragments, {scroll: false, refreshList: false}); }
    }});
    const newResult = newSolutions[0];
    if (revision !== searchUiRevision) return;
    if (!newResult) throw new Error('No refined armor solution found');
    if (lastExoticSettings && newResult) {
      const exoticRanges = await calculateExoticRanges(
        lastExoticSettings.config, lastNumPlus5, lastNumPlus10, lastNumPlus3, lastFragments
      );
      for (const solution of newSolutions) {
        solution.exoticRanges = exoticRanges;
        solution.priorityOrder = [...lastExoticSettings.priorityOrder];
      }
    }

    if (revision !== searchUiRevision) return;
    renderSearchStatus(newSolutions);
    // Store new solutions
    const prevResult = allSolutions[currentSolutionIdx];
    allSolutions = newSolutions;
    currentSolutionIdx = 0;
    // The legacy refinement card has its own priority/cap semantics rather than
    // the main per-stat target rules, so keep its historical score-based labels.

    // Full refresh (comparison, pieces, refine card, nav)
    displayAllResults(newResult, lastTargets, lastFragments, {forceOwnedPlan: true});

    // Add before/after cost analysis on top
    const newFinal = createSolutionDisplayModel(newResult).visibleTotals;
    const oldFinal = createSolutionDisplayModel(prevResult).visibleTotals;

    const costLines = [];
    for (const st of STATS) {
      const oldD = oldFinal[st] - lastTargets[st];
      const newD = newFinal[st] - lastTargets[st];
      if (constraints.priorities[st] || constraints.force0[st]) {
        if (newD === 0) costLines.push(`<span style="color:var(--success);">${icon('check', { size: 'sm' })} ${STAT_LABELS[st]}: ${l('达成目标','達成目標','target met')}</span>`);
        else costLines.push(`<span style="color:var(--accent);">${STAT_LABELS[st]}: ${l('差','差','off by ')}${newD>0?'+':''}${newD}</span>`);
      } else if (Math.abs(newD) > Math.abs(oldD)) {
        costLines.push(`<span style="color:var(--health);">${icon('trend-down', { size: 'sm' })} ${STAT_LABELS[st]}: ${newD>0?'+':''}${newD} (${l('为优先属性让步','為優先數值讓步','conceded for a priority stat')})</span>`);
      } else if (Math.abs(newD) < Math.abs(oldD)) {
        costLines.push(`<span style="color:var(--success);">${icon('trend-up', { size: 'sm' })} ${STAT_LABELS[st]}: ${newD>0?'+':''}${newD} (${l('附带改善','附帶改善','incidental improvement')})</span>`);
      }
    }
    document.getElementById('refineCost').innerHTML = `<div style="border-top:1px solid var(--border);padding-top:12px;"><strong>${l('代价分析：','代價分析：','Trade-off analysis:')}</strong><br>${costLines.length > 0 ? costLines.join('<br>') : l('所有属性均无显著变化。','所有數值均無顯著變化。','No significant stat changes.')}</div>`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Armor refinement failed', error);
    document.getElementById('messages').innerHTML += '<div class="msg error">' +
      icon('block') + l(
        '重新优化失败，请重试。',
        '重新最佳化失敗，請重試。',
        'Refinement failed. Please try again.'
      ) + '</div>';
  } finally {
    if (revision === searchUiRevision) document.getElementById('loading').classList.remove('show');
  }
}

function renderSolutionStatRows(counts, prefix = '') {
  return Object.entries(counts).map(([stat, count]) => `
    <div class="solution-stat-row">
      <span style="color:${STAT_COLORS[stat]};">${prefix}${STAT_LABELS[stat]}</span>
      <strong>×${count}</strong>
    </div>`).join('');
}

function renderWitnessBreakdown(witness) {
  const model = createSolutionDisplayModel(witness);
  return `<details class="witness-breakdown" data-disclosure-key="witness-${escapeHtml(model.canonicalId)}" data-canonical-id="${escapeHtml(model.canonicalId)}">
    <summary>${l('逐件复算数据', '逐件重算資料', 'Per-piece verification data')}</summary>
    ${model.pieces.map((piece, index) => `<div class="witness-piece" data-source-id="${escapeHtml(String(piece.sourceId || ''))}" data-tuning="${escapeHtml(JSON.stringify(model.tuningAssignments[index]))}" data-mod="${escapeHtml(JSON.stringify(model.modAssignments[index] || null))}" data-archetype="${escapeHtml(piece.archetype || piece.archetypeId || '')}" data-tertiary="${piece.tertiary}">
      <strong>${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === piece.slot))} · ${escapeHtml(piece.itemName || piece.archetype || piece.archetypeId || '')}</strong>
      <span>${formatUpgradeTuning(model.tuningAssignments[index])} · ${formatUpgradeArmorMod(model.modAssignments[index])}</span>
      <div>${STATS.map(stat => `<span data-base-stat="${stat}" data-value="${piece.baseStats[stat]}">${STAT_LABELS[stat]} ${piece.baseStats[stat]} </span>`).join('')}</div>
      ${piece.requiresMasterwork ? `<small>${l('需先完成大师杰作', '需先完成大師之作', 'Full masterwork required')}</small>` : ''}
    </div>`).join('')}
    <div class="witness-fragments">${l('碎片', '碎片', 'Fragments')}: ${STATS.map(stat => `<span data-fragment-stat="${stat}" data-value="${model.fragments[stat]}">${STAT_LABELS[stat]} ${model.fragments[stat]} </span>`).join('')}</div>
    <div class="witness-totals">${STATS.map(stat => `<span data-total-stat="${stat}" data-value="${model.visibleTotals[stat]}">${STAT_LABELS[stat]} ${model.visibleTotals[stat]} </span>`).join('')}</div>
  </details>`;
}

function displayAllResults(result, targets, fragments, { scroll = true, forceOwnedPlan = false, skipOwnedPlan = false, refreshList = true } = {}) {
  const restoreDetails = preserveDisclosureState(document.getElementById('results'));
  if (!skipOwnedPlan) {
    result = getOwnedArmorPlan(result, { force: forceOwnedPlan })?.matchedSolution || result;
  }
  const results = document.getElementById('results');
  results.classList.add('show');
  document.getElementById('floatJump').style.display = 'flex';
  const display = createSolutionDisplayModel(result);
  const finalTotals = display.visibleTotals;

  renderResultWarnings();
  renderTargetSummary(result, targets, finalTotals);
  renderExoticRangeSummary(result);
  buildOwnedGearSection(finalTotals, targets);
  // The constraint matrix lives inside the 编辑条件 drawer; solve() hides the
  // whole card, so every settled result must bring it back.
  const refineCard = document.getElementById('refineCard');
  if (refineCard) refineCard.style.display = 'block';
  buildRefineCard(targets, finalTotals);

  // The unified workspace is the only plan surface. Progressive partials skip
  // the rebuild: ranking every candidate on each tick is wasted work, and the
  // settled pass renders the workspace once.
  if (refreshList && calculatorMode === 'solve') renderUnifiedResults();
  restoreDetails();
  // The result on screen now matches the current inputs, so a later saved-plan
  // load will not warn about edits the user has not actually made since.
  lastCommittedInputSignature = currentInputSignature();
  // Switching plans must never yank the viewport; only an explicit new solve may
  // scroll the workspace into view. Defer by one frame because the loading
  // indicator above the workspace collapses in solve()'s finally block — scrolling
  // first would land the target strip behind the sticky command bar.
  if (scroll) requestAnimationFrame(() => results.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// The target strip is the single place the six targets and their current values
// are shown. It deliberately holds no proof wording — that belongs to the
// command bar (global search state) and the advanced panel (per-plan proof).
function renderTargetSummary(result, targets, finalTotals) {
  const compGrid = document.getElementById('comparisonGrid');
  if (compGrid) {
    compGrid.innerHTML = STATS.map(stat => {
      const target = targets[stat];
      const actual = finalTotals[stat] || 0;
      const diff = actual - target;
      const diffClass = diff === 0 ? 'good' : (diff > 0 ? 'ok' : 'bad');
      const diffText = diff === 0
        ? `${icon('check', { size: 'sm' })} ${l('精确', '精確', 'Exact')}`
        : (diff > 0 ? `+${diff}` : `${diff}`);
      return `<div class="comp-item">
        <div class="stat-label icon-text" style="color:${STAT_COLORS[stat]}">${icon(stat)}${STAT_LABELS[stat]}</div>
        <div class="stat-values">
          <span style="color:${STAT_COLORS[stat]}">${actual}</span>
          <span class="stat-target"> / ${target}</span>
        </div>
        <div class="diff ${diffClass}">${diffText}</div>
      </div>`;
    }).join('');
  }
  const meta = document.getElementById('targetSummaryMeta');
  if (meta) {
    const required = lastInventoryRequiredStats.length
      ? l(`必须达标 ${lastInventoryRequiredStats.length} 项`, `必須達標 ${lastInventoryRequiredStats.length} 項`, `${lastInventoryRequiredStats.length} must-meet`)
      : l('无必须达标项', '無必須達標項', 'No must-meet stats');
    const requirement = lastInventoryResult?.requirement || snapshotSetRequirement();
    const requirementLabel = !requirement || requirement.type === 'none'
      ? l('套装：不要求', '套裝：不要求', 'Set: none')
      : `${l('套装', '套裝', 'Set')}：${formatSetRequirementLabel(requirement)}`;
    const exotic = result?.exoticRanges
      ? l('异域：已锁定框架', '異域：已鎖定原型', 'Exotic: archetype locked')
      : '';
    meta.innerHTML = `<span>${escapeHtml(required)}</span><span>${escapeHtml(requirementLabel)}</span>${exotic ? `<span>${escapeHtml(exotic)}</span>` : ''}`;
  }
  const score = document.getElementById('scoreDisplay');
  if (score) {
    score.innerHTML = l(
      `总属性：<strong>${Object.values(finalTotals).reduce((a, b) => a + b, 0)}</strong>`,
      `總數值：<strong>${Object.values(finalTotals).reduce((a, b) => a + b, 0)}</strong>`,
      `Total stats: <strong>${Object.values(finalTotals).reduce((a, b) => a + b, 0)}</strong>`,
    );
  }
}

function renderExoticRangeSummary(result) {
  const rangeSummary = document.getElementById('exoticRangeSummary');
  if (!rangeSummary) return;
  if (!result.exoticRanges) {
    rangeSummary.innerHTML = '';
    rangeSummary.style.display = 'none';
    return;
  }
  const priorityOrder = result.priorityOrder || [];
  const rangeItems = STATS.map(stat => {
    const range = result.exoticRanges[stat];
    const rank = priorityOrder.indexOf(stat);
    const badge = rank >= 0 ? `<span style="color:var(--accent);font-size:10px;">${l('优先', '優先', 'Priority ')}${rank + 1}</span>` : '';
    return `<div class="range-item">
      <div class="icon-text range-item-label" style="color:${STAT_COLORS[stat]};justify-content:center;">${icon(stat)}${STAT_LABELS[stat]} ${badge}</div>
      <div class="range-item-value">${formatReachableRange(range)}</div>
    </div>`;
  }).join('');
  rangeSummary.innerHTML = `<div class="range-panel" style="margin-top:0;">
    <div class="range-panel-head">
      <span class="range-panel-title">${l('异域可达范围', '異域可達範圍', 'Exotic reachable ranges')}</span>
      <span class="range-panel-caption">${l(
        '固定异域职业物品框架后，逐件枚举四件传说护甲、调整模组和护甲模组得到真实可达范围（不叠加下方自定义硬约束）。',
        '固定異域職業物品原型後，逐件列舉四件傳說防具、調校模組和防具模組得到真實可達範圍（不疊加下方自訂硬性限制）。',
        'With the Exotic Class Item archetype fixed, real reachable ranges are enumerated across four Legendary armor pieces, Tuning Mods and Armor Mods.',
      )}</span>
    </div>
    <div class="range-grid">${rangeItems}</div>
  </div>`;
  rangeSummary.style.display = 'block';
}

function formatInventoryItemTuning(item) {
  if (item?.tuningMode === 'plus3') return l('+3调整', '+3調校', '+3 Tuning');
  const tuningTo = item?.tuningTo || item?.tuningStat;
  return tuningTo
    ? l(`+5${STAT_LABELS[tuningTo]} 调整`, `+5${STAT_LABELS[tuningTo]} 調校`, `+5 ${STAT_LABELS[tuningTo]} Tuning`)
    : l('调整属性未知', '調校數值未知', 'Unknown Tuning');
}

function formatInventoryPlanSet(setHash) {
  if (!setHash) return '';
  const set = getArmorSetByHash(setHash);
  return set ? getSetName(set) : String(setHash);
}

function createOwnedArmorPlanRequest(solutions, maxResults, { allowEmpty = false } = {}) {
  if (calculatorMode !== 'solve' || solutions.length === 0) return null;
  const inputs = getOwnedArmorInputs();
  if (inputs.items.length === 0 && !allowEmpty) return null;
  return {solutions, ...inputs, maxResults};
}

function getOwnedArmorInputs() {
  const classItemSettings = document.getElementById('useExoticMode')?.checked
    ? getExoticSettings()
    : null;
  const classId = classItemSettings?.classId || importClassFilter || null;
  const importedItems = classId
    ? filterArmorItems(importedInventory, { classId, tier5Only: importTier5Only })
    : [];
  const manualItems = manualOwnedItems.map(item => ({
    ...item,
    classId: item.classId || classId,
  }));
  const items = [...importedItems, ...manualItems];
  return {
    items,
    classId,
    fixedExotic: classItemSettings ? null : getSelectedInventoryExotic(),
    setRequirement: snapshotSetRequirement(),
  };
}

// Owned/farm matching is derived from {solution, physical inventory snapshot,
// class/exotic filters, set requirement}. Cache by canonical solution identity
// plus an explicit revision of every input that can mutate the match, so
// progressive partials do not re-rank a 1300-item inventory on every arrival.
let ownedPlanRevision = 0;
const ownedPlanCache = new Map();
const OWNED_PLAN_CACHE_LIMIT = 64;
function invalidateOwnedPlanCache() {
  ownedPlanRevision++;
  ownedPlanCache.clear();
}

function ownedPlanCacheKey(solution, allowEmpty) {
  if (calculatorMode !== 'solve' || !solution) return null;
  const classItemSettings = document.getElementById('useExoticMode')?.checked
    ? getExoticSettings()
    : null;
  const classId = classItemSettings?.classId || importClassFilter || null;
  const canonicalId = solution?.canonicalId || createCanonicalId(solution);
  const requirementKey = JSON.stringify(snapshotSetRequirement());
  // The revision covers physical item state; the remaining identity fields
  // distinguish filter/exotic/requirement configurations cheaply.
  const exoticKey = classItemSettings
    ? `class-item:${classId}`
    : `${inventoryExoticSlotFilter || ''}:${inventoryFixedExoticKey || ''}`;
  return `${ownedPlanRevision}|${Number(Boolean(allowEmpty))}|${canonicalId}|${requirementKey}|${classId || ''}|${exoticKey}`;
}

function getOwnedArmorPlan(solution, { allowEmpty = true, force = false } = {}) {
  const key = ownedPlanCacheKey(solution, allowEmpty);
  if (key && !force && ownedPlanCache.has(key)) return ownedPlanCache.get(key);
  const request = createOwnedArmorPlanRequest([solution], 1, { allowEmpty });
  if (!request) return null;
  const plan = rankInventoryPlans(request)[0] || null;
  if (key && !ownedPlanCache.has(key) && ownedPlanCache.size >= OWNED_PLAN_CACHE_LIMIT) {
    ownedPlanCache.delete(ownedPlanCache.keys().next().value);
  }
  if (key) ownedPlanCache.set(key, plan);
  return plan;
}

function refreshInventoryPlansFromSolutions({ rerender = true } = {}) {
  const selectedSolution = rerender ? allSolutions[currentSolutionIdx] : null;
  const request = createOwnedArmorPlanRequest(
    allSolutions,
    Math.max(SOLUTION_PREVIEW_COUNT, 12),
  );
  if (!request) {
    if (calculatorMode === 'solve' && rerender && allSolutions.length > 0 && lastTargets && lastFragments) {
      displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments, { scroll: false });
    }
    return;
  }
  const plans = rankInventoryPlans(request);
  const rank = new Map(plans.map((plan, index) => [plan.solution, index]));
  allSolutions.sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
  currentSolutionIdx = Math.max(0, allSolutions.indexOf(selectedSolution || plans[0]?.solution));
  if (rerender && allSolutions.length > 0) {
    displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments, { scroll: false, forceOwnedPlan: true });
  }
}

// ============================================================
// SOLUTION NAV
// ============================================================

// Warning shown when no loadout satisfies every active target rule. Extracted
// because renderSolutionNav needs it on two different paths.
function appendImperfectWarning() {
  const msgDiv = document.getElementById('messages');
  if (msgDiv.dataset.imperfectShown === '1') return;
  msgDiv.dataset.imperfectShown = '1';

  const hasFuzzyRules = hasNonExactTargetRules();
  const advice = l('可选择深度搜索，或调整目标和规则。', '可選擇深度搜尋，或調整目標與規則。', 'Try Deep search, or adjust the targets and rules.');

  const searchLimited = allSolutions.certificate?.status !== 'INFEASIBLE_PROVEN';
  const warning = searchLimited
    ? l(
        '\u641c\u7d22\u8fbe\u5230\u9650\u5236\uff1b\u4ee5\u4e0b\u4ec5\u4e3a\u5f53\u524d\u6700\u4f73配装\uff0c\u5c1a\u672a\u8bc1\u660e\u5168\u5c40\u6700\u4f18\u6216\u4e0d\u53ef\u8fbe\u3002',
        '\u641c\u5c0b\u9054\u5230\u9650\u5236\uff1b\u4ee5\u4e0b\u50c5\u70ba\u76ee\u524d\u6700\u4f73配裝\uff0c\u5c1a\u672a\u8b49\u660e\u5168\u57df\u6700\u512a\u6216\u4e0d\u53ef\u9054\u3002',
        'Search limit reached. The entries below are current-best loadouts; global optimality or infeasibility is not proven.'
      )
    : hasFuzzyRules
    ? l(
        '穷尽搜索已证明没有配装满足全部属性规则；以下是最佳未达标搭配。',
        '窮盡搜尋已證明沒有配裝滿足全部數值規則；以下是最佳未達標搭配。',
        'Exhaustive search proved that no loadout satisfies every stat rule. The closest available loadout is shown below.'
      )
    : l(
        '穷尽搜索已证明精确目标不可达；以下是最接近目标的搭配。',
        '窮盡搜尋已證明精確目標不可達；以下是最接近目標的搭配。',
        'Exhaustive search proved the exact target infeasible. The closest available loadout is shown below.'
      );
  msgDiv.insertAdjacentHTML(
    'beforeend',
    `<div class="msg warn">${icon('warn')}${warning}<br>${icon('hint')} ${advice}</div>`,
  );
}

function renderResultWarnings() {
  // The ranked plan list lives in the unified "配装方案" workspace, so this keeps
  // only the global "no qualifying loadout" warning. A second, independently
  // ranked list must never reappear next to the unified one.
  const hasPerfect = allSolutions.some(solutionSatisfiesCurrentTargetRules);
  if (allSolutions.length > 0 && !hasPerfect && !lastExoticSettings) appendImperfectWarning();
}

function switchSolution(realIdx) {
  if (realIdx < 0 || realIdx >= allSolutions.length) return;
  currentSolutionIdx = realIdx;
  ownedArmorActionStatus = null;
  // Keep the reader where they are — switching solutions must not yank
  // the viewport back to the top of the results.
  displayAllResults(allSolutions[realIdx], lastTargets, lastFragments, { scroll: false });
}

function getManualOwnedDefault(plan) {
  const piece = plan?.pieces?.find(entry => !entry.exotic && !entry.item)
    || plan?.pieces?.find(entry => !entry.exotic)
    || plan?.pieces?.[0];
  return {
    slot: piece?.slot || 'helmet',
    archetypeId: normalizeArchetypeId(piece?.archetype) || ARCHETYPES[0].id,
    tertiary: piece?.tertiary || STATS[0],
    tuning: piece?.tuningMode === 'plus3' ? '+3' : piece?.tuningTo || '+3',
  };
}

function getManualTertiaryOptions(archetypeId) {
  const archetype = ARCHETYPES.find(entry => entry.id === archetypeId) || ARCHETYPES[0];
  return STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
}

// An owned piece of a theoretical skeleton already exists, so the row has to
// say whether the installed Tuning mod matches the plan's requirement instead
// of just naming the target roll.
function renderOwnedPieceRequirement(piece) {
  const item = piece.item;
  const requiredTuning = formatInventoryItemTuning(piece);
  const currentTuning = formatInventoryItemTuning(item);
  const tuningDetails = `${l('方案', '方案', 'Plan')}: ${requiredTuning}`
    + (requiredTuning !== currentTuning
      ? ` · ${l('当前', '目前', 'Current')}: ${currentTuning} (${l('需更换调整模组', '需更換調校模組', 'change Tuning mod')})`
      : '');
  const details = [
    getArchetypeLabel(item.archetypeId || piece.archetype),
    `${t('tertiaryStat')} ${STAT_LABELS[item.tertiary || piece.tertiary] || '—'}`,
    tuningDetails,
  ].filter(Boolean).join(' · ');
  return `<small class="owned-armor-match-detail">${escapeHtml(details)}</small>`;
}

function renderManualOwnedItem(item, index) {
  const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === item.slot);
  const tuning = item.tuningMode === 'plus3' ? l('+3调整', '+3調校', '+3 Tuning') : `+5 ${STAT_LABELS[item.tuningTo]}`;
  const removeLabel = l(`移除手动护甲 ${index + 1}`, `移除手動防具 ${index + 1}`, `Remove manual armor ${index + 1}`);
  return `<li>
    <span>${getUpgradeSlotLabel(slotIndex)}</span>
    <strong>${getArchetypeLabel(item.archetypeId)}</strong>
    <small>${t('tertiaryStat')} ${STAT_LABELS[item.tertiary]} · ${tuning}</small>
    <button type="button" class="btn" onclick="removeManualOwnedArmor('${item.sourceId}')" aria-label="${removeLabel}">${icon('trash')}</button>
  </li>`;
}

function buildOwnedGearSection(_finalTotals, _targets) {
  const section = document.getElementById('ownedGearSection');
  if (!section) return;
  // Owned-armor matching and its ranked list moved into the unified
  // "配装方案" panel above. Only the manual add-armor editor stays here, so a
  // second partial match list can never disagree with the unified one.
  const plan = getOwnedArmorPlan(allSolutions[currentSolutionIdx]);
  const defaultPiece = getManualOwnedDefault(plan);
  const tertiaryOptions = getManualTertiaryOptions(defaultPiece.archetypeId);
  if (!tertiaryOptions.includes(defaultPiece.tertiary)) defaultPiece.tertiary = tertiaryOptions[0];
  const manualList = manualOwnedItems.length > 0
    ? `<ul class="manual-owned-list">${manualOwnedItems.map(renderManualOwnedItem).join('')}</ul>`
    : '';
  const bungieTargetControl = renderOwnedGearBungieTargetControl();
  const actionStatus = ownedArmorActionStatus
    ? `<div class="owned-armor-action-status"><div class="msg ${ownedArmorActionStatus.tone}">${icon(ownedArmorActionStatus.tone === 'error' ? 'block' : ownedArmorActionStatus.tone === 'warn' ? 'warn' : 'check')}<span>${escapeHtml(ownedArmorActionStatus.text)}</span></div></div>`
    : '';

  document.body.classList.toggle('is-editing-owned-armor', manualOwnedEditorOpen);
  // The inventory is an input, not a result: it collapses to one thin strip and
  // only expands into the manual editor when the player asks for it.
  const sourceLabel = importSource === 'bungie'
    ? l(`Bungie · ${importedInventory.length} 件`, `Bungie · ${importedInventory.length} 件`, `Bungie · ${importedInventory.length} items`)
    : importSource === 'csv'
      ? l(`DIM CSV · ${importedInventory.length} 件`, `DIM CSV · ${importedInventory.length} 件`, `DIM CSV · ${importedInventory.length} items`)
      : l('未导入清单', '未匯入清單', 'No inventory imported');
  section.innerHTML = `<div class="inventory-strip-row">
    <span class="inventory-strip-title">${l('库存', '庫存', 'Inventory')}</span>
    <span class="inventory-strip-item">${escapeHtml(sourceLabel)}</span>
    <span class="inventory-strip-item">${l(`手动 · ${manualOwnedItems.length} 件`, `手動 · ${manualOwnedItems.length} 件`, `Manual · ${manualOwnedItems.length}`)}</span>
    ${bungieTargetControl}
    <div class="inventory-strip-actions">
      <button type="button" class="btn" id="manualOwnedManageButton" onclick="toggleManualOwnedEditor()" aria-expanded="${manualOwnedEditorOpen}" aria-controls="manualOwnedEditor">${icon('gear')}${l('管理', '管理', 'Manage')}</button>
    </div>
  </div>
  ${actionStatus}
  <details class="manual-owned-editor" id="manualOwnedEditor" ${manualOwnedEditorOpen ? 'open' : ''} ontoggle="setManualOwnedEditorOpen(this.open)">
    <summary>${icon('plus')}${l('手动补充已有护甲', '手動補充已有防具', 'Add owned armor manually')}<span>${manualOwnedItems.length}</span></summary>
    <div class="manual-owned-form">
      <label><span>${l('部位', '部位', 'Slot')}</span><select id="manualOwnedSlot">
        ${UPGRADE_SLOTS.map((slot, index) => `<option value="${slot.id}" ${slot.id === defaultPiece.slot ? 'selected' : ''}>${getUpgradeSlotLabel(index)}</option>`).join('')}
      </select></label>
      <label><span>${l('框架', '原型', 'Archetype')}</span><select id="manualOwnedArchetype" onchange="updateManualOwnedTertiaryOptions()">
        ${ARCHETYPES.map(archetype => `<option value="${archetype.id}" ${archetype.id === defaultPiece.archetypeId ? 'selected' : ''}>${getArchetypeLabel(archetype.id)}</option>`).join('')}
      </select></label>
      <label><span>${t('tertiaryStat')}</span><select id="manualOwnedTertiary">
        ${tertiaryOptions.map(stat => `<option value="${stat}" ${stat === defaultPiece.tertiary ? 'selected' : ''}>${STAT_LABELS[stat]}</option>`).join('')}
      </select></label>
      <label><span>${l('调整', '調校', 'Tuning')}</span><select id="manualOwnedTuning">
        <option value="+3" ${defaultPiece.tuning === '+3' ? 'selected' : ''}>${l('+3模式', '+3模式', '+3 mode')}</option>
        ${STATS.map(stat => `<option value="${stat}" ${stat === defaultPiece.tuning ? 'selected' : ''}>+5 ${STAT_LABELS[stat]}</option>`).join('')}
      </select></label>
      <button type="button" class="btn owned-gear-add" id="addManualOwnedButton" onclick="addManualOwnedArmor()">${icon('plus')}${l('添加并更新方案', '新增並更新方案', 'Add and update')}</button>
    </div>
    ${manualList}
    ${manualOwnedItems.length > 0 ? `<button type="button" class="btn manual-owned-clear" onclick="clearOwnedGear()">${icon('trash')}${l('清空手动新增', '清空手動新增', 'Clear manual armor')}</button>` : ''}
  </details>`;
  section.hidden = false;
}

function toggleManualOwnedEditor() {
  const details = document.getElementById('manualOwnedEditor');
  if (!details) return;
  // The ontoggle handler persists the state; flipping `open` is enough.
  details.open = !details.open;
}

function setManualOwnedEditorOpen(open) {
  manualOwnedEditorOpen = Boolean(open);
  document.body.classList.toggle('is-editing-owned-armor', manualOwnedEditorOpen);
}

function updateManualOwnedTertiaryOptions() {
  const archetypeId = document.getElementById('manualOwnedArchetype')?.value;
  const select = document.getElementById('manualOwnedTertiary');
  if (!select) return;
  select.innerHTML = getManualTertiaryOptions(archetypeId)
    .map(stat => `<option value="${stat}">${STAT_LABELS[stat]}</option>`)
    .join('');
}

function addManualOwnedArmor() {
  const slot = document.getElementById('manualOwnedSlot')?.value;
  const archetypeId = document.getElementById('manualOwnedArchetype')?.value;
  const tertiary = document.getElementById('manualOwnedTertiary')?.value;
  const tuning = document.getElementById('manualOwnedTuning')?.value;
  if (!slot || !archetypeId || !tertiary || !tuning) return;
  const classId = document.getElementById('useExoticMode')?.checked
    ? document.getElementById('exoticClass')?.value || null
    : importClassFilter || null;
  const sourceId = `manual-owned-${Date.now()}-${++manualOwnedSequence}`;
  manualOwnedItems.push({
    id: sourceId,
    sourceId,
    name: '',
    slot,
    classId,
    tier: '5',
    exotic: false,
    archetypeId,
    tertiary,
    tuningMode: tuning === '+3' ? 'plus3' : 'shift',
    tuningTo: tuning === '+3' ? null : tuning,
    setHash: null,
    manualOwned: true,
  });
  invalidateOwnedPlanCache();
  manualOwnedEditorOpen = true;
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function removeManualOwnedArmor(sourceId) {
  manualOwnedItems = manualOwnedItems.filter(item => item.sourceId !== sourceId);
  invalidateOwnedPlanCache();
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function clearOwnedGear() {
  manualOwnedItems = [];
  invalidateOwnedPlanCache();
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

// ============================================================
// EXISTING LOADOUT OPTIMIZER
// ============================================================
let calculatorMode = 'solve';
let upgradeBuildState = [];
let lastUpgradeAnalysis = null;
let upgradeRequiredStats = [];

// Owned armor can come from an imported inventory or compact manual entries.
// Both sources feed the same plan ranking and active-solution match view.
let importedInventory = [];
let importSource = ""; // "csv" | "bungie" | "" — provenance of importedInventory
let manualOwnedItems = [];
let manualOwnedSequence = 0;
let manualOwnedEditorOpen = false;
let ownedArmorActionStatus = null;
let inventoryImportExpanded = false;
// The save dialog is single-purpose: create a new plan, or rename an existing
// one. `entry` is resolved at open time from getSelectedUnifiedEntry(), never
// from the theory solver's own cursor.
let pendingSave = null;
// Signature of the input the on-screen result was computed from. Loading a
// saved plan compares against it and asks before overwriting unsaved edits.
let lastCommittedInputSignature = null;
let importClassFilter = "";
let importTier5Only = true;
let setRequirement = { type: "none" };
let manualLocked = [];
let inventoryExoticSlotFilter = "";
let inventoryFixedExoticKey = "";

const EXOTIC_SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];
const EXOTIC_SLOTS = new Set(EXOTIC_SLOT_ORDER);

// Bungie classType (0/1/2) -> solver class id (matches CLASS_BY_TYPE in
// bungie-inventory.mjs; used to resolve subclass fragments per class).
const CLASS_ID_BY_CLASS_TYPE = { 0: "titan", 1: "hunter", 2: "warlock" };

function getInventoryExoticKey(item) {
  const name = String(item?.name || "").trim().toLocaleLowerCase();
  if (name) return `name:${name}`;
  const hash = Number(item?.hash) || 0;
  return `hash:${hash}`;
}

function getExoticClassItemKey(classId) {
  return `class-item:${classId}`;
}

function getExoticClassItemName(classId) {
  const label = EXOTIC_CLASS_LABELS[classId]?.[getExoticLanguage()] || '';
  return label.split('·').slice(1).join('·').trim() || t('exoticClassItem');
}

function getFilteredInventoryExotics() {
  if (!importClassFilter) return [];
  return filterArmorItems(importedInventory, {
    classId: importClassFilter,
    tier5Only: importTier5Only,
  }).filter(item => Boolean(item.exotic) && EXOTIC_SLOTS.has(item.slot));
}

function getSelectedInventoryExotic() {
  if (!inventoryFixedExoticKey || inventoryExoticSlotFilter === 'classItem') return null;
  if (inventoryFixedExoticKey === 'any-exotic' && importClassFilter && EXOTIC_SLOTS.has(inventoryExoticSlotFilter)) {
    return {
      key: 'any-exotic', reserved: true, classId: importClassFilter,
      slot: inventoryExoticSlotFilter, hash: 0,
      name: l('任意异域（待获取）', '任意異域（待取得）', 'Any Exotic (to acquire)'),
    };
  }
  const item = getFilteredInventoryExotics().find(candidate =>
    candidate.slot === inventoryExoticSlotFilter &&
    getInventoryExoticKey(candidate) === inventoryFixedExoticKey
  );
  if (!item) return null;
  return {
    key: inventoryFixedExoticKey,
    classId: item.classId,
    slot: item.slot,
    hash: Number(item.hash) || 0,
    name: item.name || "",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getInventoryExoticPickerData() {
  const pool = getFilteredInventoryExotics();
  const slots = importClassFilter
    ? EXOTIC_SLOT_ORDER
    : [];
  if (!slots.includes(inventoryExoticSlotFilter)) {
    inventoryExoticSlotFilter = "";
    inventoryFixedExoticKey = "";
  }

  let names;
  if (inventoryExoticSlotFilter === 'classItem' && importClassFilter) {
    const key = getExoticClassItemKey(importClassFilter);
    const data = EXOTIC_CLASSES[importClassFilter];
    names = [{
      key,
      item: {
        classId: importClassFilter,
        slot: 'classItem',
        hash: data?.itemHash || 0,
        name: getExoticClassItemName(importClassFilter),
        exotic: true,
      },
      count: pool.filter(item => item.slot === 'classItem').length,
    }];
    inventoryFixedExoticKey = key;
  } else {
    const groups = new Map();
    for (const item of pool) {
      if (item.slot !== inventoryExoticSlotFilter) continue;
      const key = getInventoryExoticKey(item);
      if (!groups.has(key)) groups.set(key, { key, item, count: 0 });
      groups.get(key).count++;
    }
    names = [...groups.values()].sort((left, right) =>
      String(left.item.name || "").localeCompare(String(right.item.name || ""), localeCode())
    );
    if (importClassFilter && EXOTIC_SLOTS.has(inventoryExoticSlotFilter)) {
      names.unshift({ key: 'any-exotic', item: {
        name: l('任意异域', '任意異域', 'Any Exotic'),
      }, count: 0 });
    }
  }
  if (!names.some(entry => entry.key === inventoryFixedExoticKey)) {
    inventoryFixedExoticKey = "";
  }
  return { pool, slots, names };
}

// Key by content identity, not DOM order: set previews may be reordered.
function preserveDisclosureState(root) {
  if (!root) return () => {};
  const states = new Map([...root.querySelectorAll('details[data-disclosure-key]')]
    .map(element => [element.dataset.disclosureKey, element.open]));
  return () => {
    for (const element of root.querySelectorAll('details[data-disclosure-key]')) {
      if (states.has(element.dataset.disclosureKey)) element.open = states.get(element.dataset.disclosureKey);
    }
  };
}

// The loadout detail is rebuilt in place on every selection change and on every
// progressive search tick. Remember which accordions the reader opened so a
// re-render never collapses them under them.
const detailDisclosureState = new Map();

function rememberDetailDisclosure(event) {
  const element = event.target;
  if (!element?.dataset?.disclosureKey) return;
  detailDisclosureState.set(element.dataset.disclosureKey, element.open === true);
}

function restoreDetailDisclosure(root = document.getElementById('loadoutDetail')) {
  if (!root) return;
  for (const element of root.querySelectorAll('details[data-disclosure-key]')) {
    const saved = detailDisclosureState.get(element.dataset.disclosureKey);
    if (saved !== undefined) element.open = saved;
  }
}

// Every label the command bar owns is localized here because none of it can be
// a static data-i18n key: 重新求解 only makes sense once results exist.
function syncCommandBarLabels() {
  const solveLabel = document.getElementById('btnSolveLabel');
  if (solveLabel) {
    solveLabel.textContent = lastUnifiedLoadouts.length > 0
      ? l('重新求解', '重新求解', 'Re-solve')
      : l('求解最佳配装', '求解最佳配裝', 'Solve Best Loadout');
  }
  const targets = [
    ['cmdExportDimLabel', ['导出 DIM', '匯出 DIM', 'Export DIM']],
    ['cmdEquipLabel', ['装备', '裝備', 'Equip']],
    ['btnEditConditionsLabel', ['编辑条件', '編輯條件', 'Edit conditions']],
  ];
  for (const [id, labels] of targets) {
    const element = document.getElementById(id);
    if (element) element.textContent = l(...labels);
  }
}

function renderUpgradeImportPanel() {
  const el = document.getElementById("upgradeImportPanel");
  if (!el) return;
  const restoreDetails = preserveDisclosureState(el);
  const isScratchMode = calculatorMode === "solve";
  const importHeading = l("已有护甲", "已有防具", "Owned armor");
  const { slots: exoticSlots, names: exoticNames } = getInventoryExoticPickerData();
  const classOptions = [
    ["", isScratchMode
      ? l("请选择职业", "請選擇職業", "Choose a class")
      : l("全部职业", "全部職業", "All classes")],
    ["hunter", l("猎人", "獵人", "Hunter")],
    ["titan", l("泰坦", "泰坦", "Titan")],
    ["warlock", l("术士", "術士", "Warlock")],
  ].map(([value, label]) =>
    `<option value="${value}" ${importClassFilter === value ? "selected" : ""}>${label}</option>`
  ).join("");
  const exoticSlotOptions = [
    `<option value="">${l("先选择部位", "先選擇部位", "Choose a slot")}</option>`,
    ...exoticSlots.map(slot => {
      const slotIndex = UPGRADE_SLOTS.findIndex(definition => definition.id === slot);
      return `<option value="${slot}" ${slot === inventoryExoticSlotFilter ? "selected" : ""}>${getUpgradeSlotLabel(slotIndex)}</option>`;
    }),
  ].join("");
  const isClassItemSlot = inventoryExoticSlotFilter === 'classItem';
  const exoticNameOptions = [
    ...(isClassItemSlot ? [] : [`<option value="">${inventoryExoticSlotFilter
      ? l("不固定异域", "不固定異域", "No fixed Exotic")
      : l("请先选择部位", "請先選擇部位", "Choose a slot first")}</option>`]),
    ...exoticNames.map(entry => `<option value="${escapeHtml(entry.key)}" ${entry.key === inventoryFixedExoticKey ? "selected" : ""}>${escapeHtml(entry.item.name || l("未命名异域", "未命名異域", "Unnamed Exotic"))}${entry.count > 0 ? ` ×${entry.count}` : ''}</option>`),
  ].join("");
  const importState = importedInventory.length > 0
    ? l(`已导入 ${importedInventory.length} 件`, `已匯入 ${importedInventory.length} 件`, `${importedInventory.length} imported`)
    : l("未导入", "未匯入", "Not imported");
  const toggleLabel = inventoryImportExpanded
    ? l("收起", "收起", "Collapse")
    : l("展开", "展開", "Expand");
  const effectiveCount = importedInventory.length === 0
    ? 0
    : filterArmorItems(importedInventory, {
      classId: importClassFilter || undefined,
      tier5Only: importTier5Only,
    }).length;

  el.classList.toggle('is-collapsed', !inventoryImportExpanded);
  el.innerHTML = `
    <div class="armor-source-head">
      <div class="armor-source-title">
        <h2 id="armorSourceHeading">${importHeading}</h2>
        <span class="upgrade-import-state">${importState}</span>
      </div>
      <div class="armor-source-actions">
        <label class="upgrade-import-file">
          <span class="btn upgrade-import-primary">${icon("folder")}${importedInventory.length > 0 ? l("重新导入", "重新匯入", "Replace inventory") : l("导入清单", "匯入清單", "Import inventory")}</span>
          <input type="file" id="dimCsvFile" accept=".csv,text/csv" onchange="handleDimCsvFile(this)">
        </label>
        ${isScratchMode ? "" : `<button type="button" class="btn" data-import-dependent onclick="applyEquippedLoadout()">${icon("refresh")}${l("填入当前穿戴", "填入目前穿戴", "Fill equipped loadout")}</button>`}
        <button type="button" class="btn upgrade-import-toggle" id="toggleInventoryImportButton" aria-expanded="${inventoryImportExpanded}" aria-controls="upgradeImportBody" onclick="toggleInventoryImportPanel()">${icon(inventoryImportExpanded ? 'up' : 'down')}<span>${toggleLabel}</span></button>
        <a class="btn-link armor-source-help-toggle" id="dimImportGuideLink" href="../guide/#dim-import" target="_blank" rel="noopener noreferrer">${icon('hint')}<span>${t('dimImportHelpToggle')}</span></a>
      </div>
    </div>
    <div class="upgrade-import-body" id="upgradeImportBody" ${inventoryImportExpanded ? '' : 'hidden'}>
      <div class="armor-filter-toolbar" id="armorFilterToolbar" aria-label="${l("已有护甲筛选与操作", "已有防具篩選與操作", "Owned armor filters and actions")}">
        <div class="upgrade-import-status" id="upgradeImportSummary" aria-live="polite"></div>
        <label class="import-class-select">
          <span>${l("职业", "職業", "Class")}</span>
          <select id="importClass" onchange="updateImportOptions()">${classOptions}</select>
        </label>
        <label class="import-tier-toggle">
          <input type="checkbox" id="importTier5Only" data-import-dependent ${importTier5Only ? "checked" : ""} onchange="updateImportOptions()">
          <span>${l("仅 Tier 5", "僅 Tier 5", "Tier 5 only")}</span>
        </label>
        <span class="armor-filter-count" id="armorFilterCount">${l(
          `当前有效 ${effectiveCount} 件`,
          `目前有效 ${effectiveCount} 件`,
          `${effectiveCount} effective`,
        )}</span>
        <div class="upgrade-import-actions">
          <button type="button" class="btn danger" data-import-dependent onclick="clearImportedInventory()">${icon("trash")}${l("清空", "清空", "Clear")}</button>
        </div>
      </div>
    </div>
    <details class="advanced-constraints" id="advancedConstraints" data-disclosure-key="advanced-constraints">
      <summary>
        <span class="advanced-constraints-title">${l("高级约束", "進階限制", "Advanced constraints")}</span>
        <span class="advanced-constraints-value" id="advancedConstraintsSummary"></span>
      </summary>
      <div class="advanced-constraints-body">
        <section class="constraint-panel" aria-labelledby="exoticConstraintTitle">
          <h4 class="constraint-panel-title" id="exoticConstraintTitle">${l("异域约束", "異域限制", "Exotic constraint")}</h4>
          <div class="inventory-solve-options" id="inventorySolveOptions">
            <div class="inventory-exotic-picker" aria-label="${l("固定异域筛选", "固定異域篩選", "Fixed Exotic filters")}">
              <label class="inventory-fixed-exotic-control">
                <span>${l("异域部位", "異域部位", "Exotic slot")}</span>
                <select id="inventoryExoticSlotFilter" onchange="updateInventoryExoticSlot()" ${!importClassFilter || exoticSlots.length === 0 ? "disabled" : ""}>${exoticSlotOptions}</select>
              </label>
              <label class="inventory-fixed-exotic-control">
                <span>${l("异域名称", "異域名稱", "Exotic name")}</span>
                <select id="inventoryFixedExoticName" onchange="updateInventorySolveOptions()" ${isClassItemSlot || !inventoryExoticSlotFilter || exoticNames.length === 0 ? "disabled" : ""}>${exoticNameOptions}</select>
              </label>
            </div>
            <p class="inventory-solve-option-hint constraint-caption" id="inventorySolveOptionHint"></p>
          </div>
        </section>
        <section class="constraint-panel" aria-labelledby="setConstraintTitle">
          <h4 class="constraint-panel-title" id="setConstraintTitle">${l("套装要求", "套裝要求", "Set requirement")}</h4>
          <div class="upgrade-set-effects" id="upgradeSetEffects"></div>
        </section>
      </div>
    </details>
    ${getSavedBungieLoadoutsHtml()}
  `;
  updateImportSummary();
  updateInventorySolveOptions();
  renderSetEffects();
  renderBungieAuthState();
  updateAdvancedConstraintsSummary();
  restoreDetails();
}

// One line that answers "is anything constrained right now?" without opening
// the editor: the two things a returning user has to remember about their plan.
function describeFixedExoticConstraint() {
  if (!inventoryFixedExoticKey) return '';
  const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === inventoryExoticSlotFilter);
  const slotLabel = slotIndex >= 0 ? getUpgradeSlotLabel(slotIndex) : '';
  if (inventoryFixedExoticKey === 'any-exotic') {
    const name = l('任意异域（待获取）', '任意異域（待取得）', 'Any Exotic (to acquire)');
    return slotLabel ? `${name} · ${slotLabel}` : name;
  }
  if (inventoryExoticSlotFilter === 'classItem') {
    const classId = importClassFilter || document.getElementById('exoticClass')?.value || 'hunter';
    const name = getExoticClassItemName(classId);
    return slotLabel ? `${name} · ${slotLabel}` : name;
  }
  const selected = getSelectedInventoryExotic();
  const name = selected?.name || inventoryFixedExoticKey;
  return slotLabel ? `${name} · ${slotLabel}` : name;
}

function updateAdvancedConstraintsSummary() {
  const el = document.getElementById('advancedConstraintsSummary');
  if (!el) return;
  const parts = [];
  const exotic = describeFixedExoticConstraint();
  if (exotic) parts.push(l(`异域：${exotic}`, `異域：${exotic}`, `Exotic: ${exotic}`));
  if (setRequirement && setRequirement.type !== 'none') {
    const label = formatSetRequirementLabel(setRequirement);
    parts.push(l(`套装：${label}`, `套裝：${label}`, `Set: ${label}`));
  }
  el.textContent = parts.length > 0 ? parts.join(' · ') : t('advancedConstraintsNone');
  document.getElementById('advancedConstraints')?.classList.toggle('is-constrained', parts.length > 0);
}

function toggleInventoryImportPanel() {
  inventoryImportExpanded = !inventoryImportExpanded;
  renderUpgradeImportPanel();
  saveUpgradeDraft();
}

function showImportMessage(text, tone = "error") {
  if (!inventoryImportExpanded) {
    inventoryImportExpanded = true;
    renderUpgradeImportPanel();
  }
  const el = document.getElementById("upgradeImportSummary");
  if (!el) return;
  el.innerHTML = `<div class="msg ${tone}">${icon(tone === "error" ? "block" : "check")}<span>${escapeHtml(text)}</span></div>`;
}

// --- Bungie OAuth sign-in (T10) ---

const BUNGIE_DISPLAY_NAME_KEY = channelStorageKey("d2_armor_bungie_display_name_v1");
const BUNGIE_OAUTH_STATE_KEY = channelStorageKey("bungieOAuthState");
const BUNGIE_AUTO_REFRESH_MS = 10 * 1000;

let isBungieImporting = false;
let lastBungieImportAt = 0;
let bungieAutoRefreshTimer = 0;
let isBungieApplying = false;
let bungieProfileState = null;
let bungieTargetCharacterId = "";
// Per-character subclass fragments from the last Bungie import, keyed by
// characterId: { characterId: { stat: delta } }. Filled by importInventoryFromBungie,
// consumed by applyEquippedLoadout to auto-set the fragment steppers.
let bungieSubclassFragments = null;

function getBungieDisplayName() {
  try {
    return localStorage.getItem(BUNGIE_DISPLAY_NAME_KEY) || "";
  } catch {
    return "";
  }
}

function bungieErrorMessage(error) {
  if (error instanceof ThrottleError) {
    return l(
      `Bungie 请求限流，请 ${error.retrySeconds} 秒后重试。`,
      `Bungie 請求限流，請 ${error.retrySeconds} 秒後重試。`,
      `Bungie is throttling requests; retry in ${error.retrySeconds}s.`,
    );
  }
  if (error instanceof ApiKeyError) {
    return l(
      "Bungie API key 无效或未获审批，请检查 Bungie 门户的应用设置。",
      "Bungie API key 無效或未獲審批，請檢查 Bungie 入口網站的應用程式設定。",
      "Bungie API key is invalid or not approved. Check your app settings on the Bungie portal.",
    );
  }
  // A 401 ApiError means the token Bungie holds is dead (revoked or clock
  // skew): the wall-clock expiry check in getValidAccessToken can't see it,
  // so retrying is doomed. Treat it exactly like FatalTokenError: clear the
  // token and drop the user back to the logged-out state.
  if (error instanceof FatalTokenError || (error instanceof ApiError && error.status === 401)) {
    return l(
      "登录已过期，请重新登录。",
      "登入已過期，請重新登入。",
      "Sign-in expired. Sign in again.",
    );
  }
  if (error instanceof NetworkError) {
    return l(
      "网络错误或 CORS 未配置：请确认当前浏览器来源已在 Bungie 门户注册。",
      "網路錯誤或 CORS 未設定：請確認目前瀏覽器來源已在 Bungie 入口網站註冊。",
      "Network error or CORS not configured: make sure this browser origin is registered on the Bungie portal.",
    );
  }
  if (error instanceof NoMembershipError) {
    return l(
      "未找到 Destiny 2 账号。",
      "找不到 Destiny 2 帳號。",
      "No Destiny 2 membership found for this account.",
    );
  }
  if (error instanceof ApiError) {
    return l(
      "从 Bungie 获取数据失败，请稍后重试。",
      "從 Bungie 取得資料失敗，請稍後重試。",
      "Failed to fetch data from Bungie. Try again later.",
    );
  }
  return l(
    "Bungie 同步失败，请重试。",
    "Bungie 同步失敗，請重試。",
    "Bungie sync failed. Try again.",
  );
}

// Shared Bungie failure path: a dead token (FatalTokenError, or an ApiError
// with HTTP 401 — Bungie rejected the access token) drops the user back to
// the logged-out state; everything else just renders the classified message.
function handleBungieAuthError(error) {
  if (error instanceof FatalTokenError || (error instanceof ApiError && error.status === 401)) {
    clearToken();
    try {
      localStorage.removeItem(BUNGIE_DISPLAY_NAME_KEY);
    } catch {
      // ignore storage failures
    }
  }
  renderBungieAuthState();
  showImportMessage(bungieErrorMessage(error));
}

function formatBungieLastSync() {
  if (!lastBungieImportAt) return l("等待首次同步", "等待首次同步", "Waiting for first sync");
  return l("刚刚更新", "剛剛更新", "Updated just now");
}

// Authentication and the frequently used inventory action share the page
// header, while sign-out remains inside the account menu.
function bungieAccountHtml() {
  if (!__BUNGIE_OAUTH_CLIENT_ID__) return "";
  if (!hasToken()) {
    return `<button type="button" class="btn bungie-login-button" id="bungieLoginButton" onclick="bungieLogin()">${l("Bungie 登录", "Bungie 登入", "Bungie login")}</button>`;
  }
  const displayName = getBungieDisplayName() || l("已连接账户", "已連線帳戶", "Connected account");
  const syncLabel = isBungieImporting
    ? l("正在同步库存…", "正在同步庫存…", "Syncing inventory…")
    : l("同步库存", "同步庫存", "Sync inventory");
  const autoRefreshLabel = l("页面打开时每 10 秒自动刷新", "頁面開啟時每 10 秒自動重新整理", "Auto-refreshes every 10s while this page is open");
  return `<div class="bungie-sync-control">
    <button type="button" class="btn bungie-sync-button" onclick="importInventoryFromBungie()" ${isBungieImporting ? "disabled" : ""}>${icon("refresh")}<span>${syncLabel}</span></button>
    <span class="bungie-sync-meta" title="${escapeHtml(autoRefreshLabel)}"><span class="bungie-sync-pulse" aria-hidden="true"></span>${formatBungieLastSync()} · ${l("自动 10 秒", "自動 10 秒", "Auto 10s")}</span>
  </div>
  <details class="bungie-account-menu">
    <summary aria-label="${escapeHtml(l(`Bungie 账户：${displayName}`, `Bungie 帳戶：${displayName}`, `Bungie account: ${displayName}`))}">
      <span class="bungie-account-status" aria-hidden="true"></span>
      <span class="bungie-account-copy"><small>Bungie</small><strong>${escapeHtml(displayName)}</strong></span>
    </summary>
    <div class="bungie-account-popover">
      <div class="bungie-account-identity">
        <span>${l("已连接 Bungie", "已連線 Bungie", "Bungie connected")}</span>
        <strong>${escapeHtml(displayName)}</strong>
      </div>
      <div class="bungie-account-danger">
        <button type="button" onclick="bungieLogout()">${l("退出 Bungie 账户", "登出 Bungie 帳戶", "Sign out of Bungie")}</button>
      </div>
    </div>
  </details>`;
}

function renderBungieAuthState() {
  renderHeaderBungieAuthState();
}

function renderHeaderBungieAuthState() {
  const area = document.getElementById("headerBungieAuth");
  if (area) area.innerHTML = bungieAccountHtml();
  syncBungieAutoRefresh();
}

function bungieLogin() {
  const state = `${BUILD_CHANNEL}.${crypto.randomUUID()}`;
  try {
    sessionStorage.setItem(BUNGIE_OAUTH_STATE_KEY, state);
  } catch {
    // sessionStorage unavailable: the state check on return falls through and errors
  }
  window.location.href = buildAuthorizeUrl(state);
}

function bungieLogout() {
  const confirmed = confirm(l(
    "退出后将移除当前导入的 Bungie 库存与未保存的求解结果；浏览器中已保存的配装不会被删除。确定退出吗？",
    "登出後將移除目前匯入的 Bungie 庫存與未儲存的求解結果；瀏覽器中已儲存的配裝不會被刪除。確定登出嗎？",
    "Signing out removes the imported Bungie inventory and unsaved solver results. Loadouts saved in this browser will remain. Sign out?",
  ));
  if (!confirmed) return;
  clearToken();
  try {
    localStorage.removeItem(BUNGIE_DISPLAY_NAME_KEY);
  } catch {
    // ignore storage failures
  }
  bungieSubclassFragments = null;
  bungieProfileState = null;
  bungieTargetCharacterId = "";
  if (importSource === "bungie") {
    importedInventory = [];
    importSource = "";
    clearInventoryResults();
    renderUpgradeImportPanel();
  }
  renderBungieAuthState();
}

// Auto-refresh stays active only while the document is visible. The in-flight
// gate prevents overlapping profile requests if one sync takes longer than 10s.
function shouldAutoRefresh(now = Date.now()) {
  return document.visibilityState === "visible"
    && hasToken()
    && !isBungieImporting
    && now - lastBungieImportAt >= BUNGIE_AUTO_REFRESH_MS;
}

function stopBungieAutoRefresh() {
  if (!bungieAutoRefreshTimer) return;
  clearInterval(bungieAutoRefreshTimer);
  bungieAutoRefreshTimer = 0;
}

function syncBungieAutoRefresh() {
  if (document.visibilityState !== "visible" || !hasToken()) {
    stopBungieAutoRefresh();
    return;
  }
  if (bungieAutoRefreshTimer) return;
  bungieAutoRefreshTimer = window.setInterval(() => {
    if (shouldAutoRefresh()) importInventoryFromBungie({ silent: true });
  }, BUNGIE_AUTO_REFRESH_MS);
}

function getBungieCharactersForClass(classId = importClassFilter) {
  const characters = Object.values(bungieProfileState?.characters || {});
  return characters.filter(character => !classId || character.classId === classId)
    .sort((left, right) =>
      String(right.dateLastPlayed || "").localeCompare(String(left.dateLastPlayed || ""))
    );
}

function syncBungieTargetCharacter() {
  const characters = getBungieCharactersForClass();
  if (characters.some(character => character.characterId === bungieTargetCharacterId)) return;
  const equippedOwner = importedInventory.find(item =>
    item?.equipped && (!importClassFilter || item.classId === importClassFilter)
  )?.owner;
  bungieTargetCharacterId = characters.find(character =>
    String(character.characterId) === String(equippedOwner)
  )?.characterId || characters[0]?.characterId || "";
}

function formatBungieCharacterLabel(character) {
  const classLabel = getClassLabel(character?.classId);
  const light = Number(character?.light) || 0;
  return `${classLabel}${light ? ` · ${term("power")} ${light}` : ""}`;
}

function formatBungieCharacterOption(character, characters) {
  const base = formatBungieCharacterLabel(character);
  if (characters.length < 2) return base;
  if (character?.characterId === characters[0]?.characterId) {
    return `${base}${l(" · 最近使用", " · 最近使用", " · Most recent")}`;
  }
  const played = new Date(character?.dateLastPlayed || "");
  if (!Number.isFinite(played.getTime())) return base;
  const date = played.toLocaleDateString(localeCode(), { month: "short", day: "numeric" });
  return `${base}${l(` · 上次游玩 ${date}`, ` · 上次遊玩 ${date}`, ` · Last played ${date}`)}`;
}

function getBungieTargetOptionsHtml() {
  syncBungieTargetCharacter();
  const characters = getBungieCharactersForClass();
  return characters.map(character =>
    `<option value="${escapeHtml(character.characterId)}" ${character.characterId === bungieTargetCharacterId ? "selected" : ""}>${escapeHtml(formatBungieCharacterOption(character, characters))}</option>`
  ).join("");
}

function setBungieTargetCharacter(characterId) {
  const valid = getBungieCharactersForClass().some(character =>
    character.characterId === String(characterId)
  );
  if (!valid) return;
  bungieTargetCharacterId = String(characterId);
  ownedArmorActionStatus = null;
  renderUpgradeImportPanel();
  if (lastInventoryResult?.results?.length) renderInventoryResults(lastInventoryResult);
  if (calculatorMode === "solve" && allSolutions.length > 0) buildOwnedGearSection();
}

function renderOwnedGearBungieTargetControl() {
  if (!__BUNGIE_OAUTH_CLIENT_ID__ || !hasToken() || importSource !== "bungie" || !bungieProfileState) {
    return "";
  }
  const options = getBungieTargetOptionsHtml();
  if (!options) return "";
  return `<label class="owned-gear-target">
    <span>${l("操作角色", "操作角色", "Target character")}</span>
    <select onchange="setBungieTargetCharacter(this.value)" ${isBungieApplying ? "disabled" : ""}>${options}</select>
  </label>`;
}

function bungieArmorItemActionErrorMessage(error) {
  if (error?.code === "missingTarget") {
    return l("没有可操作的同职业目标角色。", "沒有可操作的同職業目標角色。", "No compatible target character was found.");
  }
  if (error?.code === "missingItem") {
    return l("这件护甲已不在当前 Bungie 库存中，请先同步库存。", "這件防具已不在目前 Bungie 庫存中，請先同步庫存。", "This armor is no longer in the current Bungie inventory. Sync first.");
  }
  if (error?.code === "missingOwner") {
    return l("当前库存快照无法确认这件护甲的位置，请先同步库存。", "目前庫存快照無法確認這件防具的位置，請先同步庫存。", "The inventory snapshot cannot determine this armor's location. Sync first.");
  }
  return bungiePlanErrorMessage(error);
}

function getOwnedArmorItemLocationLabel(item, targetCharacterId) {
  if (String(item?.owner) === String(targetCharacterId)) {
    return item.equipped
      ? l("已在装备栏", "已在裝備欄", "Equipped")
      : l("目标角色背包", "目標角色背包", "Target inventory");
  }
  if (item?.owner === "Vault") return l("保险库", "保管庫", "Vault");
  return l("其他角色", "其他角色", "Another character");
}

function getOwnedArmorBungieActionState(item) {
  if (item?.manualOwned || !__BUNGIE_OAUTH_CLIENT_ID__ || importSource !== "bungie") {
    return { hidden: true };
  }
  if (!hasToken()) {
    return {
      available: false,
      action: "transfer",
      label: l("拉取到角色", "拉取到角色", "Pull to character"),
      location: "",
      reason: l("请先登录 Bungie。", "請先登入 Bungie。", "Sign in to Bungie first."),
    };
  }
  if (!bungieProfileState) {
    return {
      available: false,
      action: "transfer",
      label: l("拉取到角色", "拉取到角色", "Pull to character"),
      location: "",
      reason: l("请先同步 Bungie 库存。", "請先同步 Bungie 庫存。", "Sync your Bungie inventory first."),
    };
  }
  syncBungieTargetCharacter();
  const target = bungieProfileState.characters?.[bungieTargetCharacterId];
  if (!target) {
    return {
      available: false,
      action: "transfer",
      label: l("拉取到角色", "拉取到角色", "Pull to character"),
      location: "",
      reason: bungieArmorItemActionErrorMessage({ code: "missingTarget" }),
    };
  }
  const plan = buildBungieArmorItemActionPlan({
    membershipType: bungieProfileState.membershipType,
    membershipId: bungieProfileState.membershipId,
    targetCharacterId: bungieTargetCharacterId,
    targetClassId: target.classId,
    itemId: item?.id ?? item?.sourceId,
    inventory: importedInventory,
    targetCharacterInventory: bungieProfileState.characterInventories?.[bungieTargetCharacterId],
  });
  const busy = isBungieApplying;
  const action = plan.action;
  const label = busy
    ? l("正在操作…", "正在操作…", "Working…")
    : action === "equip"
      ? l("装备此件", "裝備此件", "Equip this item")
      : action === "equipped"
        ? l("已装备", "已裝備", "Equipped")
        : l("拉取到角色", "拉取到角色", "Pull to character");
  const reason = !plan.valid
    ? bungieArmorItemActionErrorMessage(plan.errors[0])
    : action === "equipped"
      ? l("这件护甲已装备在目标角色身上。", "這件防具已裝備在目標角色身上。", "This armor is already equipped on the target character.")
      : busy
        ? l("正在执行另一项 Bungie 操作，请稍候。", "正在執行另一項 Bungie 操作，請稍候。", "Another Bungie action is in progress.")
        : "";
  return {
    available: plan.valid && action !== "equipped" && !busy,
    action,
    label,
    location: getOwnedArmorItemLocationLabel(item, bungieTargetCharacterId),
    reason,
    plan,
  };
}

function renderOwnedArmorBungieAction(item) {
  const state = getOwnedArmorBungieActionState(item);
  if (state.hidden) return "";
  const rawItemId = String(item?.id ?? item?.sourceId ?? "");
  const itemId = escapeHtml(JSON.stringify(rawItemId));
  const title = state.reason ? ` title="${escapeHtml(state.reason)}"` : "";
  const actionIcon = state.action === "transfer" ? "refresh" : "check";
  return `<span class="owned-armor-match-actions">
    ${state.location ? `<small>${escapeHtml(state.location)}</small>` : ""}
    <button type="button" class="btn owned-armor-action" data-item-id="${escapeHtml(rawItemId)}" onclick="applyOwnedArmorItemAction(${itemId})" ${state.available ? "" : "disabled"}${title}>${icon(actionIcon)}${state.label}</button>
  </span>`;
}

function showOwnedArmorActionMessage(text, tone = "info") {
  ownedArmorActionStatus = { text, tone };
  buildOwnedGearSection();
}

function updateLocalOwnedArmorItemState(verification) {
  if (verification?.status !== 'verified') return;
  const byId = new Map((verification.locations || []).map(location => [location.id, location]));
  for (const item of importedInventory) {
    const observed = byId.get(String(item.id));
    if (observed && Number(item.hash) === observed.hash) {
      item.owner = observed.owner;
      item.equipped = observed.equipped;
    }
  }
  invalidateOwnedPlanCache();
  if (bungieProfileState) Object.assign(bungieProfileState.characterInventories, verification.characterInventories || {});
}

async function applyOwnedArmorItemAction(itemId) {
  if (isBungieApplying) return;
  const item = importedInventory.find(candidate => String(candidate?.id ?? "") === String(itemId));
  if (!item) {
    showOwnedArmorActionMessage(bungieArmorItemActionErrorMessage({ code: "missingItem" }), "error");
    return;
  }
  const state = getOwnedArmorBungieActionState(item);
  if (!state.available || !state.plan) {
    showOwnedArmorActionMessage(state.reason || l("当前无法操作这件护甲。", "目前無法操作這件防具。", "This armor cannot be actioned right now."), "error");
    return;
  }
  const itemName = item.name || l("这件护甲", "這件防具", "this armor");
  isBungieApplying = true;
  showOwnedArmorActionMessage(
    state.action === "equip"
      ? l(`正在装备「${itemName}」…`, `正在裝備「${itemName}」…`, `Equipping “${itemName}”…`)
      : l(`正在拉取「${itemName}」到目标角色…`, `正在拉取「${itemName}」到目標角色…`, `Pulling “${itemName}” to the target character…`),
  );
  try {
    const result = await applyBungieArmorItemAction(state.plan, {
      onProgress: ({ stage }) => {
        if (stage === "unequip-source") {
          showOwnedArmorActionMessage(
            l(`正在为另一角色换上备用件，再拉取「${itemName}」…`, `正在為另一角色換上備用件，再拉取「${itemName}」…`, `Equipping a replacement on another character before pulling “${itemName}”…`),
          );
        }
      },
    });
    if (result.equipFailure && result.verification?.status !== 'verified') {
      showOwnedArmorActionMessage(
        l("游戏未能装备此件护甲。请确认角色在轨道、社交空间或离线状态后重试。", "遊戲未能裝備此件防具。請確認角色在軌道、社交空間或離線狀態後重試。", "The game could not equip this armor. Make sure the character is in orbit, a social space, or offline, then retry."),
        "error",
      );
      return;
    }
    if (result.verification?.status === 'verified' && result.action === 'equip') result.action = 'equipped';
    if (result.verification?.status !== "verified") {
      lastBungieImportAt = 0;
      showOwnedArmorActionMessage(l('操作已发送，但服务器状态尚未确认。请刷新库存后核对，不要重复点击。',
        '操作已送出，但伺服器狀態尚未確認。請重新整理庫存後核對，不要重複點擊。',
        'Action sent, but server state is not confirmed. Refresh inventory before retrying.'), 'warn');
      return;
    }
    updateLocalOwnedArmorItemState(result.verification);
    lastBungieImportAt = 0;
    const target = bungieProfileState?.characters?.[state.plan.targetCharacterId];
    const targetLabel = target ? formatBungieCharacterLabel(target) : l("目标角色", "目標角色", "the target character");
    showOwnedArmorActionMessage(
      result.action === "transferred"
        ? l(`已把「${itemName}」拉取到 ${targetLabel} 的背包；现在可点击“装备此件”。`, `已把「${itemName}」拉取到 ${targetLabel} 的背包；現在可點擊「裝備此件」。`, `Pulled “${itemName}” into ${targetLabel}'s inventory. You can now equip it.`)
        : l(`已将「${itemName}」装备到 ${targetLabel}。`, `已將「${itemName}」裝備到 ${targetLabel}。`, `Equipped “${itemName}” on ${targetLabel}.`),
    );
  } catch (error) {
    if (error.reconciliation?.status === 'verified') {
      updateLocalOwnedArmorItemState(error.reconciliation);
      showOwnedArmorActionMessage(l('请求响应异常，但服务器回读已确认操作完成。','請求回應異常，但伺服器回讀已確認操作完成。','The response failed, but server read-back confirmed completion.'));
    } else {
      lastBungieImportAt = 0;
      showOwnedArmorActionMessage(l('操作未确认，可能已部分完成。请刷新库存核对后再操作。','操作未確認，可能已部分完成。請重新整理庫存核對後再操作。','Action unconfirmed; some steps may have completed. Refresh inventory before another action.'), 'warn');
    }
  } finally {
    isBungieApplying = false;
    buildOwnedGearSection();
  }
}

function setFragmentAdjustmentsToUI(adjustments) {
  for (const stat of STATS) {
    const el = document.getElementById("fragVal_" + stat);
    if (!el) continue;
    const value = Number(adjustments?.[stat]) || 0;
    el.textContent = value;
    el.style.color = value !== 0 ? STAT_COLORS[stat] : "";
  }
  updateBudget();
  updateUpgradeBudgetSummary();
  scheduleRealtimeRanges();
}

function fragmentAdjustmentsMatch(left, right) {
  return STATS.every(stat => (Number(left?.[stat]) || 0) === (Number(right?.[stat]) || 0));
}

const BUNGIE_WEAPON_BUCKET_TERMS = new Map([
  [1498876634, "kineticWeapon"],
  [2465295065, "energyWeapon"],
  [953998645, "powerWeapon"],
]);

function getSavedBungieLoadoutSummary(loadout) {
  const armor = mapSavedLoadoutArmor(loadout, importedInventory);
  const pieces = armor.map(item => {
    const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === item.slot);
    if (slotIndex < 0) return null;
    const piece = createUpgradePieceFromItem(item, slotIndex);
    return {
      item,
      piece,
      stats: applyManualUpgradeModifiers(getUpgradeConfig(piece), piece),
    };
  }).filter(Boolean);
  const character = bungieProfileState?.characters?.[bungieTargetCharacterId] || null;
  const plugHashes = (loadout?.items || []).flatMap(item => item.plugItemHashes || []);
  const fragments = getFragmentAdjustments(plugHashes, character?.classId);
  const totals = pieces.length === 5
    ? finalizeUpgradeTotals(getManualUpgradeArmorTotals(pieces.map(entry => entry.piece)), fragments)
    : null;
  const itemHashes = armor.map(item => item.hash).filter(Boolean);
  const sets = [...getSetPieceCounts(itemHashes)].map(([set, count]) => ({
    set,
    count,
    name: getSetName(set, getPageLanguage()),
  })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const activeBonuses = getActiveSetBonuses(itemHashes, getPageLanguage());
  const exotic = armor.find(item => item.exotic) || null;
  const weapons = (loadout?.items || []).filter(item => BUNGIE_WEAPON_BUCKET_TERMS.has(Number(item.bucketHash)));
  return { armor, pieces, totals, sets, activeBonuses, exotic, weapons };
}

function renderSavedBungieLoadoutStats(totals) {
  return `<div class="bungie-loadout-stats" aria-label="${escapeHtml(l("配装六维属性", "配裝六維數值", "Loadout stats"))}">${STATS.map(stat => `
    <span style="--loadout-stat:${STAT_COLORS[stat]}">
      <small>${escapeHtml(STAT_LABELS[stat])}</small>
      <strong>${totals ? totals[stat] : "—"}</strong>
    </span>`).join("")}</div>`;
}

function formatSavedArmorModifier(item) {
  const tuning = item.tuningMode === "plus3"
    ? l("+3 调整", "+3 調校", "+3 Tuning")
    : item.tuningTo && item.tuningFrom
      ? l(
        `调整 -5${STAT_LABELS[item.tuningFrom]} / +5${STAT_LABELS[item.tuningTo]}`,
        `調校 -5${STAT_LABELS[item.tuningFrom]} / +5${STAT_LABELS[item.tuningTo]}`,
        `Tuning -5 ${STAT_LABELS[item.tuningFrom]} / +5 ${STAT_LABELS[item.tuningTo]}`,
      )
      : l("调整未知", "調校未知", "Tuning unknown");
  const mod = item.armorModSize > 0 && item.armorModStat
    ? l(
      `模组 +${item.armorModSize}${STAT_LABELS[item.armorModStat]}`,
      `模組 +${item.armorModSize}${STAT_LABELS[item.armorModStat]}`,
      `Mod +${item.armorModSize} ${STAT_LABELS[item.armorModStat]}`,
    )
    : l("无属性模组", "無數值模組", "No stat mod");
  return `${tuning} · ${mod}`;
}

function renderSavedBungieLoadoutDetail(summary, detailId) {
  const setBonusHtml = summary.activeBonuses.length > 0
    ? `<section class="bungie-loadout-detail-section">
        <h5>${term("activeArmorSetBonuses")}</h5>
        <ul class="bungie-loadout-bonus-list">${summary.activeBonuses.map(bonus => `
          <li><strong>${escapeHtml(bonus.name)}</strong><span>${escapeHtml(bonus.requiredCount + l(" 件套", " 件套", "-piece"))}</span></li>`).join("")}</ul>
      </section>`
    : "";
  const weaponHtml = summary.weapons.length > 0
    ? `<section class="bungie-loadout-detail-section">
        <h5>${l("武器", "武器", "Weapons")}</h5>
        <ul class="bungie-loadout-weapon-list">${summary.weapons.map(weapon => {
          const label = term(BUNGIE_WEAPON_BUCKET_TERMS.get(Number(weapon.bucketHash)));
          return `<li><span>${escapeHtml(label)}</span><strong>${weapon.power ? `${term("power")} ${weapon.power}` : l("已保存", "已儲存", "Saved")}</strong></li>`;
        }).join("")}</ul>
        <p class="bungie-loadout-data-note">${l("当前本地物品库未包含武器名称；同步状态和能量来自 Bungie 配装记录。", "目前本機物品庫未包含武器名稱；同步狀態與力量來自 Bungie 配裝記錄。", "The local item catalog does not include weapon names; saved state and Power come from Bungie.")}</p>
      </section>`
    : "";
  return `<div class="bungie-loadout-detail" id="${detailId}">
    <section class="bungie-loadout-detail-section">
      <h5>${l("护甲详情", "防具詳情", "Armor details")}</h5>
      <ul class="bungie-loadout-armor-list">${summary.pieces.map(({ item, piece, stats }) => {
        const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === item.slot);
        const set = item.setHash ? getArmorSetByHash(item.setHash) : null;
        const badges = [
          item.exotic ? l("异域", "異域", "Exotic") : "",
          set ? getSetName(set, getPageLanguage()) : "",
          getArchetypeLabel(piece.archetypeId),
        ].filter(Boolean).join(" · ");
        return `<li class="bungie-loadout-armor-item">
          <div><small>${getUpgradeSlotLabel(slotIndex)}</small><strong>${escapeHtml(item.name || l("未命名护甲", "未命名防具", "Unnamed armor"))}</strong><span>${escapeHtml(badges)}</span></div>
          <div class="bungie-loadout-piece-stats">${STATS.map(stat => `<span style="--loadout-stat:${STAT_COLORS[stat]}">${escapeHtml(STAT_LABELS[stat])} <strong>${stats[stat] ?? 0}</strong></span>`).join("")}</div>
          <p>${escapeHtml(formatSavedArmorModifier(item))}</p>
        </li>`;
      }).join("")}</ul>
    </section>
    ${setBonusHtml}
    ${weaponHtml}
  </div>`;
}

function toggleBungieLoadoutDetail(button) {
  const card = button?.closest(".bungie-loadout-card");
  if (!card) return;
  const isOpen = !card.classList.contains("is-detail-open");
  card.classList.toggle("is-detail-open", isOpen);
  button.setAttribute("aria-expanded", String(isOpen));
}

function handleBungieLoadoutDetailKeydown(event) {
  if (event.key !== "Escape") return;
  const card = event.currentTarget;
  const button = card.querySelector(".bungie-loadout-detail-toggle");
  card.classList.remove("is-detail-open");
  button?.setAttribute("aria-expanded", "false");
  button?.focus();
}

function getSavedBungieLoadoutsHtml() {
  if (!__BUNGIE_OAUTH_CLIENT_ID__ || !hasToken() || !bungieProfileState) return "";
  syncBungieTargetCharacter();
  const loadouts = bungieProfileState.savedLoadouts?.[bungieTargetCharacterId] || [];
  const targetOptions = getBungieTargetOptionsHtml();
  return `<details class="bungie-saved-loadouts" data-disclosure-key="saved-loadouts">
    <summary>${l(
      `游戏内已保存配装（${loadouts.length}）`,
      `遊戲內已儲存配裝（${loadouts.length}）`,
      `In-game saved loadouts (${loadouts.length})`,
    )}</summary>
    <div class="bungie-saved-toolbar">
      <label>
        <span>${l("角色", "角色", "Character")}</span>
        <select onchange="setBungieTargetCharacter(this.value)" ${targetOptions ? "" : "disabled"}>${targetOptions}</select>
      </label>
      <p>${l(
        "直接应用调用游戏官方配装；载入编辑会把其中的护甲、模组和碎片属性带回优化器。",
        "直接套用會呼叫遊戲官方配裝；載入編輯會把其中的防具、模組與碎片數值帶回最佳化工具。",
        "Apply uses the official in-game loadout. Load for editing brings its armor, mods, and Fragment stats into the optimizer.",
      )}</p>
    </div>
    <div class="bungie-saved-list">${loadouts.length === 0
      ? `<p class="upgrade-empty">${l("该角色还没有游戏内配装。", "該角色還沒有遊戲內配裝。", "This character has no in-game loadouts yet.")}</p>`
      : loadouts.map(loadout => {
        const summary = getSavedBungieLoadoutSummary(loadout);
        const loadoutNumber = loadout.loadoutIndex + 1;
        const detailId = `bungieLoadoutDetail-${loadout.loadoutIndex}`;
        const setSummary = summary.sets.map(entry => `${entry.name} ${entry.count}/5`).join(" · ");
        return `<article class="bungie-loadout-card" tabindex="0" onkeydown="handleBungieLoadoutDetailKeydown(event)">
          <header class="bungie-loadout-card-head">
            <div><strong>${l(`配装 ${loadoutNumber}`, `配裝 ${loadoutNumber}`, `Loadout ${loadoutNumber}`)}</strong><small>${l(`护甲 ${summary.armor.length}/5 · 武器 ${summary.weapons.length}`, `防具 ${summary.armor.length}/5 · 武器 ${summary.weapons.length}`, `${summary.armor.length}/5 armor · ${summary.weapons.length} weapons`)}</small></div>
            <button type="button" class="bungie-loadout-detail-toggle" aria-expanded="false" aria-controls="${detailId}" onclick="toggleBungieLoadoutDetail(this)">${icon("hint")}<span>${l("详情", "詳情", "Details")}</span></button>
          </header>
          ${renderSavedBungieLoadoutStats(summary.totals)}
          <div class="bungie-loadout-highlights">
            ${summary.exotic ? `<span class="is-exotic">${escapeHtml(summary.exotic.name)}</span>` : `<span>${l("无异域护甲", "無異域防具", "No Exotic armor")}</span>`}
            ${setSummary ? `<span>${escapeHtml(setSummary)}</span>` : `<span>${l("无护甲套装加成", "無防具套裝獎勵", "No Armor Set Bonus")}</span>`}
          </div>
          ${renderSavedBungieLoadoutDetail(summary, detailId)}
          <footer class="bungie-saved-actions">
            <button type="button" class="btn" onclick="editBungieSavedLoadout('${escapeHtml(bungieTargetCharacterId)}',${loadout.loadoutIndex})" ${summary.armor.length < 5 || isBungieApplying ? "disabled" : ""}>${icon("refresh")}${l("载入编辑", "載入編輯", "Load for editing")}</button>
            <button type="button" class="btn-solve" onclick="applyBungieSavedLoadout('${escapeHtml(bungieTargetCharacterId)}',${loadout.loadoutIndex})" ${isBungieApplying ? "disabled" : ""}>${icon("check")}${l("直接应用", "直接套用", "Apply")}</button>
          </footer>
        </article>`;
      }).join("")}</div>
  </details>`;
}

function findSavedBungieLoadout(characterId, loadoutIndex) {
  return (bungieProfileState?.savedLoadouts?.[String(characterId)] || [])
    .find(loadout => loadout.loadoutIndex === Number(loadoutIndex)) || null;
}

async function applyBungieSavedLoadout(characterId, loadoutIndex) {
  if (isBungieApplying || !bungieProfileState) return;
  isBungieApplying = true;
  renderUpgradeImportPanel();
  let outcome = null;
  try {
    await equipSavedLoadout({
      membershipType: bungieProfileState.membershipType,
      characterId,
      loadoutIndex,
    });
    lastBungieImportAt = 0;
    outcome = { message: l(
      "游戏内配装已完整应用。",
      "遊戲內配裝已完整套用。",
      "The in-game loadout was applied successfully.",
    ), tone: "info" };
  } catch (error) {
    outcome = { error };
  } finally {
    isBungieApplying = false;
    renderUpgradeImportPanel();
    if (outcome?.error) handleBungieEquipError(outcome.error, "import");
    else if (outcome) showImportMessage(outcome.message, outcome.tone);
  }
}

function editBungieSavedLoadout(characterId, loadoutIndex) {
  const loadout = findSavedBungieLoadout(characterId, loadoutIndex);
  const character = bungieProfileState?.characters?.[String(characterId)];
  if (!loadout || !character) return;
  const armor = mapSavedLoadoutArmor(loadout, importedInventory);
  if (armor.length < 5) {
    showImportMessage(l(
      "该游戏内配装的五件护甲实例未全部出现在当前 Bungie 库存中，请先刷新库存。",
      "該遊戲內配裝的五件防具實例未全部出現在目前 Bungie 庫存中，請先重新整理庫存。",
      "Not all five armor instances from this in-game loadout are in the current Bungie inventory. Refresh first.",
    ));
    return;
  }
  importClassFilter = character.classId || importClassFilter;
  bungieTargetCharacterId = String(characterId);
  setCalculatorMode("upgrade");
  applyLoadoutItems(armor);
  const plugHashes = loadout.items.flatMap(item => item.plugItemHashes || []);
  setFragmentAdjustmentsToUI(getFragmentAdjustments(plugHashes, character.classId));
  applyCurrentStatsToTargets();
  saveCurrentDraft();
  saveUpgradeDraft();
  renderUpgradeImportPanel();
  showImportMessage(l(
    "已把游戏内配装载入优化器；修改后可从“已有护甲搭配方案”装备回游戏。",
    "已把遊戲內配裝載入最佳化工具；修改後可從「已有防具搭配方案」裝備回遊戲。",
    "The in-game loadout is loaded for editing. After changes, equip it from Owned armor loadouts.",
  ), "info");
}

function bungiePlanErrorMessage(error) {
  const code = error?.code;
  if (code === "notOwnedInstance" || code === "missingPieces") {
    return l("方案含刷取件或缺少实例 ID，不能直接装备。", "方案含待取得防具或缺少實例 ID，不能直接裝備。", "This plan contains farmed pieces or missing instance IDs.");
  }
  if (code === "exoticPerkMismatch") {
    return l("异域职业物品的现有实例词条与方案不匹配。", "異域職業物品的現有實例詞條與方案不相符。", "The owned Exotic class item roll does not match this plan.");
  }
  if (code === "plugUnavailable") {
    return l("方案使用了该角色尚未解锁的模组。", "方案使用了該角色尚未解鎖的模組。", "This plan uses a mod that the character has not unlocked.");
  }
  if (code === "energy") {
    return l("方案中一件护甲的能量不足以安装其属性模组；请升级护甲能量后重试。", "方案中一件防具的能量不足以安裝其數值模組；請升級防具能量後重試。", "An armor piece lacks the energy to hold its stat mod. Upgrade the armor energy first.");
  }
  if (code === "tuningMismatch") {
    return l("方案为护甲分配的调整方向与该护甲的固定调整属性不符。", "方案為防具分配的調校方向與該防具的固定調校數值不符。", "The plan's tuning direction does not match the armor's fixed Tuning Stat.");
  }
  if (code === "multipleExotics") {
    return l("方案包含多件异域护甲；最多只能穿戴一件异域。", "方案包含多件異域防具；最多只能穿戴一件異域。", "This plan includes more than one Exotic armor piece.");
  }
  if (code === "cannotClearStatMod") {
    return l("无法从当前库存快照安全移除一件已装属性模组，请刷新库存后重试。", "無法從目前庫存快照安全移除一件已裝數值模組，請重新整理庫存後重試。", "An installed stat mod cannot be safely removed from the current inventory snapshot. Refresh and retry.");
  }
  if (code === "equippedElsewhereNoReplacement") {
    return l("其他角色正穿着方案护甲，且没有同槽位备用件可先替换。", "其他角色正穿著方案防具，且沒有同欄位備用件可先替換。", "Another character is wearing a required piece and has no spare for that slot.");
  }
  if (code === "statSocketMissing" || code === "tuningSocketMissing"
      || code === "statSocketUnknown" || code === "tuningSocketUnknown" || code === "invalidTuning") {
    return l("无法从当前库存快照安全定位一个护甲模组插槽，请刷新库存或改用 DIM。", "無法從目前庫存快照安全定位一個防具模組插槽，請重新整理庫存或改用 DIM。", "A required armor socket cannot be located safely. Refresh the inventory or use DIM.");
  }
  if (code === "classMismatch") {
    return l("目标角色职业与方案不匹配。", "目標角色職業與方案不相符。", "The target character class does not match this loadout.");
  }
  if (code === "itemCannotEquip") {
    return l("方案中有护甲当前不可穿戴，请检查等级、内容许可或物品状态。", "方案中有防具目前不可穿著，請檢查等級、內容授權或物品狀態。", "An armor piece cannot currently be equipped. Check level, content ownership, or item state.");
  }
  return l("方案未通过装备前自检，请刷新 Bungie 库存后重试。", "方案未通過裝備前自檢，請重新整理 Bungie 庫存後重試。", "The loadout failed preflight. Refresh the Bungie inventory and try again.");
}

function getInventorySolutionEquipState(entry) {
  if (!entry?.verified) return { available: false, reason: 'UNVERIFIED: loadout' };
  if (!__BUNGIE_OAUTH_CLIENT_ID__) return { available: false, hidden: true };
  if (!hasToken()) return { available: false, reason: l("请先登录 Bungie。", "請先登入 Bungie。", "Sign in to Bungie first.") };
  if (importSource !== "bungie" || !bungieProfileState) {
    return { available: false, reason: l("请先从 Bungie 导入真实库存。", "請先從 Bungie 匯入真實庫存。", "Import your live Bungie inventory first.") };
  }
  syncBungieTargetCharacter();
  const target = bungieProfileState.characters?.[bungieTargetCharacterId];
  if (!target) return { available: false, reason: l("没有匹配职业的目标角色。", "沒有相符職業的目標角色。", "No matching target character was found.") };
  const subclass = bungieProfileState.currentSubclassByCharacter?.[bungieTargetCharacterId];
  if (!subclass || !fragmentAdjustmentsMatch(subclass.adjustments, getUpgradeFragments())) {
    return {
      available: false,
      reason: l(
        "碎片数值不是该目标角色当前分支职业的精确配置；当前界面只保存数值总和，无法无歧义反推具体碎片。请填入该角色当前穿戴，或直接应用游戏内已存配装。",
        "碎片數值不是該目標角色目前副職業的精確配置；目前介面只儲存數值總和，無法無歧義反推具體碎片。請填入該角色目前穿著，或直接套用遊戲內已存配裝。",
        "The Fragment totals do not match this character's exact current subclass. Totals cannot uniquely identify specific Fragments; fill the current loadout or apply an in-game saved loadout.",
      ),
    };
  }
  const plan = buildCustomLoadoutPlan({
    membershipType: bungieProfileState.membershipType,
    membershipId: bungieProfileState.membershipId,
    targetCharacterId: bungieTargetCharacterId,
    classId: importClassFilter,
    pieces: entry?.pieces,
    tuningAssignments: entry?.tuningAssignments,
    modAssignments: entry?.modAssignments,
    inventory: importedInventory,
    availablePlugHashes: bungieProfileState.availablePlugHashesByCharacter?.[bungieTargetCharacterId],
    targetCharacterInventory: bungieProfileState.characterInventories?.[bungieTargetCharacterId],
    verifiedWitness: entry,
  });
  if (!plan.valid) {
    return { available: false, reason: bungiePlanErrorMessage(plan.errors[0]), plan };
  }
  if (plan.assignment.executionStatus !== 'VERIFIED') return {available: false, plan,
    reason: l('UNVERIFIED：执行证据不足。', 'UNVERIFIED：執行證據不足。', 'UNVERIFIED: execution evidence is incomplete.')};
  return {
    available: !isBungieApplying,
    plan,
    reason: isBungieApplying
      ? l("正在装备，请稍候…", "正在裝備，請稍候…", "Applying loadout…")
      : "",
  };
}

function showBungieEquipMessage(text, tone = "info") {
  const el = document.getElementById("bungieEquipStatus");
  if (!el) return;
  el.innerHTML = `<div class="msg ${tone}">${icon(tone === "error" ? "block" : tone === "warn" ? "warn" : "check")}<span>${escapeHtml(text)}</span></div>`;
}

function bungieWriteErrorMessage(error) {
  const root = error instanceof BungieLoadoutApplyError ? error.cause : error;
  if (root instanceof ThrottleError) return bungieErrorMessage(root);
  if (root instanceof FatalTokenError || root instanceof NetworkError || root instanceof ApiKeyError) {
    return bungieErrorMessage(root);
  }
  if (root instanceof ApiError) {
    if ([1634, 1654, 1671, 1681].includes(root.errorCode)) {
      return l("角色不在轨道、社交空间或离线状态；回到可管理装备的位置后重试。", "角色不在軌道、社交空間或離線狀態；回到可管理裝備的位置後重試。", "The character is not in orbit, a social space, or offline. Move to a valid location and try again.");
    }
    if ([1666, 2105, 2108].includes(root.errorCode) || root.status === 403) {
      return l("应用缺少 MoveEquipDestinyItems 权限；请在 Bungie 应用后台开启后重新登录。", "應用缺少 MoveEquipDestinyItems 權限；請在 Bungie 應用後台開啟後重新登入。", "The app lacks MoveEquipDestinyItems. Enable it in the Bungie application settings, then sign in again.");
    }
    if (root.errorCode === 1675) {
      return l("护甲能量或材料不足，未能写入全部模组。", "防具能量或材料不足，未能寫入全部模組。", "Armor energy or materials were insufficient, so not every mod was inserted.");
    }
    if ([1676, 1677, 1678, 1680].includes(root.errorCode)) {
      return l("模组或碎片未解锁，或该插槽不允许写入。", "模組或碎片未解鎖，或該插槽不允許寫入。", "A mod or Fragment is locked, or the socket rejected it.");
    }
  }
  return l("装备到游戏失败，请刷新库存后重试。", "裝備到遊戲失敗，請重新整理庫存後重試。", "Failed to apply the loadout. Refresh the inventory and try again.");
}

function handleBungieEquipError(error, surface = "result") {
  const partial = error instanceof BungieLoadoutApplyError && error.partial;
  const message = `${partial ? l(
    "已完成部分转移或穿戴，但整套尚未完整应用：",
    "已完成部分轉移或穿著，但整套尚未完整套用：",
    "Some transfers or equips completed, but the full loadout was not applied: ",
  ) : ""}${bungieWriteErrorMessage(error)}`;
  if (surface === "import") showImportMessage(message);
  else showBungieEquipMessage(message, "error");
}

async function equipInventorySolution(index) {
  // Only a fully owned inventory entry can be written back to the game; a
  // theoretical skeleton with farm gaps has no live instances to equip.
  const unified = resolveUnifiedEntry(index);
  const entry = unified?.kind === "inventory" ? unified.witness : null;
  if (!entry || isBungieApplying) return;
  const equipState = getInventorySolutionEquipState(entry);
  if (!equipState.available || !equipState.plan) {
    showBungieEquipMessage(equipState.reason || bungiePlanErrorMessage(equipState.plan?.errors?.[0]), "error");
    return;
  }
  isBungieApplying = true;
  renderInventoryResults(lastInventoryResult);
  showBungieEquipMessage(l("自检通过，正在转移护甲…", "自檢通過，正在轉移防具…", "Preflight passed. Transferring armor…"));
  try {
    const result = await applyCustomLoadoutPlan(equipState.plan, {
      onProgress: ({ stage }) => {
        const stageText = stage === "plugs"
          ? l("护甲已穿戴，正在写入模组…", "防具已穿著，正在寫入模組…", "Armor equipped. Inserting mods…")
          : stage === "equip"
            ? l("转移完成，正在穿戴五件护甲…", "轉移完成，正在穿著五件防具…", "Transfer complete. Equipping all five pieces…")
            : l("正在整理并转移护甲…", "正在整理並轉移防具…", "Preparing and transferring armor…");
        showBungieEquipMessage(stageText);
      },
    });
    lastBungieImportAt = 0;
    const nameByInstanceId = new Map(
      importedInventory.map(item => [String(item.id), item.name]),
    );
    const equipFailures = result.equipFailures || [];
    const plugFailures = result.plugFailures || [];
    if (equipFailures.length > 0) {
      const equipped = result.completed.targetEquip;
      const failedNames = equipFailures
        .map(failure => nameByInstanceId.get(String(failure.itemId)) || "")
        .filter(Boolean)
        .join("、");
      const plugNote = plugFailures.length > 0
        ? `；${plugFailures.length} 个模组写入失败`
        : "";
      showBungieEquipMessage(
        l(
          `已装备 ${equipped}/5 件护甲，${equipFailures.length} 件未能装备${failedNames ? `（${failedNames}）` : ""}。请确认角色在轨道或社交空间、且背包有空间后重试${plugNote}。`,
          `已裝備 ${equipped}/5 件防具，${equipFailures.length} 件未能裝備${failedNames ? `（${failedNames}）` : ""}。請確認角色在軌道或社交空間、且背包有空間後重試${plugNote}。`,
          `Equipped ${equipped}/5 armor pieces; ${equipFailures.length} failed to equip${failedNames ? ` (${failedNames})` : ""}. Make sure the character is in orbit or a social space and has inventory space, then retry${plugNote}.`,
        ),
        "warn",
      );
      return;
    }
    const verification = result.verification;
    const realMismatches = verification?.mismatches || [];
    if (verification?.status !== "verified" || plugFailures.length > 0) {
      const missingPlugs = realMismatches
        .filter(match => match.kind === "plugMismatch").length;
      showBungieEquipMessage(
        l(
          `护甲与模组已装备，但回读核对发现 ${realMismatches.length} 处不一致（含 ${missingPlugs} 个模组写入未生效）。请刷新库存确认，或稍后重试。`,
          `防具與模組已裝備，但回讀核對發現 ${realMismatches.length} 處不一致（含 ${missingPlugs} 個模組寫入未生效）。請重新整理庫存確認，或稍後重試。`,
          `Armor and mods were equipped, but the verification read-back found ${realMismatches.length} mismatch(es) (${missingPlugs} mod write(s) did not take effect). Refresh the inventory or retry.`,
        ),
        "warn",
      );
      return;
    }
    showBungieEquipMessage(
      l(
        "五件护甲与全部模组已装备，并经回读核对一致。分支职业、星相与碎片保持目标角色当前精确配置。",
        "五件防具與全部模組已裝備，並經回讀核對一致。副職業、相位與碎片保持目標角色目前精確配置。",
        "All five armor pieces and every mod were equipped and confirmed by a verification read-back. The target character's exact subclass, Aspects, and Fragments were preserved.",
      ),
      "info",
    );
  } catch (error) {
    handleBungieEquipError(error);
  } finally {
    isBungieApplying = false;
    const statusHtml = document.getElementById("bungieEquipStatus")?.innerHTML || "";
    renderInventoryResults(lastInventoryResult);
    const status = document.getElementById("bungieEquipStatus");
    if (status) status.innerHTML = statusHtml;
  }
}

async function importInventoryFromBungie({ silent = false } = {}) {
  if (!getToken()) {
    showImportMessage(l(
      "尚未登录 Bungie。",
      "尚未登入 Bungie。",
      "Not signed in to Bungie.",
    ));
    return;
  }
  if (isBungieImporting) return;
  isBungieImporting = true;
  renderBungieAuthState();
  try {
    const { membershipType, membershipId } = await resolveMemberships();
    const components = [...ARMOR_COMPONENTS, ...LOADOUT_WRITE_COMPONENTS];
    const response = await bungieFetch(
      `/Destiny2/${membershipType}/Profile/${membershipId}/?components=${components.join(",")}`,
      { auth: true },
    );
    // A native select popup cannot survive replacing its DOM node. Defer the
    // passive update while the user is choosing a filter; the next poll retries.
    if (silent && document.activeElement?.matches('#upgradeImportPanel select')) {
      isBungieImporting = false;
      renderBungieAuthState();
      return;
    }
    const { items, characters, characterInventories } = buildArmorInventory(response, { language: getPageLanguage() });
    const loadoutState = extractBungieLoadoutState(response);
    for (const [characterId, summary] of Object.entries(characters)) {
      const target = loadoutState.characters?.[characterId];
      if (target && summary.stats) target.stats = { ...summary.stats };
    }
    bungieProfileState = {
      membershipType,
      membershipId,
      characterInventories,
      ...loadoutState,
    };
    // Map the per-character subclass fragments to class ids so the equipped
    // loadout fill can look them up by the selected class.
    const fragmentsByCharacter = extractSubclassFragments(response);
    bungieSubclassFragments = null;
    const fragmentsByClass = {};
    for (const [characterId, character] of Object.entries(characters)) {
      const classId = CLASS_ID_BY_CLASS_TYPE[character?.classType];
      if (!classId) continue;
      const adjustments = fragmentsByCharacter[characterId];
      if (adjustments) fragmentsByClass[classId] = adjustments;
    }
    if (Object.keys(fragmentsByClass).length > 0) bungieSubclassFragments = fragmentsByClass;
    const replaced = importedInventory.length > 0;
    applyImportedInventory(items, "bungie", { passive: silent });
    syncBungieTargetCharacter();
    renderUpgradeImportPanel();
    lastBungieImportAt = Date.now();
    isBungieImporting = false;
    renderBungieAuthState();
    const countNote = replaced
      ? [
        `已替换为 Bungie 库存（${items.length} 件护甲）。`,
        `已替換為 Bungie 庫存（${items.length} 件防具）。`,
        `Replaced with Bungie inventory (${items.length} armor pieces).`,
      ]
      : [
        `已导入 ${items.length} 件 Bungie 护甲。`,
        `已匯入 ${items.length} 件 Bungie 防具。`,
        `Imported ${items.length} armor pieces from Bungie.`,
      ];
    if (silent) {
      // Inventory data updates in place without overwriting targets or the
      // current-loadout editor while the user is working.
    } else if (calculatorMode === "solve") {
      showImportMessage(l(
        `${countNote[0]} 请选择职业，再设置目标、套装和异域后求解。`,
        `${countNote[1]} 請選擇職業，再設定目標、套裝和異域後求解。`,
        `${countNote[2]} Choose a class, set your targets, set requirement, and Exotic, then solve.`,
      ), "info");
    } else if (importClassFilter) {
      applyEquippedLoadout();
      showImportMessage(l(...countNote), "info");
    } else {
      showImportMessage(l(
        `${countNote[0]} 清单包含多个职业的当前穿戴，请先选择职业，再填入当前穿戴。`,
        `${countNote[1]} 清單包含多個職業的目前穿戴，請先選擇職業，再填入目前穿戴。`,
        `${countNote[2]} The list contains equipped loadouts for multiple classes; choose a class before filling the loadout.`,
      ), "info");
    }
  } catch (error) {
    isBungieImporting = false;
    handleBungieAuthError(error);
  }
}

async function handleBungieOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code === null) {
    renderBungieAuthState();
    return;
  }
  const expectedState = sessionStorage.getItem(BUNGIE_OAUTH_STATE_KEY);
  if (!expectedState || params.get("state") !== expectedState) {
    showImportMessage(l(
      "登录状态校验失败，请重试。",
      "登入狀態驗證失敗，請重試。",
      "OAuth state check failed. Try again.",
    ));
    return;
  }
  sessionStorage.removeItem(BUNGIE_OAUTH_STATE_KEY);
  // Strip the OAuth code/state from the URL, keeping any other query
  // parameters. Rebuilding via URLSearchParams (same `params` object read
  // above) avoids the dangling "&" a regex-based strip leaves behind when
  // code/state coexist with other parameters.
  params.delete("code");
  params.delete("state");
  const cleanQuery = params.toString();
  history.replaceState({}, "", window.location.pathname + (cleanQuery ? `?${cleanQuery}` : ""));
  try {
    const token = await exchangeCodeForToken(code);
    saveToken(token);
    const memberships = await resolveMemberships();
    const displayName = memberships.displayName || "";
    try {
      localStorage.setItem(BUNGIE_DISPLAY_NAME_KEY, displayName);
    } catch {
      // ignore storage failures
    }
    renderBungieAuthState();
  } catch (error) {
    handleBungieAuthError(error);
  }
}

// Shared post-import pipeline for both CSV and Bungie imports: adopt the
// items, reset results/exotic filters, detect the class, re-render, persist.
function applyImportedInventory(items, source, { passive = false } = {}) {
  importedInventory = items;
  importSource = source;
  invalidateOwnedPlanCache();
  if (!passive) {
    inventoryImportExpanded = true;
    clearInventoryResults();
  }
  const importedClasses = new Set(items.map(item => item.classId).filter(Boolean));
  const detectedClass = detectEquippedClass(items);
  if (!importedClasses.has(importClassFilter)) {
    importClassFilter = detectedClass || (importedClasses.size === 1 ? [...importedClasses][0] : "");
  }
  // Keep a still-valid Exotic selection across re-imports. Clearing it here
  // unconditionally meant the Bungie auto-refresh (tab visibility) or a manual
  // re-import silently dropped the user's fixed Exotic, so solutions stopped
  // honoring it. getInventoryExoticPickerData (run by the render below) still
  // clears selections whose item is genuinely gone or class-incompatible.
  // Exotic Class Item mode re-syncs its class and key to the (possibly
  // auto-detected) import class so the checkbox state stays coherent.
  if (document.getElementById('useExoticMode')?.checked
      && inventoryExoticSlotFilter === 'classItem'
      && importClassFilter
      && EXOTIC_CLASSES[importClassFilter]) {
    const classSelect = document.getElementById('exoticClass');
    if (classSelect && classSelect.value !== importClassFilter) {
      classSelect.value = importClassFilter;
      updateExoticPerkOptions();
    } else if (inventoryFixedExoticKey !== getExoticClassItemKey(importClassFilter)) {
      inventoryFixedExoticKey = getExoticClassItemKey(importClassFilter);
    }
  }
  renderUpgradeImportPanel();
  if (passive) refreshInventoryPlansFromSolutions();
  saveUpgradeDraft();
}

function handleDimCsvFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const items = parseCsv(reader.result)
        .map(normalizeDimItem)
        .filter(item => item.slot);
      if (items.length === 0) {
        showImportMessage(l(
          "没有在 CSV 里识别到护甲行，请确认导出的是 DIM 的护甲清单。",
          "沒有在 CSV 中辨識到防具列，請確認匯出的是 DIM 的防具清單。",
          "No armor rows were recognized in the CSV. Export an armor list from DIM."
        ));
        return;
      }
      input.value = "";
      // A CSV carries no subclass sockets, so any Bungie fragment map from a
      // previous import must not leak into the CSV-backed loadout fill.
      bungieSubclassFragments = null;
      applyImportedInventory(items, "csv");
      if (calculatorMode === "solve") {
        showImportMessage(l(
          `已导入 ${items.length} 件护甲。请选择职业，再设置目标、套装和异域后求解。`,
          `已匯入 ${items.length} 件防具。請選擇職業，再設定目標、套裝和異域後求解。`,
          `Imported ${items.length} armor pieces. Choose a class, set your targets, set requirement, and Exotic, then solve.`,
        ), "info");
      } else if (importClassFilter) {
        applyEquippedLoadout();
      } else {
        showImportMessage(l(
          `已导入 ${items.length} 件护甲。CSV 包含多个职业的当前穿戴，请先选择职业，再填入当前穿戴。`,
          `已匯入 ${items.length} 件防具。CSV 包含多個職業的目前穿戴，請先選擇職業，再填入目前穿戴。`,
          `Imported ${items.length} armor pieces. The CSV contains equipped loadouts for multiple classes; choose a class before filling the loadout.`,
        ), "info");
      }
    } catch (error) {
      showImportMessage(l(
        "CSV 解析失败，请检查文件格式。",
        "CSV 解析失敗，請檢查檔案格式。",
        "Failed to parse the CSV file."
      ));
    }
  };
  reader.onerror = () => showImportMessage(l("读取文件失败。", "讀取檔案失敗。", "Failed to read the file."));
  reader.readAsText(file, "utf-8");
}

function updateImportOptions() {
  importTier5Only = document.getElementById("importTier5Only")?.checked !== false;
  importClassFilter = document.getElementById("importClass")?.value || "";
  invalidateOwnedPlanCache();
  if (!importClassFilter) {
    inventoryExoticSlotFilter = "";
    inventoryFixedExoticKey = "";
  } else if (inventoryExoticSlotFilter === 'classItem') {
    inventoryFixedExoticKey = getExoticClassItemKey(importClassFilter);
    const classSelect = document.getElementById('exoticClass');
    if (classSelect) classSelect.value = importClassFilter;
    document.getElementById('useExoticMode').checked = true;
    updateExoticPerkOptions();
    toggleExoticMode({ syncInventory: false, refreshInventory: false });
  }
  syncBungieTargetCharacter();
  renderUpgradeImportPanel();
}

function updateInventoryExoticSlot() {
  const previousSlot = inventoryExoticSlotFilter;
  inventoryExoticSlotFilter = document.getElementById("inventoryExoticSlotFilter")?.value || "";
  const useExoticMode = document.getElementById('useExoticMode');
  if (inventoryExoticSlotFilter === 'classItem' && importClassFilter) {
    inventoryFixedExoticKey = getExoticClassItemKey(importClassFilter);
    const classSelect = document.getElementById('exoticClass');
    if (classSelect) classSelect.value = importClassFilter;
    if (useExoticMode) useExoticMode.checked = true;
    updateExoticPerkOptions();
    toggleExoticMode({ syncInventory: false, refreshInventory: false });
    scheduleRealtimeRanges();
  } else {
    inventoryFixedExoticKey = "";
    if (previousSlot === 'classItem' && useExoticMode?.checked) {
      useExoticMode.checked = false;
      toggleExoticMode({ syncInventory: false, refreshInventory: false });
      scheduleRealtimeRanges();
    }
  }
  invalidateOwnedPlanCache();
  renderUpgradeImportPanel();
  saveCurrentDraft();
}

function updateInventorySolveOptions({ refreshPlans = true } = {}) {
  const slotSelect = document.getElementById("inventoryExoticSlotFilter");
  const nameSelect = document.getElementById("inventoryFixedExoticName");
  if (slotSelect) inventoryExoticSlotFilter = slotSelect.value || "";
  if (nameSelect) inventoryFixedExoticKey = nameSelect.value || "";
  invalidateOwnedPlanCache();
  const exoticClassItemMode = calculatorMode === 'solve' &&
    document.getElementById('useExoticMode')?.checked === true;
  if (slotSelect) slotSelect.disabled = exoticClassItemMode || !importClassFilter;
  if (nameSelect) nameSelect.disabled = exoticClassItemMode || !importClassFilter || !inventoryExoticSlotFilter || inventoryExoticSlotFilter === 'classItem';
  const hint = document.getElementById("inventorySolveOptionHint");
  if (hint) {
    hint.classList.toggle('is-class-item', exoticClassItemMode);
    const selected = getSelectedInventoryExotic();
    hint.textContent = exoticClassItemMode
      ? l(
        `已固定${getExoticClassItemName(importClassFilter || document.getElementById('exoticClass')?.value || 'hunter')}，并自动开启异域职业物品模式。`,
        `已固定${getExoticClassItemName(importClassFilter || document.getElementById('exoticClass')?.value || 'hunter')}，並自動開啟異域職業物品模式。`,
        `${getExoticClassItemName(importClassFilter || document.getElementById('exoticClass')?.value || 'hunter')} is fixed and Exotic Class Item mode is enabled automatically.`
      )
      : !importClassFilter
        ? l('请先选择职业，库存规划不会混用不同职业的护甲。', '請先選擇職業，庫存規劃不會混用不同職業的防具。', 'Choose a class first; inventory planning never mixes armor across classes.')
        : !selected && inventoryExoticSlotFilter && getFilteredInventoryExotics().length > 0
          ? l('已选择部位，请继续选择具体异域名称；同名多件会自动择优。', '已選擇部位，請繼續選擇具體異域名稱；同名多件會自動擇優。', 'Choose an Exotic name for this slot; same-name copies will be compared automatically.')
          : selected?.reserved
            ? l('此部位预留给尚未拥有的异域，不匹配已有传说或其他异域；方案会列出待获取的属性要求。', '此部位預留給尚未擁有的異域，不符合現有傳說或其他異域；方案會列出待取得的數值要求。', 'Reserve this slot for an unowned Exotic. Existing Legendary or other Exotic items will not fill it; the plan lists the roll to acquire.')
          : selected
            ? l(`已固定：${selected.name}（${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}）；会优先使用同名且属性最接近的已有件。`, `已固定：${selected.name}（${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}）；會優先使用同名且數值最接近的現有件。`, `Fixed: ${selected.name} (${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}); the closest owned copy is preferred.`)
            : getFilteredInventoryExotics().length === 0
              ? l('暂无已有异域；可选择部位和“任意异域”，为尚未拥有的异域预留位置。', '暫無現有異域；可選擇部位和「任意異域」，為尚未擁有的異域預留位置。', 'No owned Exotics. Choose a slot and Any Exotic to reserve it for an unowned item.')
              : l('可选。先选异域部位和名称；没有完全匹配时，结果会显示同名最接近的现有件以及建议刷取属性。', '可選。先選異域部位和名稱；沒有完全符合時，結果會顯示同名最接近的現有件以及建議取得數值。', 'Optional. Choose an Exotic slot and name. If no copy fully matches, the result shows the closest owned copy and the roll to farm.');
    // The sentence stays reachable as a tooltip; on wide screens the visible
    // line is elided to one caption row instead of a full-width paragraph.
    hint.title = hint.textContent;
  }
  saveUpgradeDraft();
  if (refreshPlans) refreshInventoryPlansFromSolutions();
}

function setImportClass(classId) {
  importClassFilter = classId || "";
  invalidateOwnedPlanCache();
  syncBungieTargetCharacter();
  const select = document.getElementById("importClass");
  if (select) select.value = importClassFilter;
  updateImportSummary();
}

function updateImportSummary() {
  const el = document.getElementById("upgradeImportSummary");
  if (!el) return;
  document.querySelectorAll("[data-import-dependent]").forEach(control => {
    control.disabled = importedInventory.length === 0;
  });
  const tierFiltered = filterArmorItems(importedInventory, {
    tier5Only: importTier5Only,
  });
  const filtered = importClassFilter
    ? tierFiltered.filter(item => item.classId === importClassFilter)
    : tierFiltered;
  const effectiveEl = document.getElementById("armorFilterCount");
  if (effectiveEl) {
    effectiveEl.textContent = l(
      `当前有效 ${filtered.length} 件`,
      `目前有效 ${filtered.length} 件`,
      `${filtered.length} effective`,
    );
  }
  if (importedInventory.length === 0) {
    el.innerHTML = `<div class="upgrade-import-empty">${icon("folder")}<span>${l(
      calculatorMode === "solve"
        ? "尚未导入已有护甲清单。导入后选择职业即可参与方案匹配。"
        : "尚未导入已有护甲清单。导入后可填入当前穿戴。",
      calculatorMode === "solve"
        ? "尚未匯入已有防具清單。匯入後選擇職業即可參與方案符合。"
        : "尚未匯入已有防具清單。匯入後可填入目前穿戴。",
      calculatorMode === "solve"
        ? "No owned-armor inventory imported. Import one and choose a class to match it against solutions."
        : "No owned-armor inventory imported. Import one to fill the equipped loadout."
    )}</span></div>`;
    return;
  }
  const countByClass = { hunter: 0, titan: 0, warlock: 0 };
  const setHashes = new Set();
  for (const item of tierFiltered) {
    if (item.classId in countByClass) countByClass[item.classId] += 1;
    if ((!importClassFilter || item.classId === importClassFilter) && item.setHash) {
      setHashes.add(item.setHash);
    }
  }
  const setCount = filtered.reduce((count, item) => count + (item.setHash ? 1 : 0), 0);
  const setTotal = setHashes.size;
  el.innerHTML = `<div class="upgrade-import-counts">${icon("check")}<span>${l(
    `已导入 ${importedInventory.length} 件护甲：猎人 ${countByClass.hunter} 件 · 泰坦 ${countByClass.titan} 件 · 术士 ${countByClass.warlock} 件；当前筛选 ${filtered.length} 件，其中 ${setCount} 件分属 ${setTotal} 个套装。`,
    `已匯入 ${importedInventory.length} 件防具：獵人 ${countByClass.hunter} 件 · 泰坦 ${countByClass.titan} 件 · 術士 ${countByClass.warlock} 件；目前篩選 ${filtered.length} 件，其中 ${setCount} 件分屬 ${setTotal} 個套裝。`,
    `Imported ${importedInventory.length} armor pieces: Hunter ${countByClass.hunter} / Titan ${countByClass.titan} / Warlock ${countByClass.warlock}; ${filtered.length} in the current filter, ${setCount} of them from ${setTotal} set(s).`
  )}</span></div>`;
}

function clearImportedInventory() {
  importedInventory = [];
  bungieSubclassFragments = null;
  inventoryImportExpanded = false;
  setRequirement = { type: "none" };
  manualLocked = [];
  inventoryExoticSlotFilter = "";
  inventoryFixedExoticKey = "";
  clearInventoryResults();
  updateImportOptions();
  renderSetEffects();
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function applyLoadoutItems(items) {
  const bySlot = {};
  for (const item of items) {
    if (item.slot && !bySlot[item.slot]) bySlot[item.slot] = item;
  }
  // A locked piece must survive a loadout refill. Capture which slots carried
  // a locked piece (and its instance/roll identity) before rebuilding; the
  // manualLocked reset below would otherwise silently drop the user's
  // "固定此件，不参与替换" and let the optimizer replace the piece — e.g. an
  // exotic class item swapped for another roll with different perks.
  const previousLocked = upgradeBuildState.map((piece, index) =>
    (piece?.locked || manualLocked[index]) ? piece : null
  );
  const missingSlots = [];
  upgradeBuildState = UPGRADE_SLOTS.map((slotDef, index) => {
    const item = bySlot[slotDef.id];
    if (!item) {
      missingSlots.push(getUpgradeSlotLabel(index));
      return normalizeUpgradePiece(upgradeBuildState[index], index);
    }
    return createUpgradePieceFromItem(item, index);
  });
  manualLocked = [];
  previousLocked.forEach((prevPiece, index) => {
    if (!prevPiece) return;
    const nextPiece = upgradeBuildState[index];
    if (!nextPiece) return;
    const sameInstance = Boolean(
      prevPiece.sourceId && nextPiece.sourceId && prevPiece.sourceId === nextPiece.sourceId
    );
    const sameExoticRoll = prevPiece.exotic && nextPiece.exotic
      && prevPiece.hash && prevPiece.hash === nextPiece.hash
      && (prevPiece.primaryPerkId || null) === (nextPiece.primaryPerkId || null)
      && (prevPiece.secondaryPerkId || null) === (nextPiece.secondaryPerkId || null);
    if (sameInstance || sameExoticRoll) manualLocked[index] = true;
  });
  syncUpgradeLocks();
  saveUpgradeDraft();
  renderUpgradeBuildEditor();
  renderSetEffects();
  if (missingSlots.length > 0) {
    showImportMessage(l(
      `有 ${missingSlots.length} 个槽位没有匹配到护甲（${missingSlots.join("、")}），已保留原值。`,
      `有 ${missingSlots.length} 個欄位未匹配到防具（${missingSlots.join("、")}），已保留原值。`,
      `${missingSlots.length} slot(s) had no matching armor (${missingSlots.join(", ")}); existing values kept.`
    ), "info");
  }
}

function applyEquippedLoadout() {
  if (importedInventory.length === 0) {
    showImportMessage(l(
      "请先导入护甲 CSV，再识别当前穿戴。",
      "請先匯入防具 CSV，再辨識目前穿戴。",
      "Import the armor CSV first."
    ));
    return;
  }
  if (!importClassFilter && !detectEquippedClass(importedInventory)) {
    showImportMessage(l(
      "CSV 中有多个职业的当前穿戴，请先选择一个职业。",
      "CSV 中有多個職業的目前穿戴，請先選擇一個職業。",
      "The CSV contains equipped loadouts for multiple classes. Choose one class first."
    ));
    return;
  }
  let candidates = filterArmorItems(importedInventory, {
    classId: importClassFilter || null,
    tier5Only: importTier5Only,
  });
  if (importSource === "bungie" && bungieTargetCharacterId) {
    candidates = candidates.filter(item => item.equipped && String(item.owner) === bungieTargetCharacterId);
  }
  const items = pickCurrentLoadout(candidates);
  if (!importClassFilter && items[0]?.classId) setImportClass(items[0].classId);
  applyLoadoutItems(items);
  // Bungie imports carry the subclass item's installed Aspects/Fragments:
  // fill the fragment steppers from the selected class's current subclass.
  const fragmentsApplied = applySubclassFragmentsToUI();
  // Auto-set the six-stat targets to Bungie's aggregate character stats when
  // available; CSV imports fall back to armor + fragment reconstruction.
  applyCurrentStatsToTargets({ useBungieCharacterStats: importSource === "bungie" });
  saveCurrentDraft();
  saveUpgradeDraft();
  showImportMessage(l(
    fragmentsApplied
      ? `已按当前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件护甲，并识别了当前星相/碎片的属性调整；六维目标已设为当前六维。`
      : `已按当前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件护甲；六维目标已设为当前六维。`,
    fragmentsApplied
      ? `已依目前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件防具，並辨識了目前相位/碎片的數值調整；六維目標已設為目前六維。`
      : `已依目前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件防具；六維目標已設為目前六維。`,
    fragmentsApplied
      ? `Filled ${items.length} armor pieces from the equipped loadout (${getClassLabel(importClassFilter)}), recognized the current Aspect/Fragment stat adjustments, and set the six-stat targets to the current stats.`
      : `Filled ${items.length} armor pieces from the equipped loadout (${getClassLabel(importClassFilter)}) and set the six-stat targets to the current stats.`
  ), "info");
}

// Fill the fragment steppers (fragVal_*) with the stat adjustments of the
// selected class's currently installed Aspects/Fragments (Bungie import only).
// Returns true when a Bungie fragment map was applied.
function applySubclassFragmentsToUI() {
  if (!importClassFilter) return false;
  const fragments = bungieProfileState?.currentSubclassByCharacter?.[bungieTargetCharacterId]?.adjustments
    || bungieSubclassFragments?.[importClassFilter];
  if (!fragments) return false;
  setFragmentAdjustmentsToUI(fragments);
  return true;
}

// Set the six-stat targets (target_*) to the current loadout's final stats.
// Bungie's character aggregate is authoritative for the equipped loadout and
// already includes armor, mods, tuning, subclass and fragment adjustments.
// CSV and saved-loadout editing retain the local reconstruction fallback.
function applyCurrentStatsToTargets({ useBungieCharacterStats = false } = {}) {
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const exactTotals = useBungieCharacterStats
    ? bungieProfileState?.characters?.[bungieTargetCharacterId]?.stats
    : null;
  const totals = resolveCurrentLoadoutTotals(
    upgradeBuildState,
    getUpgradeFragments(),
    exactTotals,
  );
  for (const stat of STATS) {
    const input = document.getElementById('target_' + stat);
    if (!input) continue;
    input.value = totals[stat];
    input.style.borderColor = totals[stat] !== 0 ? STAT_COLORS[stat] : 'var(--border)';
  }
  updateBudget();
  updateUpgradeBudgetSummary();
  scheduleRealtimeRanges();
}

function getClassLabel(classId) {
  if (classId === "hunter") return l("猎人", "獵人", "Hunter");
  if (classId === "titan") return l("泰坦", "泰坦", "Titan");
  if (classId === "warlock") return l("术士", "術士", "Warlock");
  return l("全部职业", "全部職業", "all classes");
}

// ============================================================
// SET BONUSES (2pc / 4pc) AND REQUIREMENT FILTER
// ============================================================

// Language key for trilingual data fields (armor-sets.data.mjs shape).
const SET_LANGUAGE_KEY = { "zh-chs": "zh", "zh-cht": "zhCht", en: "en" };

// Group every cataloged set by activity category in the canonical order
// (scripts/armor-sets-meta.json); categories missing from the order go last.
function orderSetsByCategory(sets, language) {
  const key = SET_LANGUAGE_KEY[language] || "zh";
  const byCategory = new Map();
  for (const set of sets) {
    const categoryZh = set?.category?.zh || "";
    if (!byCategory.has(categoryZh)) byCategory.set(categoryZh, []);
    byCategory.get(categoryZh).push(set);
  }
  const groups = [];
  const known = new Set();
  for (const category of ARMOR_SET_CATEGORY_ORDER || []) {
    const categoryZh = category?.zh || "";
    known.add(categoryZh);
    const list = byCategory.get(categoryZh);
    if (!list?.length) continue;
    list.sort((a, b) => getSetName(a, language).localeCompare(getSetName(b, language)));
    groups.push({
      label: category?.[key] || categoryZh || l("其他", "其他", "Other"),
      sets: list,
    });
  }
  const unknown = [...byCategory.entries()].filter(([categoryZh]) => !known.has(categoryZh));
  for (const [categoryZh, list] of unknown) {
    list.sort((a, b) => getSetName(a, language).localeCompare(getSetName(b, language)));
    groups.push({ label: categoryZh || l("其他", "其他", "Other"), sets: list });
  }
  return groups;
}

// The default (collapsed) answer to "which set am I requiring, and how close am
// I": one line naming the set, how many pieces are already owned and how many
// the requirement asks for. The 2pc/4pc bonus prose stays behind 查看套装效果.
function renderSetRequirementSummary(language, ownedSetCounts) {
  const requirement = setRequirement;
  if (!requirement || requirement.type === 'none') {
    return `<div class="set-requirement-summary is-empty">${l(
      '未要求套装', '未要求套裝', 'No set requirement')}</div>`;
  }
  const describe = (hash, count) => {
    const set = getArmorSetByHash(hash);
    if (!set) return '';
    const owned = ownedSetCounts.get(Number(hash)) || 0;
    return `<span class="set-summary-item"><strong>${escapeHtml(getSetName(set, language))}</strong>`
      + `<span>${l(`已拥有 ${owned} 件`, `已擁有 ${owned} 件`, `${owned} owned`)}</span>`
      + `<span>${l(`要求 ${count} 件`, `要求 ${count} 件`, `requires ${count}`)}</span></span>`;
  };
  const items = requirement.type === 'split'
    ? [describe(requirement.a, 2), describe(requirement.b, 2)].filter(Boolean)
    : [describe(requirement.setHash, requirement.count)].filter(Boolean);
  return `<div class="set-requirement-summary">${items.join('')}</div>`;
}

// 2pc/4pc bonus preview for the set(s) currently required by the constraint,
// with category / acquisition source / class naming notes from the metadata.
function renderSetRequirementPreview(language, ownedSetCounts) {
  const previewSets = [];
  if (setRequirement.type === "set" && setRequirement.setHash) {
    previewSets.push(getArmorSetByHash(setRequirement.setHash));
  } else if (setRequirement.type === "split") {
    previewSets.push(getArmorSetByHash(setRequirement.a));
    previewSets.push(getArmorSetByHash(setRequirement.b));
  }
  if (previewSets.length === 0) return "";
  const key = SET_LANGUAGE_KEY[language] || "zh";
  const isZh = language !== "en";
  return `<div class="set-requirement-preview">${previewSets.filter(Boolean).map(set => {
    const meta = getSetMeta(set);
    const owned = ownedSetCounts.get(set.hash) || 0;
    const head = `
      <div class="set-preview-head">
        <strong>${escapeHtml(getSetName(set, language))}</strong>
        ${meta.groupId ? `<span class="set-preview-id">${escapeHtml(meta.groupId)}</span>` : ""}
        ${owned > 0 ? `<span class="set-preview-owned">${l("已拥有", "已擁有", "owned")} ${owned} ${l("件", "件", "pc")}</span>` : ""}
      </div>`;
    const badges = [];
    if (meta.category) badges.push(escapeHtml(getSetCategoryName(set, language)));
    if (isZh && meta.source) badges.push(escapeHtml(meta.source));
    const badgesHtml = badges.length
      ? `<div class="set-preview-badges">${badges.map(text => `<span>${text}</span>`).join("")}</div>`
      : "";
    const bonusesHtml = set.bonuses.map(bonus => {
      const text = getSetBonusText(bonus, language);
      return `<div class="set-preview-bonus">
        <div class="set-preview-tier">${bonus.count} ${l("件套", "件套", "pc")}</div>
        <div class="set-preview-name">${escapeHtml(text.name)}</div>
        <p class="set-preview-desc">${escapeHtml(text.desc)}</p>
      </div>`;
    }).join("");
    const notesHtml = isZh && meta.classNotes?.length ? `
      <details class="set-preview-notes" data-disclosure-key="set-${set.hash}">
        <summary>${l("职业命名差异", "職業命名差異", "Class naming notes")}</summary>
        ${meta.classNotes.map(note => `
          <div class="set-preview-note">
            <strong>${escapeHtml(note.class?.[key] || note.class?.zh || "")}</strong>
            <span>${escapeHtml(note.family?.[key] || note.family?.zh || "")}</span>
            <p>${escapeHtml(note.note || "")}</p>
          </div>`).join("")}
      </details>` : "";
    return `<div class="set-preview-card">${head}${badgesHtml}${bonusesHtml}${notesHtml}</div>`;
  }).join("")}</div>`;
}

function renderSetEffects() {
  const el = document.getElementById("upgradeSetEffects");
  if (!el) return;
  const restoreDetails = preserveDisclosureState(el);
  const language = getPageLanguage();
  // Scratch mode has no current five-piece loadout. Do not leak the last
  // upgrade draft's active bonuses into the shared set picker.
  const currentHashes = calculatorMode === "upgrade"
    ? (upgradeBuildState || []).map(piece => piece?.hash).filter(Boolean)
    : [];
  const active = getActiveSetBonuses(currentHashes, language);
  // Owned pieces per set from the imported list, for the picker labels.
  const ownedSetCounts = new Map();
  for (const item of importedInventory) {
    if (importClassFilter && item?.classId === importClassFilter && item?.setHash) {
      ownedSetCounts.set(item.setHash, (ownedSetCounts.get(item.setHash) || 0) + 1);
    }
  }
  // The whole 56-set catalog is selectable (grouped by activity category),
  // not just sets that appear in the inventory: a scratch plan can target any
  // set, and a requirement whose pieces are missing marks what to farm.
  const groups = orderSetsByCategory(listArmorSets(), language);
  const noSets = groups.length === 0;
  // Build each picker from its own options so only the set that is actually
  // selected gets marked. Sharing one options list (marking both a and b
  // selected) made the browser show the first-selected option in BOTH selects,
  // silently resetting the second set on every re-render. The second picker
  // excludes the first one's set (a 2+2 split must use two different sets).
  const makeSetOptions = (selectedHash, excludeHash = 0) => {
    let html = "";
    for (const group of groups) {
      html += `<optgroup label="${escapeHtml(group.label)}">`;
      for (const set of group.sets) {
        if (excludeHash && set.hash === Number(excludeHash)) continue;
        const owned = ownedSetCounts.get(set.hash) || 0;
        const isSelected = Number(selectedHash) === set.hash;
        html += `<option value="${set.hash}" ${isSelected ? "selected" : ""}>${escapeHtml(getSetName(set, language))}${owned > 0 ? ` · ${l("已拥有", "已擁有", "owned")} ${owned}` : ""}</option>`;
      }
      html += "</optgroup>";
    }
    return html;
  };
  const firstSetHash = setRequirement.type === "set"
    ? setRequirement.setHash
    : setRequirement.type === "split"
      ? setRequirement.a
      : null;
  const secondSetHash = setRequirement.type === "split" ? setRequirement.b : null;
  const setOptions = makeSetOptions(firstSetHash);
  const secondSetOptions = makeSetOptions(secondSetHash, firstSetHash);
  const mode = setRequirement.type === "set" ? `set${setRequirement.count}` : setRequirement.type;
  // 2pc/4pc status is one compact line: the counter carries the number and the
  // explanatory sentence moves into its tooltip, so the panel no longer stacks
  // four full-width notes. Bonus cards only appear when one is actually active.
  const activePieces = active.reduce((max, bonus) => Math.max(max, bonus.pieceCount || 0), 0);
  const activeBadgeTitle = active.length > 0
    ? active.map(bonus => `${bonus.name} ${bonus.pieceCount}/5`).join(" · ")
    : l(
      "当前五件护甲没有激活任何护甲套装加成（2 件或 4 件）。",
      "目前五件防具沒有啟動任何防具套裝獎勵（2 件或 4 件）。",
      "No Armor Set Bonus (2pc/4pc) is active with the current five pieces.",
    );

  el.innerHTML = `
    <div class="set-requirement-head">
      <label class="set-req-mode">
        <span>${l("要求", "要求", "Require")}</span>
        <select id="setReqMode" onchange="updateSetRequirementMode(this.value)">
          <option value="none" ${mode === "none" ? "selected" : ""}>${l("不要求", "不要求", "None")}</option>
          <option value="set4" ${mode === "set4" ? "selected" : ""} ${noSets ? "disabled" : ""}>${l("指定套装 4 件套", "指定套裝 4 件套", "A set, 4-piece")}</option>
          <option value="set2" ${mode === "set2" ? "selected" : ""} ${noSets ? "disabled" : ""}>${l("指定套装 2 件套", "指定套裝 2 件套", "A set, 2-piece")}</option>
          <option value="split" ${mode === "split" ? "selected" : ""} ${noSets ? "disabled" : ""}>${l("两个套装各 2 件（2+2）", "兩個套裝各 2 件（2+2）", "Two sets, 2-piece each")}</option>
        </select>
      </label>
      <label class="set-req-set" id="setReqALabel" ${mode === "none" ? "hidden" : ""}>
        <span>${l("套装", "套裝", "Set")}</span>
        <select id="setReqA" onchange="updateSetRequirementPicks()">${setOptions}</select>
      </label>
      <label class="set-req-set" id="setReqBLabel" ${mode === "split" ? "" : "hidden"}>
        <span>${l("另一个套装", "另一個套裝", "Second set")}</span>
        <select id="setReqB" onchange="updateSetRequirementPicks()">${secondSetOptions}</select>
      </label>
    </div>
    <div class="set-status-row">
      ${renderSetRequirementSummary(language, ownedSetCounts)}
      ${calculatorMode === "upgrade" ? `<span class="set-active-badge ${active.length > 0 ? "is-active" : ""}" title="${escapeHtml(activeBadgeTitle)}">${l(
        `当前 ${activePieces}/5 激活`,
        `目前 ${activePieces}/5 啟動`,
        `${activePieces}/5 active`,
      )}</span>` : ""}
      <div class="set-requirement-state" id="setRequirementState" aria-live="polite"></div>
      <details class="set-effects-toggle" data-disclosure-key="set-effects">
        <summary>${l("查看套装效果", "檢視套裝獎勵", "View set bonuses")}</summary>
        ${renderSetRequirementPreview(language, ownedSetCounts)}
      </details>
    </div>
    ${calculatorMode === "upgrade" && active.length > 0 ? `<div class="set-active-list">${active.map(bonus => `
        <div class="set-active-card">
          <div class="set-active-head">
            <strong>${escapeHtml(getSetName(bonus.set))}</strong>
            <span class="set-active-count">${bonus.pieceCount}/${5}</span>
            <span class="set-active-tier">${bonus.requiredCount} ${l("件套", "件套", "pc")}</span>
          </div>
          <div class="set-active-name">${escapeHtml(bonus.name)}</div>
          <p class="set-active-desc">${escapeHtml(bonus.desc)}</p>
        </div>`).join("")}</div>` : ""}
  `;
  syncUpgradeLocks();
  restoreDetails();
  updateAdvancedConstraintsSummary();
}

function updateSetRequirementMode(value) {
  clearInventoryResults();
  const a = Number(document.getElementById("setReqA")?.value) || 0;
  const b = Number(document.getElementById("setReqB")?.value) || a;
  if (value === "none") {
    setRequirement = { type: "none" };
  } else if (value === "set2" || value === "set4") {
    setRequirement = { type: "set", setHash: a, count: value === "set4" ? 4 : 2 };
  } else if (value === "split") {
    const aSelect = document.getElementById("setReqA");
    const bSelect = document.getElementById("setReqB");
    const aValue = Number(aSelect?.value) || a;
    let bValue = Number(bSelect?.value) || b;
    if (bSelect && bValue === aValue && bSelect.options.length > 1) {
      const alternate = [...bSelect.options].findIndex(option => Number(option.value) !== aValue);
      if (alternate >= 0) {
        bSelect.selectedIndex = alternate;
        bValue = Number(bSelect.value);
      }
    }
    setRequirement = { type: "split", a: aValue, b: bValue };
  }
  invalidateOwnedPlanCache();
  // The replacement plan is stat-only and unaffected by the set selection, so
  // it stays valid; only the owned-armor results are invalidated above.
  renderSetEffects();
  renderUpgradeBuildEditor();
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function updateSetRequirementPicks() {
  updateSetRequirementMode(document.getElementById("setReqMode")?.value || "none");
}

function syncUpgradeLocks() {
  // Only Exotic armor (unique, cannot be farmed) and pieces the player locked
  // manually stay fixed. A set requirement must NOT lock the current pieces:
  // solving filters the uploaded inventory for loadouts that satisfy the set
  // bonus while approaching the stat targets, which requires every non-fixed
  // slot to stay swappable. Locked stays monotonic: once a piece is fixed it
  // is never silently unlocked by a re-render — only updateUpgradePiece(…,
  // 'locked', false) releases it.
  (upgradeBuildState || []).forEach((piece, index) => {
    piece.locked = Boolean(piece.locked) || Boolean(piece.exotic) || Boolean(manualLocked[index]);
  });
  const stateEl = document.getElementById("setRequirementState");
  if (!stateEl) return;
  const requirement = setRequirement;
  if (!requirement || requirement.type === "none") {
    stateEl.innerHTML = "";
    return;
  }
  // The requirement is enforced by the inventory solve, which searches the
  // imported list for a loadout that satisfies it, so this status line is a
  // neutral note rather than a count of the current five pieces.
  stateEl.innerHTML = `<div class="set-requirement-ok">${icon("check")}${l(
    "求解时会从清单中搜索满足要求的组合。",
    "求解時會從清單中搜尋滿足要求的組合。",
    "Solving will search the list for a loadout that satisfies it."
  )}</div>`;
}

function getUpgradeSlotLabel(slotIndex) {
  const labels = UPGRADE_SLOTS[slotIndex]?.labels || UPGRADE_SLOTS[0].labels;
  return l(labels[0], labels[1], labels[2]);
}


function updateUpgradeTuningChoice(index, value) {
  if (value === 'plus3') {
    updateUpgradePiece(index, 'tuningMode', 'plus3', true);
    return;
  }
  const [, tuningTo] = String(value).split(':');
  updateUpgradePiece(index, 'tuningMode', 'shift');
  const tunedStat = STATS.includes(tuningTo) ? tuningTo : STATS[0];
  updateUpgradePiece(index, 'tunedStat', tunedStat);
  updateUpgradePiece(index, 'tuningTo', tunedStat, true);
}

function renderUpgradeBuildEditor(openIndex = null) {
  const editor = document.getElementById('upgradeBuildEditor');
  if (!editor) return;
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) {
    upgradeBuildState = UPGRADE_SLOTS.map((_, index) => normalizeUpgradePiece(upgradeBuildState[index], index));
  }
  // Exactly one piece may be open at a time. Reading the current open row from
  // the DOM (instead of a JS flag) keeps the disclosure honest across the many
  // re-render paths, and the default is "all five collapsed" — five summaries —
  // so the card stays short until the reader asks for an editor.
  const currentlyOpen = openIndex === null
    ? [...editor.querySelectorAll('.upgrade-piece-row[open]')].map(row => Number(row.dataset.index))
    : [openIndex];

  editor.innerHTML = `<div class="upgrade-piece-list">${upgradeBuildState.map((piece, index) => {
    const archetype = ARCHETYPES.find(item => item.id === piece.archetypeId) || ARCHETYPES[0];
    const tertiaryOptions = STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
    const tuning = piece.tuningMode === 'plus3'
      ? l('调整 +3', '調校 +3', 'Tuning +3')
      : l(
          `调整 -5${STAT_LABELS[piece.tuningFrom]} / +5${STAT_LABELS[piece.tuningTo]}`,
          `調校 -5${STAT_LABELS[piece.tuningFrom]} / +5${STAT_LABELS[piece.tuningTo]}`,
          `Tuning -5 ${STAT_LABELS[piece.tuningFrom]} / +5 ${STAT_LABELS[piece.tuningTo]}`
        );
    const armorMod = piece.armorModSize > 0
      ? l(
          `模组 +${piece.armorModSize}${STAT_LABELS[piece.armorModStat]}`,
          `模組 +${piece.armorModSize}${STAT_LABELS[piece.armorModStat]}`,
          `Mod +${piece.armorModSize} ${STAT_LABELS[piece.armorModStat]}`
        )
      : l('无属性模组', '無數值模組', 'No stat mod');
    const setForPiece = piece.setHash ? getArmorSetByHash(piece.setHash) : null;
    const pieceNameLabel = piece.itemName
      ? `<span class="upgrade-piece-name">${escapeHtml(piece.itemName)}</span>`
      : '';
    const setLabel = setForPiece
      ? `<span class="upgrade-set-badge">${escapeHtml(getSetName(setForPiece))}</span>`
      : '';
    const perkIds = [piece.primaryPerkId, piece.secondaryPerkId].filter(Boolean);
    const perkLabel = perkIds.length > 0
      ? `<span class="upgrade-piece-perks">${perkIds.map(id => escapeHtml(getExoticPerkName(id, id))).join(' + ')}</span>`
      : '';
    // Five cells instead of one run-on sentence: a 1500px row used to hold a
    // single left-aligned string and leave the right half empty. Wide screens
    // lay these out as name | archetype | tertiary | tuning | mod; narrow
    // screens fall back to the same sentence, separated by CSS.
    const identity = [
      `<span class="upgrade-piece-name-cell">${[pieceNameLabel, setLabel, perkLabel].filter(Boolean).join(' · ')}</span>`,
      `<span class="upgrade-piece-arch">${getArchetypeLabel(archetype.id)}</span>`,
      `<span class="upgrade-piece-tertiary">${t('tertiaryStat')} ${STAT_LABELS[piece.tertiary]}</span>`,
      `<span class="upgrade-piece-tuning">${tuning}</span>`,
      `<span class="upgrade-piece-mod">${armorMod}</span>`,
    ].join('');
    const status = piece.exotic
      ? l('异域固定件','異域固定件','Fixed Exotic')
      : (piece.locked ? l('固定不替换','固定不替換','Fixed') : l('可替换','可替換','Replaceable'));
    const statusIcon = piece.locked
      ? `<span class="upgrade-piece-status-icon" aria-hidden="true">${icon('lock', { size:'sm' })}</span>`
      : '';
    const isOpen = currentlyOpen.includes(index);
    return `<details class="upgrade-piece-row" data-index="${index}" ${isOpen ? 'open' : ''}>
      <summary>
        <span class="upgrade-piece-slot">${getUpgradeSlotLabel(index)}</span>
        <span class="upgrade-piece-identity">${identity}</span>
        <span class="upgrade-piece-status ${piece.locked ? 'is-locked' : ''}">${statusIcon}<span>${status}</span></span>
      </summary>
      <div class="upgrade-piece-fields">
        <label class="input-group field-archetype">
          <span>${t('armorArchetype')}</span>
          <select onchange="updateUpgradePiece(${index},'archetypeId',this.value,true)">
            ${ARCHETYPES.map(item => `<option value="${item.id}" ${item.id === piece.archetypeId ? 'selected' : ''}>${getArchetypeLabel(item.id)}</option>`).join('')}
          </select>
        </label>
        <label class="input-group field-tertiary">
          <span>${t('tertiaryStat')}</span>
          <select onchange="updateUpgradePiece(${index},'tertiary',this.value)">
            ${tertiaryOptions.map(stat => `<option value="${stat}" ${stat === piece.tertiary ? 'selected' : ''}>${STAT_LABELS[stat]}</option>`).join('')}
          </select>
        </label>
        <label class="input-group field-mod-size">
          <span>${t('armorMod')}</span>
          <select onchange="updateUpgradePiece(${index},'armorModSize',Number(this.value),true)">
            <option value="0" ${piece.armorModSize === 0 ? 'selected' : ''}>${t('none')}</option>
            <option value="5" ${piece.armorModSize === 5 ? 'selected' : ''}>+5</option>
            <option value="10" ${piece.armorModSize === 10 ? 'selected' : ''}>+10</option>
          </select>
        </label>
        <label class="input-group field-tuning">
          <span>${t('tuningMod')}</span>
          <select onchange="updateUpgradeTuningChoice(${index},this.value)">
            <option value="plus3" ${piece.tuningMode === 'plus3' ? 'selected' : ''}>+3</option>
            ${STATS.map(stat => `<option value="plus5:${stat}" ${piece.tuningMode !== 'plus3' && piece.tuningTo === stat ? 'selected' : ''}>+5 ${STAT_LABELS[stat]}</option>`).join('')}
          </select>
        </label>
        ${piece.tuningMode === 'shift' ? `
        <label class="input-group field-tuning-from">
          <span>${l('调整来源（-5，可自选）','調校來源（-5，可自選）','Tuning source (-5, your pick)')}</span>
          <select onchange="updateUpgradePiece(${index},'tuningFrom',this.value,true)">
            ${getUpgradeStatOptions(piece.tuningFrom, piece.tuningTo)}
          </select>
        </label>` : ''}
        <label class="input-group field-mod-stat">
          <span>${l('模组属性','模組數值','Mod stat')}</span>
          <select ${piece.armorModSize === 0 ? 'disabled' : ''} onchange="updateUpgradePiece(${index},'armorModStat',this.value,true)">
            ${getUpgradeStatOptions(piece.armorModStat)}
          </select>
        </label>
        <div class="upgrade-piece-flags">
          <label>
            <input type="checkbox" ${piece.exotic ? 'checked' : ''} onchange="updateUpgradePiece(${index},'exotic',this.checked,true)">
            <span>${l('异域/必须保留','異域/必須保留','Exotic / must keep')}</span>
          </label>
          <label>
            <input type="checkbox" ${piece.locked ? 'checked' : ''} ${piece.exotic ? 'disabled' : ''} onchange="updateUpgradePiece(${index},'locked',this.checked,true)">
            <span>${l('固定此件，不参与替换','固定此件，不參與替換','Fix this piece; do not replace')}</span>
          </label>
        </div>
      </div>
    </details>`;
  }).join('')}</div>`;
  updateUpgradeBudgetSummary();
}

// Batch lock actions. Exotic pieces stay locked (they cannot be farmed), so
// "all replaceable" only releases the manual locks and the legendary locks —
// it never claims an Exotic can be swapped out.
function setAllUpgradeLocked(locked) {
  upgradeBuildState.forEach((piece, index) => {
    if (!piece) return;
    if (!locked && piece.exotic) return;
    manualLocked[index] = Boolean(locked);
    piece.locked = Boolean(locked) || Boolean(piece.exotic);
  });
  syncUpgradeLocks();
  saveUpgradeDraft();
  renderUpgradeBuildEditor();
  refreshInventoryPlansFromSolutions();
}

let upgradeDragIndex = null;
function handleUpgradeDragStart(event, index) {
  upgradeDragIndex = index;
  event.currentTarget.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
}
function handleUpgradeDragEnd(event) {
  event.currentTarget.classList.remove('is-dragging');
  upgradeDragIndex = null;
}
function handleUpgradeDrop(event, targetIndex) {
  event.preventDefault();
  const sourceIndex = upgradeDragIndex ?? Number(event.dataTransfer.getData('text/plain'));
  if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex) return;
  [upgradeBuildState[sourceIndex], upgradeBuildState[targetIndex]] = [upgradeBuildState[targetIndex], upgradeBuildState[sourceIndex]];
  upgradeBuildState = upgradeBuildState.map((piece, index) => normalizeUpgradePiece(piece, index));
  saveUpgradeDraft();
  renderUpgradeBuildEditor(targetIndex);
}

function updateUpgradePiece(index, field, value, rerender = false) {
  if (!upgradeBuildState[index]) return;
  if (upgradeBuildState[index].sourceId && ['archetypeId', 'tertiary', 'tunedStat', 'exotic'].includes(field)
      && upgradeBuildState[index][field] !== value) {
    // Editing a roll creates a hypothetical replacement, not a changed instance.
    for (const key of ['sourceId', 'hash', 'baseStats', 'physicalBaseStats', 'optimizationBaseStats',
      'requiresMasterwork', 'sockets', 'energy', 'dataConfidence', 'tuningInstalled']) delete upgradeBuildState[index][key];
  }
  upgradeBuildState[index][field] = value;
  if (field === 'locked') manualLocked[index] = Boolean(value);
  upgradeBuildState[index] = normalizeUpgradePiece(upgradeBuildState[index], index);
  if (field === 'locked') syncUpgradeLocks();
  saveUpgradeDraft();
  if (rerender || field === 'tertiary') renderUpgradeBuildEditor(index);
  else updateUpgradeBudgetSummary();
}

function updateUpgradeOption() {
  saveUpgradeDraft();
  updateUpgradeBudgetSummary();
}

function getUpgradeFragments() {
  return Object.fromEntries(STATS.map(stat => [stat, getFragVal(stat)]));
}

function getUpgradeTargets() {
  return Object.fromEntries(STATS.map(stat => [stat, getVal('target_' + stat)]));
}

function getUpgradeRequiredStats() {
  return STATS.filter(stat =>
    document.getElementById('upgradeRequired_' + stat)?.checked
  );
}

function updateUpgradeRequiredStat(stat, required) {
  if (!STATS.includes(stat)) return;
  const selected = new Set(upgradeRequiredStats);
  if (required) selected.add(stat);
  else selected.delete(stat);
  upgradeRequiredStats = STATS.filter(item => selected.has(item));
  saveUpgradeDraft();
}


function updateUpgradeLiveSummary() {
  const summary = document.getElementById('upgradeLiveSummary');
  if (!summary || upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const totals = finalizeUpgradeTotals(getManualUpgradeArmorTotals(upgradeBuildState), getUpgradeFragments());
  const total = STATS.reduce((sum, stat) => sum + totals[stat], 0);
  summary.innerHTML = `
    <div class="upgrade-live-heading">
      <span class="upgrade-live-title">${l('当前六维','目前六維','Current Stats')}</span>
      <span class="upgrade-live-total">${l('已含碎片 · 总属性','已含碎片 · 總數值','Includes Fragments · Total')} <strong>${total}</strong></span>
    </div>
    <div class="upgrade-live-stats" role="list">
      ${STATS.map(stat => `
        <div class="upgrade-live-stat" role="listitem" aria-label="${STAT_LABELS[stat]} ${totals[stat]}">
          <span class="upgrade-live-stat-label" style="color:${STAT_COLORS[stat]}">${icon(stat)}<span>${STAT_LABELS[stat]}</span></span>
          <output>${totals[stat]}</output>
        </div>
      `).join('')}
    </div>`;
}

function updateUpgradeTargetBudget() {
  const summary = document.getElementById('upgradeTargetBudget');
  if (!summary || upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const modifiers = getUpgradeModifierBudget(upgradeBuildState);
  const modifierPoints = modifiers.numPlus3 * 3 + modifiers.numPlus5 * 5 + modifiers.numPlus10 * 10;
  const availableBudget = 450 + modifierPoints;
  const { targetSum, armorNeeded } = getTargetBudgetUsage(availableBudget);
  const remaining = availableBudget - armorNeeded;
  const tone = remaining < 0 ? 'health' : (remaining > 0 ? 'warning' : 'success');
  const mark = remaining < 0 ? 'block' : (remaining > 0 ? 'warn' : 'check');
  const deltaLabel = remaining < 0
    ? l(`超出 ${-remaining} 点`, `超出 ${-remaining} 點`, `${-remaining} points over`)
    : (remaining > 0
        ? l(`剩余 ${remaining} 点可分配`, `剩餘 ${remaining} 點可分配`, `${remaining} points available`)
        : l('刚好用完', '剛好用完', 'Fully allocated'));
  const guidance = l(
    `目标合计 ${targetSum}，碎片修正后需 ${armorNeeded}；基础 450 + 当前调整/模组 ${modifierPoints}`,
    `目標合計 ${targetSum}，碎片修正後需 ${armorNeeded}；基礎 450 + 目前調校/模組 ${modifierPoints}`,
    `Targets total ${targetSum}; ${armorNeeded} needed after Fragments. 450 base + ${modifierPoints} from current tuning/mods.`
  );

  summary.dataset.available = String(availableBudget);
  summary.dataset.required = String(armorNeeded);
  summary.dataset.remaining = String(remaining);
  summary.innerHTML = `<div class="budget-balance is-${tone}">`
    + `${icon(mark)}<div class="budget-balance-content">`
    + `<div class="budget-balance-head"><div class="budget-equation">`
    + `<span>${l('目标需求', '目標需求', 'Target need')}</span><strong>${armorNeeded}</strong>`
    + `<span class="budget-equation-arrow" aria-hidden="true">→</span>`
    + `<span>${l('可用预算', '可用預算', 'Available budget')}</span><strong>${availableBudget}</strong>`
    + `</div><span class="budget-delta">${deltaLabel}</span></div>`
    + `<div class="budget-balance-foot"><span class="budget-guidance">${guidance}</span></div>`
    + `</div></div>`;
}

function updateUpgradeBudgetSummary() {
  const summary = document.getElementById('upgradeBudgetSummary');
  if (!summary || upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const budget = getUpgradeModifierBudget(upgradeBuildState);
  updateUpgradeLiveSummary();
  updateUpgradeTargetBudget();
  const currentBudget = l(
    `现在用了：<strong>${budget.numPlus3}</strong> 件 +3 · <strong>${budget.numPlus5}</strong> 个 +5 · <strong>${budget.numPlus10}</strong> 个 +10`,
    `目前用了：<strong>${budget.numPlus3}</strong> 件 +3 · <strong>${budget.numPlus5}</strong> 個 +5 · <strong>${budget.numPlus10}</strong> 個 +10`,
    `In use: <strong>${budget.numPlus3}</strong> × +3 · <strong>${budget.numPlus5}</strong> × +5 · <strong>${budget.numPlus10}</strong> × +10`
  );
  const onlyPlus5 = document.getElementById('upgradeOnlyPlus5')?.checked === true;
  const restriction = onlyPlus5 && budget.numPlus3 > 0
    ? `<small>${l(
      `当前装备记录中仍有 ${budget.numPlus3} 件 +3；求解和已有护甲方案会把它们重新配置为 +5/-5，最终方案不会使用 +3。`,
      `目前裝備記錄中仍有 ${budget.numPlus3} 件 +3；求解和已有防具方案會把它們重新配置為 +5/-5，最終方案不會使用 +3。`,
      `${budget.numPlus3} currently equipped piece(s) still show +3; solved and owned-armor loadouts reconfigure them to +5/-5, so the final setup contains no +3.`
    )}</small>`
    : '';
  summary.innerHTML = currentBudget + restriction;
}

function saveUpgradeDraft() {
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  buildRepository.writeUpgradeDraft({
    pieces: upgradeBuildState,
    requiredStats: getUpgradeRequiredStats(),
    reassignModifiers: document.getElementById('upgradeReassignModifiers')?.checked ?? true,
    onlyPlus5Tuning: document.getElementById('upgradeOnlyPlus5')?.checked === true,
    setRequirement,
    exoticSlotFilter: inventoryExoticSlotFilter,
    fixedExoticKey: inventoryFixedExoticKey,
    manualLocked,
    importClassFilter,
    importTier5Only,
    inventory: importedInventory,
    manualOwnedItems,
    inventoryImportExpanded,
  });
}

function loadUpgradeDraft() {
  const draft = buildRepository.readUpgradeDraft();
  upgradeRequiredStats = Array.isArray(draft?.requiredStats)
    ? STATS.filter(stat => draft.requiredStats.includes(stat))
    : [];
  upgradeBuildState = UPGRADE_SLOTS.map((_, index) => normalizeUpgradePiece(draft?.pieces?.[index], index));
  setRequirement = draft?.setRequirement?.type ? draft.setRequirement : { type: 'none' };
  inventoryExoticSlotFilter = EXOTIC_SLOT_ORDER.includes(draft?.exoticSlotFilter)
    ? draft.exoticSlotFilter
    : (['helmet', 'arms', 'chest', 'legs'].includes(draft?.fixedExoticSlot) ? draft.fixedExoticSlot : '');
  inventoryFixedExoticKey = typeof draft?.fixedExoticKey === 'string' ? draft.fixedExoticKey : '';
  manualLocked = Array.isArray(draft?.manualLocked) ? draft.manualLocked : [];
  importClassFilter = draft?.importClassFilter || '';
  importTier5Only = draft?.importTier5Only !== false;
  importedInventory = Array.isArray(draft?.inventory) ? draft.inventory : [];
  manualOwnedItems = Array.isArray(draft?.manualOwnedItems)
    ? draft.manualOwnedItems.filter(item => item?.manualOwned && UPGRADE_SLOTS.some(slot => slot.id === item.slot))
    : [];
  manualOwnedSequence = manualOwnedItems.length;
  inventoryImportExpanded = importedInventory.length > 0 && draft?.inventoryImportExpanded !== false;
  invalidateOwnedPlanCache();
  const reassign = document.getElementById('upgradeReassignModifiers');
  if (reassign) reassign.checked = draft?.reassignModifiers !== false;
  const upgradeOnlyPlus5 = document.getElementById('upgradeOnlyPlus5');
  if (upgradeOnlyPlus5) upgradeOnlyPlus5.checked = draft?.onlyPlus5Tuning === true;
  for (const stat of STATS) {
    const control = document.getElementById('upgradeRequired_' + stat);
    if (control) control.checked = upgradeRequiredStats.includes(stat);
  }
  syncUpgradeLocks();
  renderUpgradeBuildEditor();
}

function setCalculatorMode(mode, persist = true) {
  stopSearches();
  calculatorMode = mode === 'upgrade' ? 'upgrade' : 'solve';
  const isUpgrade = calculatorMode === 'upgrade';
  document.body.classList.toggle('is-upgrade-mode', isUpgrade);
  document.getElementById('modeSolveButton')?.setAttribute('aria-pressed', String(!isUpgrade));
  document.getElementById('modeUpgradeButton')?.setAttribute('aria-pressed', String(isUpgrade));
  document.getElementById('upgradeBuildCard').hidden = !isUpgrade;
  document.getElementById('inventoryImportCard').hidden = false;
  document.getElementById('btnSolve').hidden = isUpgrade;
  document.getElementById('btnUpgradeAnalyze').hidden = !isUpgrade;
  document.getElementById('saveBuildButton').hidden = isUpgrade;
  document.getElementById('upgradeResults').hidden = !isUpgrade || !lastUpgradeAnalysis;
  // The unified plan panel is rebuilt by the next solve/selection render, which
  // now also covers theoretical skeletons that need farming.
  document.getElementById('inventoryResults').hidden = true;
  document.getElementById('floatJump').style.display = 'none';
  document.getElementById('messages').innerHTML = '';
  if (isUpgrade) {
    clearTimeout(realtimeRangeTimer);
    resetRealtimeRangeUI();
    toggleExoticMode();
    document.getElementById('results').classList.remove('show');
    updateUpgradeBudgetSummary();
  } else {
    toggleExoticMode();
    scheduleRealtimeRanges();
  }
  // Saved plans are a global tool: the entry stays in the header in both modes,
  // so only its list needs refreshing.
  renderSavedBuilds();
  // The shared DIM panel serves both modes; refresh its copy and controls so
  // switching modes never leaves upgrade-only instructions in scratch mode
  // (or vice versa), while the imported inventory state remains intact.
  renderUpgradeImportPanel();
  if (persist) {
    buildRepository.writeCalculatorMode(calculatorMode);
  }
}

function initializeUpgradeOptimizer() {
  loadUpgradeDraft();
  renderUpgradeImportPanel();
  setCalculatorMode(buildRepository.readCalculatorMode(), false);
}


function formatUpgradeTuning(assignment) {
  if (!assignment) return l('未知调整', '未知調校', 'Unknown Tuning');
  if (assignment.mode === 'none') return t('none');
  if (assignment.mode === '+3') return '+3';
  const from = STAT_LABELS[assignment.from];
  const to = STAT_LABELS[assignment.to];
  return l(`-5${from}/+5${to}`, `-5${from}/+5${to}`, `-5 ${from} / +5 ${to}`);
}

function formatUpgradeArmorMod(assignment) {
  return assignment ? `+${assignment.size} ${STAT_LABELS[assignment.stat]}` : t('none');
}

function formatUpgradeConfigSummary(config) {
  const separator = l('：', '：', ': ');
  return `${getArchetypeLabel(config.archetype)} · ${l('第三', '第三', 'Tertiary')}${separator}${STAT_LABELS[config.tertiary]}`;
}

// The rolled +5 stat is part of the piece, so a swap description has to name it —
// otherwise a "+5 stat only" replacement looks like no change at all.
function formatUpgradePieceSummary(piece) {
  const config = getUpgradeConfig(piece);
  const roll = piece.exotic
    ? l('异域可选调整', '異域可選調校', 'Exotic flexible Tuning')
    : l(
      `固有 +5${STAT_LABELS[piece.tunedStat || piece.tuningTo]}`,
      `固有 +5${STAT_LABELS[piece.tunedStat || piece.tuningTo]}`,
      `Intrinsic +5 ${STAT_LABELS[piece.tunedStat || piece.tuningTo]}`,
    );
  return `${formatUpgradeConfigSummary(config)} · ${roll}`;
}

// Rule-aware "how far from target" copy for a stat that is NOT satisfied.
// 至多/区间 exceeding the cap is "over the cap"; being below an 至少 floor is
// "short"; 精确 is the absolute distance. Returns '' when the stat is met.
function upgradeStatShortText(stat, evaluation) {
  const result = evaluation?.certificate?.statResults?.[stat];
  if (!result) return l('未验证','未驗證','Unverified');
  if (result.above) return l(`超上限 ${result.above}`, `超上限 ${result.above}`, `${result.above} over cap`);
  if (result.below) return l(`差 ${result.below}`, `差 ${result.below}`, `${result.below} short`);
  return '';
}

function buildUpgradeStatComparison(analysis, afterTotals) {
  const evaluation = analysis.plan?.evaluation?.finalTotals === afterTotals ? analysis.plan.evaluation : analysis.baseline;
  const targets = analysis.targets || {};
  return `<div class="upgrade-stat-comparison">${STATS.map(stat => {
    const before = (analysis.enteredBaseline || analysis.baseline).finalTotals[stat];
    const after = afterTotals[stat];
    const delta = after - before;
    const target = targets[stat];
    const isRequired = analysis.requiredStats?.includes(stat) === true;
    const targetReached = evaluation?.certificate?.statResults?.[stat]?.met === true;
    const shortText = targetReached ? '' : upgradeStatShortText(stat, evaluation);
    const deltaClass = targetReached ? 'is-target-met' : 'is-shortfall';
    const targetStatus = targetReached
      ? l('达标','達標','met')
      : shortText;
    return `<div class="upgrade-stat ${isRequired ? 'is-required' : ''}">
      <div class="upgrade-stat-label" style="color:${STAT_COLORS[stat]}"><span>${icon(stat)}${STAT_LABELS[stat]}</span>${isRequired
        ? `<em>${l('必须达标','必須達標','Must meet')}</em>` : ''}</div>
      <div class="upgrade-stat-values">${before} <small>→</small> ${after}</div>
      <span class="upgrade-stat-delta ${deltaClass}">${delta > 0 ? '+' : ''}${delta} · ${l('目标','目標','target')} ${target} · ${targetStatus}</span>
    </div>`;
  }).join('')}</div>`;
}

function buildUpgradeRequirementResult(analysis, evaluation) {
  const requiredStats = analysis.requiredStats || [];
  if (requiredStats.length === 0 || !evaluation) return '';
  const metrics = evaluation.metrics;
  const details = requiredStats.map(stat => {
    const actual = evaluation.finalTotals[stat];
    const target = analysis.targets[stat];
    return `${STAT_LABELS[stat]} ${actual}/${target}`;
  }).join(l(' · ', ' · ', ' · '));
  const met = requiredStats.every(stat => evaluation.certificate?.statResults?.[stat]?.met === true);
  return `<div class="upgrade-requirement-result ${met ? 'is-met' : 'is-unmet'}">
    ${icon(met ? 'check' : 'warn')}
    <div><strong>${met
      ? l('必须达标的属性已全部满足','必須達標的數值已全部滿足','All must-meet stats are satisfied')
      : l(`必须达标的属性还差 ${metrics.requiredShortfall} 点`, `必須達標的數值還差 ${metrics.requiredShortfall} 點`, `Must-meet stats are ${metrics.requiredShortfall} points short`)}</strong>
      <span>${details}</span></div>
  </div>`;
}

function buildUpgradeBaselineNote(analysis, keepOnly = false) {
  if (!analysis.enteredBaseline) return '';
  const projectedCount = analysis.projectedMasterworkIndices?.length || 0;
  const changedStats = STATS.filter(stat =>
    analysis.enteredBaseline.finalTotals[stat] !== analysis.baseline.finalTotals[stat]
  );
  if (changedStats.length === 0 && projectedCount === 0) return '';
  const explanation = projectedCount > 0
    ? (keepOnly
      ? l(
        `左侧为当前六维；右侧按 ${projectedCount} 件尚未完成大师杰作的护甲完成大师杰作后，再保留五件并重排调整与模组计算。完成大师杰作不计作刷取新护甲。`,
        `左側為目前六維；右側按 ${projectedCount} 件尚未完成大師之作的防具完成大師之作後，再保留五件並重排調校與模組計算。完成大師之作不計作取得新防具。`,
        `Left shows current stats. Right projects ${projectedCount} not-yet-fully-masterworked piece(s) to full masterwork, then keeps all five and rearranges tuning/mods. Masterworking is not counted as farming a replacement.`
      )
      : l(
        `左侧为当前六维；右侧的替换方案按所有保留护甲完成大师杰作后的属性计算。共有 ${projectedCount} 件现有护甲需要完成大师杰作，但不计作刷取替换件。`,
        `左側為目前六維；右側的替換方案按所有保留防具完成大師之作後的數值計算。共有 ${projectedCount} 件目前防具需要完成大師之作，但不計作取得替換件。`,
        `Left shows current stats. The replacement result projects every retained piece to full masterwork. ${projectedCount} current piece(s) need masterworking, but are not counted as farmed replacements.`
      ))
    : (keepOnly
      ? l(
        '左侧为当前六维，右侧为保留现有护甲、只重排调整与模组后的六维。',
        '左側為目前六維，右側為保留目前防具、只重排調校與模組後的六維。',
        'Left shows current stats; right shows the result after keeping every piece and rearranging only tuning sources and mods.'
      )
      : l(
        '左侧为当前六维，右侧为替换并重配模组后的六维。',
        '左側為目前六維，右側為替換並重配模組後的六維。',
        'Left shows current stats; right shows the result after swaps and mod changes.'
      ));
  return `<div class="upgrade-baseline-note">
    ${icon('refresh', { size:'sm' })}
    <span><strong>${l('数值说明：','數值說明：','Stats:')}</strong>${l('', '', ' ')}${explanation}</span>
  </div>`;
}

function formatUpgradeTotals(totals) {
  return STATS.map(stat => `<span>${STAT_LABELS[stat]} ${totals[stat]}</span>`).join('');
}

function buildUpgradePlanFlow(analysis, plan) {
  if (!plan?.steps?.length) return '';
  const reached = certifiedFeasible(plan.evaluation);
  const kept = 5 - plan.replacementCount;
  return `<section class="upgrade-plan-flow" aria-labelledby="upgradePlanFlowTitle">
    <div class="upgrade-plan-head">
      <h3 id="upgradePlanFlowTitle">${l('推荐替换路径', '建議替換路徑', 'Recommended replacement path')}</h3>
      <span class="upgrade-plan-summary">${reached
        ? l(`换 ${plan.replacementCount} 件即可达标`, `換 ${plan.replacementCount} 件即可達標`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} to meet every target`)
        : l(`换 ${plan.replacementCount} 件，还差 ${plan.metrics.shortfall} 点`, `換 ${plan.replacementCount} 件，還差 ${plan.metrics.shortfall} 點`, `Replace ${plan.replacementCount} and remain ${plan.metrics.shortfall} short`)}</span>
      <span class="upgrade-plan-kept">${l(
        `保留当前 ${kept} / 5 件护甲`,
        `保留目前 ${kept} / 5 件防具`,
        `Keep ${kept} / 5 current pieces`,
      )}</span>
    </div>
    <ol class="upgrade-plan-steps">${plan.steps.map((step, index) => {
      const complete = certifiedFeasible(step.evaluation);
      const finalTuning = plan.evaluation.tuningAssignments[step.slotIndex];
      const finalArmorMod = plan.evaluation.modAssignments[step.slotIndex];
      return `<li class="upgrade-plan-step">
        <span class="upgrade-plan-number">${index + 1}</span>
        <div class="upgrade-plan-step-body">
          <div class="upgrade-plan-step-head">
            <strong class="upgrade-plan-slot">${getUpgradeSlotLabel(step.slotIndex)}${step.tuningOnly
              ? `<span class="upgrade-plan-tag">${l('只差 +5 属性','只差 +5 數值','+5 stat only')}</span>`
              : ''}</strong>
            <span class="upgrade-plan-progress ${complete ? 'is-complete' : ''}">${complete
              ? l('换完后六维都达标','換完後六維都達標','All targets met after this step')
              : l(`换完还差 ${step.evaluation.metrics.shortfall} 点`, `換完還差 ${step.evaluation.metrics.shortfall} 點`, `${step.evaluation.metrics.shortfall} points short after this step`)}</span>
          </div>
          <div class="upgrade-plan-lanes">
            <div class="upgrade-plan-lane">
              <span class="upgrade-plan-lane-label">${l('当前','目前','Now')}</span>
              <span class="upgrade-plan-config upgrade-plan-config--before">${formatUpgradePieceSummary(step.beforePiece)}</span>
            </div>
            <div class="upgrade-plan-lane">
              <span class="upgrade-plan-lane-label"><span class="upgrade-plan-arrow" aria-hidden="true">→</span>${l('目标','目標','Target')}</span>
              <strong class="upgrade-plan-config upgrade-plan-config--after">${formatUpgradePieceSummary(step.afterPiece)}</strong>
            </div>
            <div class="upgrade-plan-lane">
              <span class="upgrade-plan-lane-label">${l('执行','執行','Do')}</span>
              <span class="upgrade-plan-exec-item"><em>${l('调整','調校','Tuning')}</em>${formatUpgradeTuning(finalTuning)}</span>
              <span class="upgrade-plan-exec-item"><em>${l('模组','模組','Mod')}</em>${formatUpgradeArmorMod(finalArmorMod)}</span>
            </div>
          </div>
          <div class="upgrade-plan-totals">${formatUpgradeTotals(step.evaluation.finalTotals)}</div>
        </div>
      </li>`;
    }).join('')}</ol>
    <p class="upgrade-plan-note">${l(
      '每一步都要刷到一件新护甲：框架、第三属性和调整 +5 属性都必须对上（+5 属性是随护甲刷出来的，装上后不能改，只有 -5 来源可选）。',
      '每一步都要刷到一件新防具：原型、第三數值和調校 +5 數值都必須對上（+5 數值是隨防具刷出來的，裝上後不能改，只有 -5 來源可選）。',
      'Each step needs a newly farmed piece whose archetype, tertiary stat, and rolled +5 tuning stat all match — the +5 side comes with the armor, only the -5 source is yours to pick.',
    )}</p>
  </section>`;
}

// The plan's explanation half — where each number comes from, and what happens
// if nothing is farmed. Collapsed: the hero already answered "can I, and how
// many swaps".
function buildUpgradeExplanation(analysis, keepOnly = false) {
  return `<details class="upgrade-explanation" data-disclosure-key="upgrade-explanation">
    <summary>${l('数值说明与备选方案', '數值說明與備選方案', 'How the numbers work, and the alternative')}</summary>
    ${buildUpgradeBaselineNote(analysis, keepOnly)}
    ${buildUpgradeKeepArmorAlternative(analysis)}
  </details>`;
}

function buildUpgradeAssignments(evaluation) {
  const planned = (evaluation?.configs || []).length;
  return `<details class="upgrade-assignment-details" data-disclosure-key="upgrade-assignments">
    <summary>${l('最终调整与模组配置', '最終調校與模組配置', 'Final Tuning and stat mods')}<span class="upgrade-assignment-count">${planned > 0
      ? l(`${planned} 件已规划`, `${planned} 件已規劃`, `${planned} pieces planned`)
      : ''}</span></summary>
    ${renderWitnessBreakdown(evaluation)}
    <div class="upgrade-assignment-list">${evaluation.configs.map((config, index) => `
      <div class="upgrade-assignment-row">
        <strong>${getUpgradeSlotLabel(index)}</strong>
        <span>${formatUpgradeConfigSummary(config)}</span>
        <span>${formatUpgradeTuning(evaluation.tuningAssignments[index])} · ${formatUpgradeArmorMod(evaluation.modAssignments[index])}</span>
      </div>`).join('')}
    </div>
    <p class="upgrade-empty">${l(
      '调整的 +5 属性是护甲刷取时自带的，不能更改；表中只有 -5 来源和护甲模组是你可以自由分配的。',
      '調校的 +5 數值是防具取得時自帶的，不能更改；表中只有 -5 來源和防具模組是你可以自由分配的。',
      'The +5 side of a tuning mod is rolled onto the armor and cannot be changed; only the -5 source and the armor mods above are yours to assign.'
    )}</p>
  </details>`;
}

// The alternative to a farming plan: keep all five pieces and only re-pick the
// tuning -5 sources and armor mods. This is what analysis.baseline already is.
function buildUpgradeKeepArmorAlternative(analysis) {
  const shortfall = analysis.baseline.metrics.shortfall;
  return `<details class="upgrade-alternative" data-disclosure-key="upgrade-alternative">
    <summary>${l(
      `备选方案：不刷护甲，保留现有五件重排调整与模组，还差 ${shortfall} 点`,
      `備選方案：不刷防具，保留目前五件重排調校與模組，還差 ${shortfall} 點`,
      `Alternative: no farming — keep all five pieces, rearrange tuning and mods, ${shortfall} points short`
    )}</summary>
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeAssignments(analysis.baseline)}
    <p class="upgrade-empty">${l(
      '不想刷取新护甲的话，这是现有五件能达到的最好六维；想完全达标，还是需要按上面的方案刷取替换件。',
      '不想刷取新防具的話，這是目前五件能達到的最好六維；想完全達標，還是需要按上面的方案刷取替換件。',
      'If you do not want to farm, this is the best your five current pieces can reach; to meet every target you still need the replacement plan above.'
    )}</p>
  </details>`;
}

// The result hero. Level 1 of the visual hierarchy: status, then the two
// numbers a reader needs to decide (how many swaps, how many kept), and only
// then — behind a disclosure — the prose. Nothing long is above the fold.
function upgradeHero({ tone = 'is-met', eyebrow, headline, copy, outcome, outcomeNote }) {
  return `<div class="upgrade-hero ${tone}">
    <div class="upgrade-hero-main">
      <span class="upgrade-eyebrow">${eyebrow}</span>
      <div class="upgrade-recommendation">${headline}</div>
      <details class="upgrade-hero-more" data-disclosure-key="upgrade-hero-more">
        <summary>${l('查看说明', '檢視說明', 'Details')}</summary>
        <p class="upgrade-recommendation-copy">${copy}</p>
      </details>
    </div>
    <div class="upgrade-outcome">
      <strong>${outcome}</strong>
      <span>${outcomeNote}</span>
    </div>
  </div>`;
}

function renderUpgradeAnalysis(analysis, scroll = false) {  if (!analysis) return;
  lastUpgradeAnalysis = analysis;
  const section = document.getElementById('upgradeResults');
  const body = document.getElementById('upgradeResultsBody');
  section.hidden = calculatorMode !== 'upgrade';
  if (!analysis.certificate?.witnessVerification?.valid) {
    body.innerHTML = `<div class="msg warn">${escapeHtml(searchProofLabel(analysis))}</div>`;
    return;
  }
  let displayedEvaluation = analysis.baseline;

  if (certifiedFeasible(analysis.baseline)) {
    const enteredAlreadyReached = certifiedFeasible(analysis.enteredBaseline);
    const needsMasterwork = (analysis.projectedMasterworkIndices?.length || 0) > 0;
    body.innerHTML = `${upgradeHero({
      tone: 'is-met',
      eyebrow: l('当前配装','目前配裝','Current loadout'),
      headline: enteredAlreadyReached
        ? l('不用换护甲','不用換防具','Keep all five pieces')
        : (needsMasterwork
          ? l('完成大师杰作并重配模组','完成大師之作並重配模組','Fully Masterwork and rearrange mods')
          : l('只要重配模组','只要重配模組','Just rearrange the mods')),
      copy: enteredAlreadyReached
        ? l(
          '现在这套已经达标。下面是最后的模组分配，照着核对一遍就行。',
          '目前這套已經達標。下面是最後的模組分配，照著核對一遍就行。',
          'This loadout already meets every target. Check the final mod setup below and you are done.')
        : l(
          '护甲都可以留下。按下面重新选调整的 -5 来源、重排属性模组就能达标；调整的 +5 属性是护甲自带的，这里没有动过。',
          '防具都可以留下。按下面重新選調校的 -5 來源、重排數值模組就能達標；調校的 +5 數值是防具自帶的，這裡沒有動過。',
          'You can keep every armor piece. Re-pick each tuning mod\'s -5 source and rearrange the stat mods as shown to meet every target — the rolled +5 stats are untouched.'),
      outcome: l('5 件都能留下','5 件都能留下','Keep all 5 pieces'),
      outcomeNote: l(
        '最少替换 0 件 · 保留 5 / 5 件 · 不用再刷护甲',
        '最少替換 0 件 · 保留 5 / 5 件 · 不用再取得防具',
        '0 replacements · 5 / 5 kept · no armor farming',
      ),
    })}
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeAssignments(analysis.baseline)}
    <details class="upgrade-explanation" data-disclosure-key="upgrade-explanation">
      <summary>${l('数值说明', '數值說明', 'How the numbers work')}</summary>
      ${buildUpgradeBaselineNote(analysis)}
    </details>`;
  } else if (!analysis.plan) {
    // The bounded fallback found no better witness. This is not an optimality
    // or infeasibility proof, so the UI must keep that distinction explicit.
    const rearranged = analysis.reassignModifiers && analysis.enteredBaseline &&
      STATS.some(stat =>
        analysis.enteredBaseline.finalTotals[stat] !== analysis.baseline.finalTotals[stat]
      );
    body.innerHTML = `${upgradeHero({
      tone: 'is-pending',
      eyebrow: l('搜索受限','搜尋受限','Search limited'),
      headline: rearranged
        ? l('当前最佳配装：重配模组','目前最佳配裝：重配模組','Current-best loadout after rearranging mods')
        : l('当前配装是目前最佳搭配','目前配裝是當前最佳搭配','Current loadout is the best loadout found'),
      copy: l(
        `搜索时间内未找到更好的替换方案；当前搭配还差 ${analysis.baseline.metrics.shortfall} 点，仍可能存在更好的搭配。`,
        `搜尋時間內未找到更好的替換方案；目前搭配還差 ${analysis.baseline.metrics.shortfall} 點，仍可能存在更好的搭配。`,
        `The bounded search found no better replacement loadout. This setup is ${analysis.baseline.metrics.shortfall} points short; global optimality and infeasibility remain unproven.`),
      outcome: l(
        `还差 ${analysis.baseline.metrics.shortfall} 点`,
        `還差 ${analysis.baseline.metrics.shortfall} 點`,
        `${analysis.baseline.metrics.shortfall} points short`),
      outcomeNote: l(
        '最少替换 0 件 · 保留 5 / 5 件 · 无需刷取',
        '最少替換 0 件 · 保留 5 / 5 件 · 無需取得',
        '0 replacements · 5 / 5 kept · no farming needed',
      ),
    })}
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    <details class="upgrade-explanation" data-disclosure-key="upgrade-explanation">
      <summary>${l('数值说明', '數值說明', 'How the numbers work')}</summary>
      ${buildUpgradeBaselineNote(analysis)}
    </details>`;
  } else {
    const plan = analysis.plan;
    displayedEvaluation = plan.evaluation;
    const reached = certifiedFeasible(plan.evaluation);
    const kept = 5 - plan.replacementCount;
    const farmLabel = importedInventory.length > 0
      ? `<div class="upgrade-option-label">${l(
        '刷取方案：替换清单中没有的护甲（与上面从已有清单搭配的方案二选一）',
        '刷取方案：替換清單中沒有的防具（與上面從已有清單搭配的方案二選一）',
        'Farming plan: pieces not in your inventory (alternative to the owned-armor loadouts above)'
      )}</div>`
      : '';
    body.innerHTML = farmLabel + upgradeHero({
      tone: reached ? 'is-met' : 'is-short',
      eyebrow: reached
        ? (plan.replacementProof?.minimal
          ? l('已证明的最少替换方案','已證明的最少替換方案','Proven minimum-replacement plan')
          : l('可行替换配装','可行替換配裝','Feasible replacement loadout'))
        : l('当前最佳替换配装','目前最佳替換配裝','Current-best replacement loadout'),
      headline: reached
        ? l(`换 ${plan.replacementCount} 件就能达标`, `換 ${plan.replacementCount} 件就能達標`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} to meet every target`)
        : l(`换 ${plan.replacementCount} 件后还差 ${plan.metrics.shortfall} 点`, `換 ${plan.replacementCount} 件後還差 ${plan.metrics.shortfall} 點`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} and remain ${plan.metrics.shortfall} short`),
      copy: reached
        ? l(
          '方案已按优先顺序排好，照着下面执行即可。如果暂时不想刷，也可以先保留现有护甲重排调整与模组，但还差 ' + analysis.baseline.metrics.shortfall + ' 点（见下方备选方案）。',
          '方案已按優先順序排好，照著下面執行即可。如果暫時不想刷，也可以先保留目前防具重排調校與模組，但還差 ' + analysis.baseline.metrics.shortfall + ' 點（見下方備選方案）。',
          'The swaps are already prioritized. Follow the steps below. If you do not want to farm yet, keeping your current armor and rearranging tuning and mods works too, but leaves ' + analysis.baseline.metrics.shortfall + ' points short (see the alternative below).')
        : l(
          '搜索时间内尚未找到全部达标的搭配。下面是目前找到的最佳方案，仍可能存在更好的搭配；保留现有护甲重排调整与模组还差 ' + analysis.baseline.metrics.shortfall + ' 点。',
          '搜尋時間內尚未找到全部達標的搭配。下面是目前找到的最佳方案，仍可能存在更好的搭配；保留目前防具重排調校與模組還差 ' + analysis.baseline.metrics.shortfall + ' 點。',
          'The bounded search has not found a loadout meeting all six targets. The result below is current-best, not a proof of global optimality or infeasibility; keeping current armor leaves ' + analysis.baseline.metrics.shortfall + ' points short.'),
      outcome: reached
        ? l('六维都达标','六維都達標','All six targets met')
        : l(`还差 ${plan.metrics.shortfall} 点`, `還差 ${plan.metrics.shortfall} 點`, `${plan.metrics.shortfall} points short`),
      outcomeNote: l(
        `最少替换 ${plan.replacementCount} 件 · 保留 ${kept} / 5 件`,
        `最少替換 ${plan.replacementCount} 件 · 保留 ${kept} / 5 件`,
        `${plan.replacementCount} replacement${plan.replacementCount === 1 ? '' : 's'} · ${kept} / 5 kept`,
      ),
    }) + `
    ${buildUpgradeStatComparison(analysis, plan.evaluation.finalTotals)}
    ${buildUpgradePlanFlow(analysis, plan)}
    ${buildUpgradeAssignments(plan.evaluation)}
    ${buildUpgradeExplanation(analysis)}`;
  }
  body.insertAdjacentHTML('afterbegin', buildUpgradeRequirementResult(analysis, displayedEvaluation));
  lastCommittedInputSignature = currentInputSignature();
  if (scroll) section.scrollIntoView({ behavior:'smooth', block:'start' });
}

let lastInventoryResult = null;
let lastInventoryTargets = null;
let lastInventoryRequiredStats = [];
let inventorySolveRevision = 0;

function clearInventoryResults() {
  invalidateOwnedPlanCache();
  inventorySolveRevision++;
  lastInventoryResult = null;
  lastInventoryTargets = null;
  lastInventoryRequiredStats = [];
  // A brand-new search starts from a clean slate: no stale selection key, no
  // accordions remembered from the previous result set.
  lastUnifiedLoadouts = [];
  selectedEntryKey = null;
  detailDisclosureState.clear();
  const el = document.getElementById("inventoryResults");
  if (el) {
    el.innerHTML = "";
    el.hidden = true;
  }
  syncCommandBarActions();
}

function formatSetRequirementLabel(requirement) {
  if (!requirement || requirement.type === "none") {
    return l("不要求", "不要求", "None");
  }
  if (requirement.type === "set") {
    return `${escapeHtml(getSetName(getArmorSetByHash(requirement.setHash)))} ${requirement.count} ${l("件套", "件套", "pc")}`;
  }
  return `${escapeHtml(getSetName(getArmorSetByHash(requirement.a)))} 2 + ${escapeHtml(getSetName(getArmorSetByHash(requirement.b)))} 2`;
}

function snapshotSetRequirement(requirement = setRequirement) {
  if (!requirement || requirement.type === "none") return { type: "none" };
  if (requirement.type === "set") {
    return {
      type: "set",
      setHash: Number(requirement.setHash),
      count: Number(requirement.count),
    };
  }
  return {
    type: "split",
    a: Number(requirement.a),
    b: Number(requirement.b),
  };
}

function sameSetRequirement(left, right) {
  return JSON.stringify(snapshotSetRequirement(left)) ===
    JSON.stringify(snapshotSetRequirement(right));
}

// Search the imported inventory for loadouts built only from owned pieces and
// render them as the "no farming" option. Returns the message HTML so the
// caller can compose it with the farming-plan message.
async function solveInventoryRequirement({
  targets = getUpgradeTargets(),
  fragments = getUpgradeFragments(),
  requiredStats = getUpgradeRequiredStats(),
  onlyPlus5Tuning = document.getElementById('upgradeOnlyPlus5')?.checked === true,
  constraints = {},
  modifierBudget = null,
} = {}) {
  const fromScratch = calculatorMode === 'solve';
  const button = document.getElementById(fromScratch ? 'btnSolve' : 'btnUpgradeAnalyze');
  const loading = document.getElementById("loading");
  const requirementSnapshot = snapshotSetRequirement();
  const solveRevision = ++inventorySolveRevision;
  const revision = searchUiRevision;
  const setControls = [...document.querySelectorAll(".set-requirement-head select")];
  const reassignModifiers = fromScratch || document.getElementById("upgradeReassignModifiers")?.checked !== false;
  const inputs = fromScratch ? getOwnedArmorInputs() : null;
  const classItem = fromScratch ? getExoticSettings() : null;
  const fixedExotic = classItem ? {...classItem, slot: 'classItem', hash: EXOTIC_CLASSES[classItem.classId]?.itemHash}
    : inputs?.fixedExotic || null;
  const pool = inputs?.items || filterArmorItems(importedInventory, {
    classId: importClassFilter || null,
    tier5Only: importTier5Only,
  });
  if (pool.length === 0) {
    return `<div class="msg error">${icon("block")}${l(
      "当前筛选下没有可用的护甲（检查职业与 Tier 5 开关），无法从清单中搭配。",
      "目前篩選下沒有可用的防具（檢查職業與 Tier 5 開關），無法從清單中搭配。",
      "No usable armor under the current filter (check class and the Tier 5 toggle); cannot build from the list."
    )}</div>`;
  }

  button.disabled = true;
  setControls.forEach(control => { control.disabled = true; });
  loading.querySelector("p").textContent = l(
    "正在从已有清单中搭配护甲与六维...",
    "正在從已有清單中搭配防具與六維...",
    "Searching your inventory for the best loadout..."
  );
  loading.classList.add("show");
  loading.setAttribute("aria-busy", "true");
  if (!fromScratch) saveUpgradeDraft();

  try {
    const inventoryRequest = {
      searchProfile,
      items: pool,
      targets,
      fragments,
      setRequirement: requirementSnapshot,
      reassignModifiers,
      currentPieces: fromScratch ? null : upgradeBuildState,
      fixedExotic,
      modifierBudget,
      requiredStats,
      onlyPlus5Tuning,
      userConstraints: constraints,
    };
    const result = await solveInventoryParallelAsync(inventoryRequest, {parallelism: Math.min(4,
      Math.max(1, Number(globalThis.navigator?.hardwareConcurrency) || 2)), onProgress: (partial) => {
      if (revision !== searchUiRevision || solveRevision !== inventorySolveRevision) return;
      if (partial?.results?.length) {
        lastInventoryTargets = targets; lastInventoryRequiredStats = requiredStats;
        renderInventoryResults(partial);
      }
    }});
    if (revision !== searchUiRevision || solveRevision !== inventorySolveRevision ||
        !sameSetRequirement(requirementSnapshot, setRequirement)) {
      return null;
    }
    lastInventoryTargets = targets;
    lastInventoryRequiredStats = requiredStats;
    renderInventoryResults(result);
    const qualifyingCount = result?.results?.filter(certifiedFeasible).length || 0;
    if (qualifyingCount) {
      const proofLabel = inventoryProofLabel(result);
      const executionLabel = result.executionStatus === 'VERIFIED'
        ? l('执行预检已验证', '執行預檢已驗證', 'Execution preflight verified')
        : result.executionStatus === 'BLOCKED'
          ? l('执行预检被阻止', '執行預檢被阻止', 'Execution preflight blocked')
          : l('执行能力尚未完全验证', '執行能力尚未完全驗證', 'Execution capability unverified');
      return `<div class="msg info">${icon("check")}<strong>${proofLabel}</strong> · ${executionLabel}<br>${requirementSnapshot.type === "none"
        ? l(
          `已有护甲找到 ${qualifyingCount} 个达标组合，无需刷取新护甲；请核对大师杰作和执行预检后导出 DIM 配装链接。`,
          `已有防具找到 ${qualifyingCount} 個達標組合，無需取得新防具；請核對大師之作與執行預檢後匯出 DIM 配裝連結。`,
          `Found ${qualifyingCount} qualifying owned loadouts. No new armor needed; check masterwork and execution preflight before exporting to DIM.`
        )
        : l(
          `已有护甲找到 ${qualifyingCount} 个同时满足属性与 ${formatSetRequirementLabel(requirementSnapshot)} 的组合，无需刷取新护甲。`,
          `已有防具找到 ${qualifyingCount} 個同時滿足數值與 ${formatSetRequirementLabel(requirementSnapshot)} 的組合，無需取得新防具。`,
          `Found ${qualifyingCount} owned loadouts meeting both stat rules and ${formatSetRequirementLabel(requirementSnapshot)}. No new armor needed.`
        )}</div>`;
    }
    return `<div class="msg warn">${escapeHtml(inventoryProofLabel(result))}</div>`;
  } catch (error) {
    if (error.name === 'AbortError') return null;
    console.error("Inventory solve failed", error);
    return `<div class="msg error">${icon("block")}${l(
      "库存搭配计算失败，请重试。",
      "庫存搭配計算失敗，請重試。",
      "The inventory solve failed. Please try again."
    )}</div>`;
  } finally {
    if (revision === searchUiRevision) {
      button.disabled = false;
      setControls.forEach(control => { control.disabled = false; });
      loading.classList.remove("show");
      loading.setAttribute("aria-busy", "false");
      loading.querySelector("p").textContent = t("calculating");
    }
  }
}

// ============================================================
// UNIFIED LOADOUT LIST (owned armor + theoretical skeletons)
// ============================================================
// Two surfaces used to render independently: the inventory frontier's owned
// loadouts and the theoretical plan list. They disagreed because each ranked
// and deduplicated alone, so a fully owned plan appeared on top and was missing
// from the list below. Both are now projected into one entry shape and ordered
// by 达标优先, then by how complete the owned armor is.
// How many plan rows exist in the DOM before the user asks for more. The
// solver still retains every candidate; this only bounds rendered markup.
const PLAN_PAGE_SIZE = 60;
let lastUnifiedLoadouts = [];
let selectedUnifiedIndex = 0;
let unifiedCache = { key: null, solutions: null, entries: [] };
let renderingUnifiedList = false;
// Every progressive inventory arrival must invalidate the unified projection.
// `results.length` cannot do that: the Top-K keeps 12 entries while their
// content and order change, so the cache would serve a stale list forever.
let inventoryResultRevision = 0;

// --- Single source of truth for "which loadout is on screen" ---------------
// Save, DIM export, Bungie equip and every advanced panel resolve the current
// selection here. `allSolutions[currentSolutionIdx]` is the *theory* solver's
// own cursor and must never be read as the user's current choice.
function getSelectedUnifiedEntry() {
  const index = Number.isInteger(selectedUnifiedIndex) ? selectedUnifiedIndex : 0;
  return lastUnifiedLoadouts[index] ?? null;
}

function getSelectedUnifiedWitness() {
  return getSelectedUnifiedEntry()?.witness ?? null;
}

// Thin adapter for legacy call sites that still pass the rendered row index.
// The index must address the same list the UI rendered; anything else falls
// back to the one selection, so a stale index can never resurrect an old plan.
function resolveUnifiedEntry(index) {
  if (Number.isInteger(index) && index >= 0 && index < lastUnifiedLoadouts.length) {
    return lastUnifiedLoadouts[index];
  }
  return getSelectedUnifiedEntry();
}
// The list itself keeps every candidate the solver retained. These fields only
// decide which rows exist in the DOM and which one is open — filtering and
// paging must never change search breadth, only rendered DOM size.
let selectedEntryKey = null;
let planFilter = "all";
let planSort = "recommended";
let planRenderLimit = PLAN_PAGE_SIZE;
let conditionsDrawerOpen = false;

function compareRankTuples(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = Number(a[index] || 0) - Number(b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function unifiedPieceIdentity(piece) {
  const identity = piece?.sourceId || piece?.id || piece?.item?.sourceId || piece?.item?.id;
  if (identity) return `${piece.slot}:${identity}`;
  return `${piece?.slot}:farm:${piece?.farmSetHash || 0}:${piece?.archetype || piece?.archetypeId || ''}:${piece?.tertiary || ''}`;
}

function unifiedEntryKey(entry) {
  return entry.pieces.map(unifiedPieceIdentity).sort().join('|');
}

// 达标优先 → 精确达成 → 已有护甲更完整 → 刷取更少 → 理论排名 → 易刷程度.
function compareUnifiedEntries(left, right) {
  if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
  if (left.exact !== right.exact) return left.exact ? -1 : 1;
  if (left.ownedCount !== right.ownedCount) return right.ownedCount - left.ownedCount;
  if (left.farmCount !== right.farmCount) return left.farmCount - right.farmCount;
  const rankOrder = compareRankTuples(left.rank, right.rank);
  if (rankOrder !== 0) return rankOrder;
  if (left.farmability !== right.farmability) return left.farmability - right.farmability;
  return 0;
}

function normalizeInventoryEntry(entry, search) {
  return {
    kind: "inventory",
    witness: entry,
    pieces: entry.pieces,
    ownedCount: entry.pieces.length,
    farmCount: 0,
    feasible: certifiedFeasible(entry),
    exact: entry.certificate?.status === "EXACT_TARGET_PROVEN",
    rank: entry.rank || [],
    farmability: 0,
    current: entry.isCurrent === true,
    tuningAssignments: entry.tuningAssignments,
    modAssignments: entry.modAssignments,
    certificate: entry.certificate,
    // Search metadata belongs to the result *collection*, never to a single
    // row. Normalizing it onto the entry here is what lets the list and the
    // advanced panel read one shape (entry.search / entry.search.coverage)
    // instead of guessing between witness.search and plan.solution.search.
    search: entry.search || search || null,
  };
}

function normalizeTheoryPlan(plan, search) {
  const witness = plan.matchedSolution || plan.solution;
  if (!witness) return null;
  // Two different questions share one boolean here. `ruleFeasible` answers "do
  // the six stats satisfy the rules", which is what the sealed witness proves.
  // `plan.feasible` additionally requires that the owned/farm + set mapping can
  // actually reach that witness (see inventory-plan.mjs). A witness that is
  // rule-satisfying but physically unmappable must never be counted as 达标 and
  // must never outrank a genuinely implementable plan.
  const ruleFeasible = certifiedFeasible(witness);
  const planFeasible = plan.feasible === true;
  return {
    kind: "theory",
    witness,
    plan,
    pieces: plan.pieces,
    ownedCount: plan.ownedCount,
    farmCount: plan.farmCount,
    ruleFeasible,
    planFeasible,
    feasible: ruleFeasible && planFeasible,
    exact: witness.certificate?.status === "EXACT_TARGET_PROVEN",
    rank: witness.rank || [],
    farmability: Number(plan.farmability) || 0,
    current: false,
    tuningAssignments: witness.tuningAssignments,
    modAssignments: witness.modAssignments,
    certificate: witness.certificate,
    search: witness.search || search || null,
  };
}

function buildUnifiedLoadouts() {
  // Progressive search replaces the Top-K with better candidates while its
  // length stays at maxResults, so identity of the inventory result revision —
  // not its size — is what invalidates this projection.
  const cacheKey = `${ownedPlanRevision}|${inventorySolveRevision}|${inventoryResultRevision}`;
  if (unifiedCache.key === cacheKey && unifiedCache.solutions === allSolutions) {
    return unifiedCache.entries;
  }
  const entries = (lastInventoryResult?.results || [])
    .map(entry => normalizeInventoryEntry(entry, lastInventoryResult?.search));
  const request = createOwnedArmorPlanRequest(
    allSolutions, Math.max(SOLUTION_PREVIEW_COUNT, allSolutions.length), { allowEmpty: true },
  );
  if (request) {
    const theorySearch = allSolutions?.search || null;
    for (const plan of rankInventoryPlans(request)) {
      const entry = normalizeTheoryPlan(plan, theorySearch);
      if (entry) entries.push(entry);
    }
  }
  // A fully owned theoretical skeleton and an inventory witness describe the
  // same five pieces. The inventory entry wins because it carries execution
  // preflight; dropping the duplicate is what removes the "shown twice" plan.
  const seen = new Set();
  const merged = [];
  for (const entry of entries) {
    const key = unifiedEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  merged.sort(compareUnifiedEntries);
  unifiedCache = { key: cacheKey, solutions: allSolutions, entries: merged };
  return merged;
}

function renderInventoryResults(result) {
  if (result && result !== lastInventoryResult) {
    lastInventoryResult = result;
    // Any accepted inventory result — including a progressive merge that keeps
    // the same Top-K size — advances the projection revision.
    inventoryResultRevision++;
  }
  renderUnifiedResults();
}

// --- Plan browser view projection (filter + sort) ---------------------------
// Filtering is purely a view concern: the solver's candidate set is untouched,
// so narrowing the list can never hide a plan the search actually proved.
const PLAN_FILTERS = {
  all: () => true,
  qualifying: entry => entry.feasible === true,
  owned: entry => entry.farmCount === 0,
  lowfarm: entry => entry.farmCount <= 1,
};

function projectPlanView(entries) {
  const predicate = PLAN_FILTERS[planFilter] || PLAN_FILTERS.all;
  const view = entries.filter(predicate);
  // "recommended" keeps compareUnifiedEntries order (达标 → 精确 → 已有更多 →
  // 缺口更少). The other orders are explicit user overrides and fall back to the
  // recommended order inside a tie so the list never looks random.
  if (planSort === "owned") {
    view.sort((left, right) => right.ownedCount - left.ownedCount || compareUnifiedEntries(left, right));
  } else if (planSort === "farm") {
    view.sort((left, right) => left.farmCount - right.farmCount || compareUnifiedEntries(left, right));
  } else if (planSort === "rank") {
    view.sort((left, right) => compareRankTuples(left.rank, right.rank) || compareUnifiedEntries(left, right));
  }
  return view;
}

function planCounts(entries) {
  return {
    total: entries.length,
    qualifying: entries.filter(entry => entry.feasible === true).length,
    owned: entries.filter(entry => entry.farmCount === 0).length,
    lowfarm: entries.filter(entry => entry.farmCount <= 1).length,
  };
}

function setPlanFilter(value) {
  planFilter = PLAN_FILTERS[value] ? value : "all";
  planRenderLimit = PLAN_PAGE_SIZE;
  renderUnifiedResults();
}

function setPlanSort(value) {
  planSort = ["recommended", "owned", "farm", "rank"].includes(value) ? value : "recommended";
  renderUnifiedResults();
}

function showMorePlans() {
  planRenderLimit += PLAN_PAGE_SIZE;
  renderUnifiedResults();
}

function toggleConditionsDrawer(force) {
  conditionsDrawerOpen = typeof force === "boolean" ? force : !conditionsDrawerOpen;
  const drawer = document.getElementById("conditionsDrawer");
  if (drawer) drawer.hidden = !conditionsDrawerOpen;
  const button = document.getElementById("btnEditConditions");
  if (button) button.setAttribute("aria-expanded", String(conditionsDrawerOpen));
}

function renderPlanBrowserToolbar(counts, shown) {
  const chip = (key, label, count) => `<button type="button" class="plan-chip ${planFilter === key ? "is-active" : ""}"
    aria-pressed="${planFilter === key}" onclick="setPlanFilter('${key}')">${label}<span>${count}</span></button>`;
  const option = (key, label) => `<option value="${key}" ${planSort === key ? "selected" : ""}>${label}</option>`;
  return `<div class="plan-browser-toolbar">
    <div class="plan-filter-row" role="group" aria-label="${l("方案筛选", "方案篩選", "Plan filters")}">
      ${chip("all", l("全部", "全部", "All"), counts.total)}
      ${chip("qualifying", l("达标", "達標", "Qualifying"), counts.qualifying)}
      ${chip("owned", l("已有齐全", "已有齊全", "Fully owned"), counts.owned)}
      ${chip("lowfarm", l("待刷 ≤1", "待取得 ≤1", "Farm ≤1"), counts.lowfarm)}
    </div>
    <label class="plan-sort">
      <span>${l("排序", "排序", "Sort")}</span>
      <select onchange="setPlanSort(this.value)" aria-label="${l("方案排序", "方案排序", "Sort plans")}">
        ${option("recommended", l("推荐", "推薦", "Recommended"))}
        ${option("owned", l("已有最多", "已有最多", "Most owned"))}
        ${option("farm", l("待刷最少", "待取得最少", "Least farming"))}
        ${option("rank", l("理论排名", "理論排名", "Theoretical rank"))}
      </select>
    </label>
    <span class="plan-browser-shown">${shown < counts.total
      ? l(`显示 ${shown}/${counts.total}`, `顯示 ${shown}/${counts.total}`, `Showing ${shown} of ${counts.total}`)
      : l(`${counts.total} 个方案`, `${counts.total} 個方案`, `${counts.total} plans`)}</span>
  </div>`;
}

function renderResultWorkspace(allEntries, view, index) {
  const counts = planCounts(allEntries);
  const fromScratch = calculatorMode === "solve";
  // The header still has to name the set requirement the list was solved
  // against; without it a constrained list looks like an unconstrained one.
  const activeRequirement = lastInventoryResult?.requirement || snapshotSetRequirement();
  const requirementLabel = !activeRequirement || activeRequirement.type === "none"
    ? l("不要求套装", "不要求套裝", "No set requirement")
    : formatSetRequirementLabel(activeRequirement);
  const shown = Math.min(planRenderLimit, view.length);
  const empty = view.length === 0;
  return `
    <div class="inventory-results-head">
      <h2 class="inventory-results-title">${fromScratch
        ? l("配装方案", "配裝方案", "Loadouts")
        : l("已有护甲搭配方案", "已有防具搭配方案", "Owned armor loadouts")}</h2>
      <span class="inventory-results-req">${requirementLabel} · ${l(
        `共 ${counts.total} 个方案 · ${counts.qualifying} 个达标 · ${counts.owned} 个已有齐全`,
        `共 ${counts.total} 個方案 · ${counts.qualifying} 個達標 · ${counts.owned} 個已有齊全`,
        `${counts.total} plans · ${counts.qualifying} qualifying · ${counts.owned} fully owned`
      )}</span>
    </div>
    <div class="inventory-results-layout">
      <section class="plan-browser" id="planBrowser" aria-label="${l("配装方案", "配裝方案", "Loadouts")}">
        ${renderPlanBrowserToolbar(counts, shown)}
        <div class="inventory-result-list" id="planList" role="listbox" aria-label="${l("方案清单", "方案清單", "Loadout list")}">
          ${view.slice(0, planRenderLimit).map((entry, rowIndex) => renderPlanRow(entry, rowIndex)).join("")}
        </div>
        ${empty
          ? `<p class="plan-empty">${l(
            "当前筛选下没有方案。换一个筛选条件即可继续查看。",
            "目前篩選下沒有方案。換一個篩選條件即可繼續查看。",
            "No plan matches this filter. Pick another filter to keep browsing.",
          )}</p>`
          : view.length > planRenderLimit
            ? `<button type="button" class="btn plan-browser-more" onclick="showMorePlans()">${l(
              `显示更多方案（剩余 ${view.length - planRenderLimit}）`,
              `顯示更多方案（剩餘 ${view.length - planRenderLimit}）`,
              `Show more plans (${view.length - planRenderLimit} left)`,
            )}</button>`
            : ""}
      </section>
      <section class="inventory-result-detail" id="loadoutDetail" aria-label="${l("当前方案", "目前方案", "Selected loadout")}">
        ${empty
          ? `<p class="plan-empty">${l(
            "选择左侧任意方案查看五件护甲明细。",
            "選擇左側任意方案查看五件防具明細。",
            "Select any plan on the left to see its five-piece armor detail.",
          )}</p>`
          : renderSelectedLoadout(view[index], index)}
      </section>
    </div>`;
}

// Which row stays selected after the list is rebuilt. Content identity wins, so
// a progressive refresh that reorders the Top-K keeps the reader on the same
// loadout; a plan that was eliminated falls back to the same ordinal (clamped
// into range) rather than to nothing, and an empty view has no selection.
function resolveSelectedRowIndex(view, entryKey, previousIndex) {
  if (!Array.isArray(view) || view.length === 0) return -1;
  if (entryKey) {
    const found = view.findIndex(entry => unifiedEntryKey(entry) === entryKey);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(0, Number(previousIndex) || 0), view.length - 1);
}

function renderUnifiedResults() {
  if (renderingUnifiedList) return;
  const el = document.getElementById("inventoryResults");
  if (!el) return;
  renderingUnifiedList = true;
  try {
    const all = buildUnifiedLoadouts();
    const view = projectPlanView(all);
    lastUnifiedLoadouts = view;
    if (all.length === 0) {
      el.innerHTML = "";
      el.hidden = true;
      syncCommandBarActions();
      return;
    }
    // A filter that matches nothing must never destroy the toolbar, or the
    // reader has no way back to the other filters.
    if (view.length === 0) {
      selectedEntryKey = null;
      selectedUnifiedIndex = 0;
      el.hidden = false;
      el.innerHTML = renderResultWorkspace(all, view, -1);
      syncCommandBarActions();
      syncCommandBarLabels();
      return;
    }
    // Preserve the plan the reader is on across progressive updates, filter
    // changes and language switches by content key, not by array position.
    let index = resolveSelectedRowIndex(view, selectedEntryKey, selectedUnifiedIndex);
    if (index < 0) index = 0;
    selectedUnifiedIndex = index;
    selectedEntryKey = unifiedEntryKey(view[index]);
    planRenderLimit = Math.min(Math.max(PLAN_PAGE_SIZE, planRenderLimit), view.length);
    el.hidden = false;
    el.innerHTML = renderResultWorkspace(all, view, index);
  } finally {
    renderingUnifiedList = false;
  }
  restoreDetailDisclosure();
  syncCommandBarActions();
  syncCommandBarLabels();
}

// Re-render only the selection-dependent parts. Switching plans must keep the
// list DOM (and its scroll position) and every open accordion intact.
function applyPlanSelection() {
  for (const option of document.querySelectorAll("#planList .inventory-result-option")) {
    option.setAttribute("aria-selected", String(Number(option.dataset.planIndex) === selectedUnifiedIndex));
  }
  const selected = getSelectedUnifiedEntry();
  const detail = document.getElementById("loadoutDetail");
  if (detail) detail.innerHTML = renderSelectedLoadout(selected, selectedUnifiedIndex);
  restoreDetailDisclosure();
  syncCommandBarActions();
}

// The command bar owns every result-level action, so it must always describe
// the currently selected plan instead of a stale one.
function syncCommandBarActions() {
  const entry = getSelectedUnifiedEntry();
  const exportButton = document.getElementById("cmdExportDim");
  if (exportButton) {
    exportButton.disabled = !entry || entry.farmCount !== 0;
    exportButton.title = !entry
      ? ""
      : entry.farmCount > 0
        ? l("该方案还需刷取护甲，补齐后才能导出 DIM 链接", "該方案還需取得防具，補齊後才能匯出 DIM 連結", "This plan still needs farmed armor before a DIM link is usable")
        : "";
  }
  const equipButton = document.getElementById("cmdEquipButton");
  if (equipButton) {
    const equipState = entry?.kind === "inventory"
      ? getInventorySolutionEquipState(entry.witness)
      : { hidden: true };
    equipButton.hidden = Boolean(equipState.hidden) || entry?.kind !== "inventory";
    equipButton.disabled = !equipState.available;
    equipButton.title = equipState.reason || "";
  }
}


// Three totals answer three different questions, and the result page must not
// conflate them (handoff 3.7 / Phase D):
//   mathematicalTotals — what the Solver proved and the certificate is about:
//     every planned Tuning/armor mod in place, the armor masterworked, plus
//     fragments. It is rebuilt from the sealed witness, never from execution
//     reality, and it is the number the six-stat bars show.
//   projectedTotals — the same plan with the armor upgraded to Tier 5; equals
//     the mathematical result when the instances are already masterworked. It is
//     the bridge the execution layer is validated against.
//   installableTotals — the instance state AFTER the plan runs, under current
//     evidence. A queued write, an already-installed plug and a write that the
//     metadata merely cannot disprove all count. A write *proven* impossible is
//     not counted as the desired modifier — but it does not uninstall anything
//     either, so the modifier the piece already carries stays (a blocked
//     replacement is not a removal). Fragments are added exactly once, here, so
//     all three totals are directly comparable with the user's targets.
//
// The witness's own verified visible totals. Rebuilt from the sealed witness
// rather than trusted from storage, so a stale snapshot can never inflate the
// displayed numbers.
function getDisplayedFinalTotals(witness) {
  return createSolutionDisplayModel(witness).visibleTotals;
}

function addFragmentTotals(totals, fragments) {
  return Object.fromEntries(STATS.map(stat =>
    [stat, Number(totals?.[stat] || 0) + Number(fragments?.[stat] || 0)]));
}

function differingStats(left, right) {
  return STATS.filter(stat => Number(left?.[stat] || 0) !== Number(right?.[stat] || 0));
}

// Every preflight reason is classified by *evidence*, not by severity:
//   blocked.*    — known metadata proves the write cannot happen.
//   unverified.* — the metadata needed to judge the write is missing.
//   masterwork   — nothing is wrong, the armor simply is not upgraded yet.
// The distinction is what keeps "unknown" from being worded as "blocked".
//
// The blocked families come from the core (`summarizeBlockedReasons`) so the UI
// can never disagree with the preflight about what went wrong, and a BLOCKED
// plan always has at least one named family to show.
function classifyPreflight(entry, execution, { mathematical, installable, projected }) {
  const unassigned = execution?.unassignedMods || [];
  const unverifiedMods = execution?.unverifiedMods || [];
  const counts = execution?.blockedByCategory && typeof execution.blockedByCategory === "object"
    ? execution.blockedByCategory
    : summarizeBlockedReasons(unassigned);
  const blocked = {
    energy: Number(counts[EXECUTION_BLOCK_CATEGORY.ENERGY]) || 0,
    socket: Number(counts[EXECUTION_BLOCK_CATEGORY.SOCKET]) || 0,
    plug: Number(counts[EXECUTION_BLOCK_CATEGORY.PLUG]) || 0,
    tuning: Number(counts[EXECUTION_BLOCK_CATEGORY.TUNING]) || 0,
    instance: Number(counts[EXECUTION_BLOCK_CATEGORY.INSTANCE]) || 0,
    consistency: Number(counts[EXECUTION_BLOCK_CATEGORY.CONSISTENCY]) || 0,
  };
  blocked.total = blocked.energy + blocked.socket + blocked.plug
    + blocked.tuning + blocked.instance + blocked.consistency;
  // Distinct raw reasons, so the advanced panel can still be exact without the
  // reader having to guess which plug or socket was refused.
  blocked.reasons = [...new Set(unassigned.map(mod => mod?.reason).filter(Boolean))];
  const unverified = {
    // DIM CSV exports carry the exact roll but no socket capability at all.
    socket: unverifiedMods.filter(mod => mod.kind === "item" && mod.reason === "socketCapabilityUnknown").length,
    socketWrite: unverifiedMods.filter(mod => String(mod.reason).endsWith("SocketUnverified")
      || mod.reason === "candidateAvailabilityUnknown").length,
    energy: unverifiedMods.filter(mod => mod.reason === "energyUnknown").length,
    tuning: unverifiedMods.filter(mod => mod.reason === "tuningCapabilityUnknown").length,
  };
  unverified.total = unverified.socket + unverified.socketWrite + unverified.energy + unverified.tuning;
  const installableBelowMath = differingStats(mathematical, installable);
  // "The armor is not upgraded yet" is a witness fact, not a preflight verdict:
  // it stays true even when the same plan also carries unverified socket data.
  const pieces = entry?.witness?.pieces || entry?.pieces || [];
  return {
    status: execution?.executionStatus || null,
    blocked,
    unverified,
    installableBelowMath,
    mathematicalVsInstallable: installableBelowMath,
    mathematicalVsProjected: differingStats(mathematical, projected),
    masterworkPending: installableBelowMath.length > 0
      && pieces.some(piece => piece?.requiresMasterwork === true),
  };
}

function getEntryTotalsModel(entry) {
  const witness = entry?.witness || {};
  let mathematical;
  try {
    mathematical = getDisplayedFinalTotals(witness);
  } catch (error) {
    console.error("Mathematical totals rebuild failed", error);
    mathematical = witness.visibleTotals || witness.finalTotals || witness.totals || {};
  }
  const fragments = witness.fragments || {};
  // Execution evidence exists only for owned-inventory witnesses: a theory
  // skeleton has no live instance to preflight against.
  const execution = entry?.kind === "inventory" ? witness.execution : null;
  const structural = (execution?.unassignedMods || [])
    .filter(mod => mod.kind === "item" && mod.reason !== "witnessTotalsMismatch");
  const usableExecution = execution?.actualTotals && structural.length === 0
    && STATS.some(stat => Number(execution.actualTotals[stat] || 0) !== 0);
  const installable = usableExecution
    ? addFragmentTotals(execution.actualTotals, fragments)
    : mathematical;
  const projected = usableExecution && execution.projectedTotals
    ? addFragmentTotals(execution.projectedTotals, fragments)
    : mathematical;
  const model = {
    mathematical,
    projected,
    installable,
    // Raw preflight evidence; the *classified* view lives in classifyPreflight
    // (blocked / unverified / masterwork). There is deliberately no
    // `blockedMods` field any more: the previous one was read as "everything
    // preflight complained about, including unknown metadata", which is exactly
    // how a missing DIM socket ended up worded as a blocked mod.
    unverifiedMods: execution?.unverifiedMods || [],
  };
  return { ...model, ...classifyPreflight(entry, execution, model) };
}

// The six-stat bars show the Solver's mathematical result, never the
// installable subset: the "✓ 达标" marker comes from the certificate's
// statResults, so the number beside it must come from the same mathematical
// domain. Rendering `installable` here is what produced "10 / 20 ✓达标" for an
// exact plan whose certificate said 20.
function getUnifiedTotalsModel(entry) {
  return getEntryTotalsModel(entry);
}

function getUnifiedEntrySummary(entry) {
  const stats = entry.certificate?.statResults || {};
  const metCount = STATS.filter(stat => stats[stat]?.met).length;
  const requiredCount = lastInventoryRequiredStats.length;
  const requiredReachedCount = lastInventoryRequiredStats.filter(stat => stats[stat]?.met).length;
  return {metCount, requiredCount, requiredReachedCount, status: searchProofLabel(entry.witness, entry.search),
    feasible: entry.feasible};
}

function safeWitnessBreakdown(witness) {
  try {
    return renderWitnessBreakdown(witness);
  } catch (error) {
    console.error("Witness breakdown failed", error);
    return "";
  }
}

// A plan row carries at most three facts: which Armor Archetypes it needs, how
// much armor is already owned, and one state marker. The formal proof wording
// lives in a tooltip and in the advanced panel, so fifty identical
// "已证明" lines never stack up in the list.
function getEntryStateBadge(entry) {
  if (entry.feasible === true) {
    return {
      tone: "is-met",
      label: "",
      title: l("数学结果已验证", "數學結果已驗證", "Mathematically verified"),
    };
  }
  if (entry.ruleFeasible === true && entry.planFeasible === false) {
    return {
      tone: "is-blocked",
      label: l("不可实施", "無法實施", "Unmappable"),
      title: l(
        "属性规则达标，但套装要求或库存来源无法实现该方案",
        "數值規則達標，但套裝要求或庫存來源無法實現該方案",
        "The stat rules are met, but the set requirement or owned/farm mapping cannot implement this plan",
      ),
    };
  }
  if (entry.search?.running === true) {
    return {
      tone: "is-pending",
      label: l("搜索未完成", "搜尋未完成", "Search incomplete"),
      title: searchProofLabel(entry.witness, entry.search),
    };
  }
  return {
    tone: "is-short",
    label: l("未达标", "未達標", "Not qualifying"),
    title: searchProofLabel(entry.witness, entry.search),
  };
}

// Which Armor Archetypes the five pieces need, in one short line. Both entry
// kinds answer it the same way so a row never depends on which search produced
// it.
function getEntryArchetypeSummary(entry) {
  const counts = new Map();
  for (const piece of entry.pieces || []) {
    if (piece?.exotic) continue;
    const key = piece?.archetypeId || piece?.archetype || piece?.item?.archetypeId;
    const id = normalizeArchetypeId(key) || key;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .map(([id, count]) => `${getArchetypeLabel(id)}×${count}`)
    .join(" · ");
}

function renderPlanRow(entry, index) {
  const { metCount } = getUnifiedEntrySummary(entry);
  const state = getEntryStateBadge(entry);
  const archetypeKey = getEntryArchetypeSummary(entry);
  const ownedLabel = entry.farmCount === 0
    ? l("已有 5/5", "已有 5/5", "5/5 owned")
    : l(
      `已有 ${entry.ownedCount}/5 · 待刷 ${entry.farmCount}`,
      `已有 ${entry.ownedCount}/5 · 待取得 ${entry.farmCount}`,
      `${entry.ownedCount}/5 owned · ${entry.farmCount} to farm`,
    );
  const meta = `${metCount}/6 ${l("达标", "達標", "met")} · ${ownedLabel}${entry.exact
    ? ` · ${l("精确", "精確", "exact")}` : ""}`;
  return `
    <button type="button" class="inventory-result-option ${entry.current ? "is-current" : ""}"
      role="option" aria-selected="${index === selectedUnifiedIndex}" data-plan-index="${index}"
      data-plan-key="${escapeHtml(unifiedEntryKey(entry))}" onclick="selectInventorySolution(${index})">
      <span class="inventory-result-rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="inventory-result-option-copy">
        <strong class="inventory-result-option-title">${escapeHtml(archetypeKey || l("任意护甲框架", "任意防具原型", "Any Armor Archetype"))}</strong>
        <small class="inventory-result-option-meta">${escapeHtml(meta)}</small>
      </span>
      ${entry.current ? `<span class="inventory-result-current">${l("当前", "目前", "Current")}</span>` : ""}
      <span class="inventory-result-state ${state.tone}" title="${escapeHtml(state.title)}"
        data-proof-label="${escapeHtml(state.title)}">${state.label ? escapeHtml(state.label) : icon("check", { size: "sm" })}</span>
    </button>`;
}

function renderInventoryBungieEquip(entry, index) {
  const equipState = getInventorySolutionEquipState(entry);
  if (equipState.hidden) return "";
  const targetOptions = getBungieTargetOptionsHtml();
  const hint = equipState.reason || l(
    "自检通过。将自动转移并穿戴五件护甲、写入全部模组，并在写入后回读核对；保持目标角色当前的分支职业、星相与碎片。请先确保角色在轨道、社交空间或离线。",
    "自檢通過。將自動轉移並穿著五件防具、寫入全部模組，並在寫入後回讀核對；保持目標角色目前的副職業、相位與碎片。請先確保角色在軌道、社交空間或離線。",
    "Preflight passed. The app will transfer and equip all five armor pieces, insert every mod, then re-read and verify; it preserves the target character's current subclass, Aspects, and Fragments. Make sure the character is in orbit, a social space, or offline.",
  );
  return `<section class="bungie-equip-panel" aria-labelledby="bungieEquipTitle">
    <div class="bungie-equip-copy">
      <span class="inventory-result-detail-label" id="bungieEquipTitle">${l("Bungie 直装", "Bungie 直裝", "Direct Bungie equip")}</span>
      <strong>${l("装备到游戏", "裝備到遊戲", "Equip in game")}</strong>
    </div>
    <div class="bungie-equip-controls">
      <label>
        <span>${l("目标角色", "目標角色", "Target character")}</span>
        <select class="bungie-target-select" onchange="setBungieTargetCharacter(this.value)" ${targetOptions && !isBungieApplying ? "" : "disabled"}>${targetOptions}</select>
      </label>
      <button id="bungieEquipButton" type="button" class="btn-solve" onclick="equipInventorySolution(${index})" ${equipState.available ? "" : "disabled"}>${icon("check")}${isBungieApplying
        ? l("正在装备…", "正在裝備…", "Applying…")
        : l("装备到游戏", "裝備到遊戲", "Equip in game")}</button>
    </div>
    <p class="bungie-equip-hint ${equipState.available ? "" : "is-blocked"}">${escapeHtml(hint)}</p>
    <div id="bungieEquipStatus" class="bungie-equip-status" aria-live="polite"></div>
  </section>`;
}

// --- Entry piece projection ------------------------------------------------
// Every result-page renderer used to read `entry.pieces` positionally and look
// its Tuning / armor-mod assignment up with that same array index. A theoretical
// plan stores its pieces in *Solver config order* — the Exotic Class Item may be
// config index 0 — so the array position was never the slot. Any renderer that
// sorted the five rows to fix the display order therefore pointed
// `modAssignments[i]` at the wrong armor.
//
// This projection keeps the two index spaces apart permanently:
//
//   Solver config index ──┬─ assignmentIndex → addresses Tuning/mod assignments
//                         └─ displayOrder    → the only thing UI sorting touches
//
// One fact, normalized once. The five-piece table, the acquisition plan and any
// future per-piece surface all consume these rows instead of re-deriving them.
function resolvePieceAssignmentIndex(piece, arrayIndex) {
  const index = Number(piece?.index);
  return Number.isInteger(index) && index >= 0 && index < UPGRADE_SLOTS.length
    ? index
    : arrayIndex;
}

function createEntryPieceRows(entry) {
  const pieces = Array.isArray(entry?.pieces) ? entry.pieces : [];
  const tuningAssignments = entry?.tuningAssignments || [];
  const modAssignments = entry?.modAssignments || [];
  const rows = pieces.map((piece, arrayIndex) => {
    const assignmentIndex = resolvePieceAssignmentIndex(piece, arrayIndex);
    const slot = piece?.slot
      || UPGRADE_SLOTS[assignmentIndex]?.id
      || UPGRADE_SLOTS[arrayIndex]?.id
      || UPGRADE_SLOTS[0].id;
    const slotIndex = Math.max(0, UPGRADE_SLOTS.findIndex(definition => definition.id === slot));
    // An inventory witness keeps its concrete instance on the piece itself; a
    // theoretical plan stores the matched owned instance under `piece.item`.
    const ownedItem = entry.kind === "inventory" ? piece : piece?.item || null;
    const isOwned = Boolean(ownedItem);
    const setHash = entry.kind === "inventory"
      ? piece?.setHash ?? null
      : ownedItem?.setHash ?? piece?.farmSetHash ?? null;
    const farmSetHash = piece?.farmSetHash ?? null;
    return {
      piece,
      kind: entry.kind,
      // Solver identity. Never derived from a position that UI sorting can move.
      assignmentIndex,
      // Presentation only, derived from the slot, never from the config order.
      displayOrder: slotIndex,
      slot,
      slotIndex,
      isOwned,
      isFarm: !isOwned,
      isExotic: Boolean(piece?.exotic),
      ownedItem,
      itemName: isOwned ? (ownedItem.itemName || ownedItem.name || null) : null,
      setHash,
      set: setHash ? getArmorSetByHash(setHash) : null,
      archetypeKey: piece?.archetypeId || piece?.archetype || ownedItem?.archetypeId || null,
      tertiary: piece?.tertiary || ownedItem?.tertiary || null,
      baseStats: piece?.baseStats || null,
      // Solver assignment state, addressed by assignmentIndex only.
      tuningAssignment: tuningAssignments[assignmentIndex] || null,
      armorModAssignment: modAssignments[assignmentIndex] || null,
      // What the drop itself must roll. The +5 side of a Legendary Tuning mod is
      // fixed by the item; it is not a free choice the player makes later.
      intrinsicTuningMode: piece?.tuningMode === "plus3" ? "plus3" : "shift",
      intrinsicTuningTo: piece?.tuningTo || null,
      // Acquisition-only facts, available when the piece has no owned instance.
      farmSetHash,
      closestItem: piece?.closestItem || null,
      closestMismatch: piece?.closestMismatch || null,
    };
  });
  // Sorting is a display concern. `displayOrder` comes from the slot and
  // `assignmentIndex` travels with each row, so reordering the table can never
  // desynchronize a piece from its Tuning mod or armor mod.
  return rows.sort((left, right) =>
    left.displayOrder - right.displayOrder || left.assignmentIndex - right.assignmentIndex);
}

// --- Five-piece armor table ------------------------------------------------
// Slot, item, archetype, tertiary stat, Tuning mod, armor mod and ownership
// state used to live in four separate sections. They answer one question ("what
// does this piece need?") so they are one row now.

function formatTuningCell(assignment) {
  if (!assignment || assignment.mode === "none") return "—";
  if (assignment.mode === "+3") return l("+3 均衡", "+3 均衡", "+3 Balanced");
  return `+5 ${STAT_LABELS[assignment.to]} / -5 ${STAT_LABELS[assignment.from]}`;
}

function formatArmorModCell(assignment) {
  return assignment ? `+${assignment.size} ${STAT_LABELS[assignment.stat]}` : "—";
}

function renderOwnedPieceBungieAction(ownedItem) {
  return ownedItem ? renderOwnedArmorBungieAction(ownedItem) : "";
}

// `固有调整` is the direction rolled onto the drop; `最终调整` is what the player
// configures once it is acquired. A missing piece still has a plan — it simply
// has no execution preflight — so both are shown for farm rows too.
function formatIntrinsicTuning(row) {
  if (row.intrinsicTuningMode === "plus3") return l("+3 均衡", "+3 均衡", "+3 Balanced");
  if (!row.intrinsicTuningTo) return "—";
  return `+5 ${STAT_LABELS[row.intrinsicTuningTo]}`;
}

function formatFinalMinusTuning(row) {
  const assignment = row.tuningAssignment;
  if (assignment?.mode === "+5-5" && assignment.from) return `-5 ${STAT_LABELS[assignment.from]}`;
  if (row.intrinsicTuningMode === "plus3" || assignment?.mode === "+3") {
    return l("+3 均衡", "+3 均衡", "+3 Balanced");
  }
  return "—";
}

function describeFarmSource(row) {
  if (row.isExotic) return l("异域", "異域", "Exotic");
  if (row.farmSetHash) {
    return `${formatInventoryPlanSet(row.farmSetHash)}${l("套装", "套裝", " set")}`;
  }
  return l("任意来源", "任意來源", "any source");
}

function renderArmorRow(row, entry) {
  const { piece } = row;
  const setBadge = row.set
    ? `<span class="upgrade-set-badge">${escapeHtml(getSetName(row.set))}</span>`
    : "";
  const name = row.isOwned
    ? (row.itemName || l("已有护甲", "已有防具", "Owned armor"))
    : l("待刷取", "待取得", "Farm");
  // A farm piece is a plan, not an instance. It has no execution preflight, but
  // the Solver still computed the Tuning and armor mods it will need, so hiding
  // them behind "—" threw away the only actionable configuration the row had.
  const tuningCell = formatTuningCell(row.tuningAssignment);
  const modCell = formatArmorModCell(row.armorModAssignment);
  // Mark planned-only socket state explicitly, so a planned +10 is never read
  // as an installed one.
  const plannedFlag = row.isFarm && row.armorModAssignment
    ? `<small class="armor-cell-flag" title="${escapeHtml(l(
      "该模组属于方案配置，护甲尚未获得，无法验证实例",
      "該模組屬於方案配置，防具尚未取得，無法驗證實例",
      "Planned configuration: the armor is not owned yet, so the instance cannot be verified",
    ))}">${l("计划", "計畫", "Planned")}</small>`
    : "";
  // A theoretical skeleton whose piece is already owned must say whether the
  // installed Tuning mod matches the plan, not just what the plan wants.
  const requirementNote = entry?.kind === "theory" && row.ownedItem
    ? renderOwnedPieceRequirement(piece)
    : "";
  const stateCell = row.isOwned
    ? `<span class="armor-state is-owned">${icon("check", { size: "sm" })}${l("已有", "已有", "Owned")}</span>`
    : `<span class="armor-state is-farm">${escapeHtml(`${l("待刷", "待取得", "Farm")} · ${describeFarmSource(row)}`)}</span>`;
  // Armor registered by hand is indistinguishable from imported armor once it is
  // in the pool; keep the provenance visible so a manual entry can be audited.
  const sourceTag = row.isOwned && row.ownedItem?.manualOwned
    ? `<span class="owned-armor-source is-manual">${l("手动", "手動", "Manual")}</span>`
    : "";
  const badge = piece?.locked
    ? `<span class="inventory-fixed-badge">${icon("lock", { size: "sm" })}${row.isExotic
      ? l("异域固定", "異域固定", "Fixed Exotic")
      : l("固定保留", "固定保留", "Fixed")}</span>`
    : (!row.isOwned && row.isExotic
      ? `<span class="inventory-fixed-badge">${icon("lock", { size: "sm" })}${l("需异域护甲", "需異域防具", "Exotic needed")}</span>`
      : "");
  return `<div class="inventory-result-piece ${row.isOwned ? "is-owned" : "is-farm"}"
    role="row" data-piece-slot="${escapeHtml(row.slot)}" data-assignment-index="${row.assignmentIndex}"
    data-ownership="${row.isOwned ? "owned" : "farm"}">
    <span class="inventory-result-piece-slot">${getUpgradeSlotLabel(row.slotIndex)}</span>
    <span class="inventory-result-piece-name">${escapeHtml(name)}${setBadge}</span>
    <span class="armor-cell armor-archetype">${row.archetypeKey ? escapeHtml(getArchetypeLabel(row.archetypeKey)) : "—"}</span>
    <span class="armor-cell armor-tertiary"${row.tertiary ? ` style="color:${STAT_COLORS[row.tertiary]}"` : ""}>${row.tertiary ? escapeHtml(STAT_LABELS[row.tertiary]) : "—"}</span>
    <span class="armor-cell armor-tuning">${escapeHtml(tuningCell)}${requirementNote}</span>
    <span class="armor-cell armor-mod">${escapeHtml(modCell)}${plannedFlag}</span>
    <span class="armor-cell armor-state-cell">${stateCell}${sourceTag}${badge}${row.isOwned ? renderOwnedPieceBungieAction(row.ownedItem) : ""}</span>
  </div>`;
}

function renderArmorLoadoutTable(rows, entry) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return `<div class="armor-table" role="table" aria-label="${l("五件护甲明细", "五件防具明細", "Five-piece armor detail")}">
    <div class="armor-table-head" role="row">
      <span role="columnheader">${l("槽位", "部位", "Slot")}</span>
      <span role="columnheader">${l("护甲", "防具", "Armor")}</span>
      <span role="columnheader">${t("armorArchetype")}</span>
      <span role="columnheader">${t("tertiaryStat")}</span>
      <span role="columnheader">${t("tuningMod")}</span>
      <span role="columnheader">${t("armorMod")}</span>
      <span role="columnheader">${l("状态", "狀態", "State")}</span>
    </div>
    <div class="inventory-result-pieces" role="rowgroup">
      ${rows.map(row => renderArmorRow(row, entry)).join("")}
    </div>
  </div>`;
}

// Exotic Class Items are the only Exotics named after their class (Relativism /
// Stoicism / Solipsism). Every other Exotic keeps its own item name, so the
// decision is made by SLOT and never by "is this piece exotic".
function resolveExoticPieceLabel(piece, { classItemName = null, fallbackName = null } = {}) {
  if (piece?.slot === "classItem") {
    return classItemName || fallbackName || l("异域职业物品", "異域職業物品", "Exotic Class Item");
  }
  return piece?.item?.name || piece?.itemName || fallbackName || l("异域护甲", "異域防具", "Exotic Armor");
}

function getFarmExoticLabel(piece) {
  const isClassItem = piece?.slot === "classItem";
  const classItemSettings = isClassItem && document.getElementById("useExoticMode")?.checked
    ? getExoticSettings()
    : null;
  const fixedExotic = getSelectedInventoryExotic();
  const fallbackName = fixedExotic && fixedExotic.slot === piece?.slot ? fixedExotic.name : null;
  return resolveExoticPieceLabel(piece, {
    classItemName: isClassItem
      ? getExoticClassItemName(classItemSettings?.classId || importClassFilter || "hunter")
      : null,
    fallbackName,
  });
}

// A row's Exotic label is derived from the row's SLOT, never from a bare
// `piece.exotic` flag: only a class-item Exotic may take a class-item name
// (Relativism / Stoicism / Solipsism), and a helmet/arms/chest/legs Exotic must
// never borrow one. Farm Legendary class items never reach this at all.
function resolveRowExoticLabel(row) {
  return row.isExotic ? getFarmExoticLabel(row.piece) : null;
}

// --- Acquisition plan ------------------------------------------------------
// The five-piece table answers "what is the final loadout?". This section
// answers the only other question a farm gap raises: "what am I missing, and
// how do I get it?". It lists missing pieces only and never restates the table
// row for row, so the two sections cannot drift or repeat each other.
//
// The archetype tally here covers *missing* pieces only. The plan-list row keeps
// the whole-loadout tally, which is the right summary for comparing plans; it
// would be wrong under "待刷 N 件", where the counts must not exceed N.
function getMissingArchetypeSummary(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.isOwned || row.isExotic) continue;
    const id = normalizeArchetypeId(row.archetypeKey) || row.archetypeKey;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .map(([id, count]) => `${getArchetypeLabel(id)}×${count}`)
    .join(" · ");
}

function renderAcquisitionField(label, value, { style = "", className = "" } = {}) {
  return `<span class="acquisition-field">
    <span class="acquisition-field-label">${escapeHtml(label)}</span>
    <span class="acquisition-field-value${className ? ` ${className}` : ""}"${style ? ` style="${style}"` : ""}>${escapeHtml(value)}</span>
  </span>`;
}

// "Why can I not just use the copy already in my vault?" Every field shown here
// comes from evidence the Inventory Planner already produced. When its mismatch
// structure does not name concrete differences, only the neutral notice is
// shown — the UI never guesses at a reason it cannot prove.
function renderClosestOwnedComparison(row, key) {
  const item = row.closestItem;
  if (!item) return "";
  const fieldLabels = {
    archetype: l("框架不匹配", "原型不符", "Archetype differs"),
    tertiary: l("第三属性不匹配", "第三數值不符", "Tertiary stat differs"),
    tuningCapability: l("固有 +5 方向不匹配", "固有 +5 方向不符", "Intrinsic +5 differs"),
  };
  const fields = Array.isArray(row.closestMismatch?.fields) ? row.closestMismatch.fields : [];
  const ownedTuning = item.tunedStat || item.tuningTo || null;
  const owned = [
    item.archetypeId ? getArchetypeLabel(item.archetypeId) : null,
    item.tertiary ? STAT_LABELS[item.tertiary] : null,
    ownedTuning ? `+5 ${STAT_LABELS[ownedTuning]}` : null,
  ].filter(Boolean).join(" / ");
  const target = [
    row.archetypeKey ? getArchetypeLabel(row.archetypeKey) : null,
    row.tertiary ? STAT_LABELS[row.tertiary] : null,
    row.intrinsicTuningTo ? `+5 ${STAT_LABELS[row.intrinsicTuningTo]}` : null,
  ].filter(Boolean).join(" / ");
  const differences = fields.map(field => fieldLabels[field]).filter(Boolean);
  return `<details class="acquisition-sub" data-disclosure-key="acquisition-compare-${key}">
    <summary>${l("查看差异", "查看差異", "Compare")}</summary>
    <div class="acquisition-compare">
      <div class="acquisition-compare-row"><span>${l("已有", "已有", "Owned")}</span><strong>${escapeHtml(owned || "—")}</strong></div>
      <div class="acquisition-compare-row"><span>${l("目标", "目標", "Target")}</span><strong>${escapeHtml(target || "—")}</strong></div>
      ${differences.length
        ? `<div class="acquisition-compare-row is-differ"><span>${l("差异", "差異", "Differs")}</span><strong>${escapeHtml(differences.join(" · "))}</strong></div>`
        : ""}
    </div>
  </details>`;
}

function renderAcquisitionRow(row, position) {
  const slotLabel = getUpgradeSlotLabel(row.slotIndex);
  const exoticLabel = resolveRowExoticLabel(row);
  const setName = row.farmSetHash ? formatInventoryPlanSet(row.farmSetHash) : null;
  // The identity line doubles as the "where does it come from" answer, exactly
  // as the five-piece table's name cell carries the item identity.
  const targetLabel = exoticLabel
    || (setName ? `${setName}${l("套装", "套裝", " set")}` : l("任意来源", "任意來源", "any source"));
  const badges = [
    `<span class="acquisition-badge is-farm">${l("待刷", "待取得", "Farm")}</span>`,
    row.isExotic ? `<span class="acquisition-badge is-exotic">${l("异域", "異域", "Exotic")}</span>` : "",
    row.farmSetHash ? `<span class="acquisition-badge is-set">${l("套装要求", "套裝要求", "Set required")}</span>` : "",
  ].filter(Boolean).join("");
  const key = `${row.slot}-${row.assignmentIndex}`;
  const fields = [
    renderAcquisitionField(t("armorArchetype"),
      row.archetypeKey ? getArchetypeLabel(row.archetypeKey) : "—", { className: "is-archetype" }),
    renderAcquisitionField(t("tertiaryStat"), row.tertiary ? STAT_LABELS[row.tertiary] : "—",
      { style: `color:${STAT_COLORS[row.tertiary] || "inherit"}` }),
    renderAcquisitionField(l("固有调整", "固有調校", "Intrinsic roll"), formatIntrinsicTuning(row)),
    renderAcquisitionField(l("最终调整", "最終調校", "Final tuning"), formatFinalMinusTuning(row)),
    renderAcquisitionField(t("armorMod"), formatArmorModCell(row.armorModAssignment), { className: "is-numeric" }),
  ].join("");
  const templateDetail = row.baseStats
    ? `<details class="acquisition-sub" data-disclosure-key="acquisition-template-${key}">
        <summary>${l("精确属性模板", "精確屬性模板", "Exact stat template")}</summary>
        <div class="acquisition-template">${STATS.map(stat =>
          `<span class="acquisition-template-stat" style="color:${STAT_COLORS[stat]}">${icon(stat)}<span class="acquisition-template-label">${STAT_LABELS[stat]}</span><strong>${Number(row.baseStats[stat] || 0)}</strong></span>`).join("")}</div>
        <p class="acquisition-note">${l(
          "这是该护甲需要满足的固有分布模板，用于确认刷取方向；实际掉落的六维必须与此一致。",
          "這是該防具需滿足的固有分布模板，用於確認取得方向；實際掉落的六維必須與此一致。",
          "The intrinsic distribution this drop has to match. The rolled six stats must agree with it.",
        )}</p>
      </details>`
    : "";
  const closestNotice = row.closestItem
    ? `<p class="acquisition-notice">${l(
      "△ 已有相近护甲，但不满足该方案要求",
      "△ 已有相近防具，但不符合本方案要求",
      "△ A similar piece is owned but does not satisfy this plan",
    )}</p>`
    : "";
  return `<li class="acquisition-row" data-slot="${escapeHtml(row.slot)}" data-assignment-index="${row.assignmentIndex}" data-exotic="${row.isExotic}">
    <div class="acquisition-row-head">
      <span class="acquisition-index">${String(position).padStart(2, "0")}</span>
      <span class="acquisition-slot">${escapeHtml(slotLabel)}</span>
      <span class="acquisition-target">${escapeHtml(targetLabel)}</span>
      <span class="acquisition-badges">${badges}</span>
    </div>
    <div class="acquisition-grid">${fields}</div>
    ${templateDetail}
    ${closestNotice}
    ${renderClosestOwnedComparison(row, key)}
  </li>`;
}

// Fully owned plans get no acquisition panel at all: the loadout header already
// states "五件已有齐全", so an empty farm section would only add noise.
function renderAcquisitionPlan(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const missing = rows.filter(row => row.isFarm);
  if (missing.length === 0) return "";
  const requirement = lastInventoryResult?.requirement || snapshotSetRequirement();
  const requirementLabel = !requirement || requirement.type === "none"
    ? l("无套装要求", "無套裝要求", "No set requirement")
    : formatSetRequirementLabel(requirement);
  const missingArchetype = getMissingArchetypeSummary(rows);
  const missingExotic = missing.find(row => row.isExotic);
  const exoticLabel = missingExotic
    ? [resolveRowExoticLabel(missingExotic),
      missingExotic.archetypeKey ? getArchetypeLabel(missingExotic.archetypeKey) : null]
      .filter(Boolean).join(" · ")
    : "";
  const constraints = [
    `<div class="acquisition-constraint-row"><span>${l("套装要求", "套裝要求", "Set requirement")}</span><strong>${escapeHtml(requirementLabel)}</strong></div>`,
    missingArchetype
      ? `<div class="acquisition-constraint-row"><span>${l("待刷框架", "待取得原型", "Missing archetypes")}</span><strong>${escapeHtml(missingArchetype)}</strong></div>`
      : "",
    exoticLabel
      ? `<div class="acquisition-constraint-row"><span>${t("exoticArmor")}</span><strong>${escapeHtml(exoticLabel)}</strong></div>`
      : "",
  ].filter(Boolean).join("");
  return `<section class="acquisition-plan" aria-labelledby="acquisitionPlanTitle">
    <div class="acquisition-head">
      <h3 class="acquisition-title" id="acquisitionPlanTitle">${l("刷取计划", "取得計畫", "Acquisition Plan")}</h3>
      <span class="acquisition-count">${l(
        `待刷 ${missing.length} 件 · 已有 ${rows.length - missing.length}/${rows.length}`,
        `待取得 ${missing.length} 件 · 已有 ${rows.length - missing.length}/${rows.length}`,
        `${missing.length} to farm · ${rows.length - missing.length}/${rows.length} owned`,
      )}</span>
    </div>
    <ol class="acquisition-list">
      ${missing.map((row, index) => renderAcquisitionRow(row, index + 1)).join("")}
    </ol>
    <div class="acquisition-constraints" role="group" aria-label="${l("方案约束", "方案限制", "Plan constraints")}">
      <span class="acquisition-constraints-title">${l("方案约束", "方案限制", "Plan constraints")}</span>
      ${constraints}
    </div>
  </section>`;
}

// --- Selected loadout ------------------------------------------------------

function renderStatsSummary(entry, finalTotals) {
  const targets = lastInventoryTargets || lastTargets || {};
  const statResults = entry.certificate?.statResults || {};
  return `<div class="inventory-result-stats" role="list">
    ${STATS.map(stat => {
      const actual = finalTotals[stat] || 0;
      const target = targets[stat] || 0;
      const result = statResults[stat];
      const met = result?.met === true;
      const isRequired = lastInventoryRequiredStats.includes(stat);
      // Rule-aware wording first (超上限 / 差 N); the raw delta is only a
      // fallback for witnesses that carry no stat result.
      const shortText = met ? "" : (upgradeStatShortText(stat, entry.witness) || `${actual - target}`);
      return `<div class="inventory-result-stat ${met ? "is-met" : "is-short"} ${isRequired ? "is-required" : ""}" role="listitem">
        <span style="color:${STAT_COLORS[stat]}">${icon(stat)}${STAT_LABELS[stat]}</span>
        <strong>${actual}<em>/${target}</em></strong>
        <small>${isRequired ? `${l("必须", "必須", "Must")} · ` : ""}${met
          ? `${icon("check", { size: "sm" })}${l("达标", "達標", "met")}`
          : escapeHtml(shortText)}</small>
      </div>`;
    }).join("")}
  </div>`;
}

// Per-piece stat/mod allocation for the advanced panel. Extracted from the old
// solution-details renderer; the copy and classes are unchanged so the
// allocation contract stays readable.
function renderAllocationBreakdown(result) {
  if (!result?.config || !result.tuningAssignments || !result.modAssignments) return "";
  const archCount = {};
  const tertCount = {};
  const tuneFromCount = {};
  const tuneToCount = {};
  const modCount = {};
  for (let index = 0; index < 5; index++) {
    if (index !== result.exoticIndex) {
      const config = result.config[index];
      archCount[config.archetype] = (archCount[config.archetype] || 0) + 1;
      tertCount[config.tertiary] = (tertCount[config.tertiary] || 0) + 1;
    }
    const tuning = result.tuningAssignments[index];
    if (tuning && tuning.mode !== "+3") {
      tuneFromCount[tuning.from] = (tuneFromCount[tuning.from] || 0) + 1;
      tuneToCount[tuning.to] = (tuneToCount[tuning.to] || 0) + 1;
    }
    const armorMod = result.modAssignments[index];
    if (armorMod) {
      const key = `${armorMod.stat}|${armorMod.size}`;
      modCount[key] = (modCount[key] || 0) + 1;
    }
  }
  const plus3Count = result.tuningAssignments.filter(assignment => assignment.mode === "+3").length;
  const exoticConfig = result.exoticIndex !== null && result.exoticIndex !== undefined
    ? result.config[result.exoticIndex]
    : null;
  const exoticSummary = exoticConfig
    ? `<div class="solution-exotic-summary">
        <strong>${t("exoticClassItem")}</strong>
        <span>${getArchetypeLabel(exoticConfig.archetype)} · ${t("primaryStat")} ${STAT_LABELS[exoticConfig.primary]} 30 / ${t("secondaryStat")} ${STAT_LABELS[exoticConfig.secondary]} 25 / ${t("tertiaryStat")} ${STAT_LABELS[exoticConfig.tertiary]} 20</span>
      </div>`
    : "";
  const fixedTuningRows = Object.keys(tuneToCount).length > 0
    ? renderSolutionStatRows(tuneToCount, "+5 ")
    : `<p class="solution-allocation-empty">${l("本方案没有 +5 调整。", "本方案沒有 +5 調校。", "This solution has no +5 Tuning.")}</p>`;
  const suggestedMinusRows = Object.keys(tuneFromCount).length > 0
    ? renderSolutionStatRows(tuneFromCount, "−5 ")
    : `<p class="solution-allocation-empty">${l("无需分配 −5。", "無需分配 −5。", "No −5 allocation needed.")}</p>`;
  const armorModRows = Object.entries(modCount).map(([key, count]) => {
    const [stat, size] = key.split("|");
    return `<div class="solution-stat-row"><span style="color:${STAT_COLORS[stat]};">+${size} ${STAT_LABELS[stat]}</span><strong>×${count}</strong></div>`;
  }).join("") || `<p class="solution-allocation-empty">${l("无", "無", "None")}</p>`;
  return `<div class="solution-allocation-grid">
    <div class="solution-allocation-group">
      <div class="solution-allocation-title"><strong>${t("tertiaryStat")}</strong><span>${l("装备固定 20", "裝備固定 20", "Fixed roll · 20")}</span></div>
      <div class="solution-stat-list">${renderSolutionStatRows(tertCount)}</div>
      <div class="solution-stat-list solution-archetype-list">${Object.entries(archCount).map(([name, count]) =>
        `<div class="solution-archetype-row"><span>${getArchetypeLabel(name)}</span><strong>×${count}</strong></div>`).join("")}</div>
    </div>
    <div class="solution-allocation-group solution-tuning-group">
      <div class="solution-allocation-title"><strong>${t("tuningMod")}</strong><span>${l("传说 +5 固定；异域按可选方向配置", "傳說 +5 固定；異域依可選方向配置", "Legendary +5 is fixed; configure supported Exotic directions")}</span></div>
      <div class="solution-tuning-primary">
        <span>${l("方案 +5 分配", "方案 +5 分配", "Planned +5 allocation")}</span>
        <div class="solution-stat-list">${fixedTuningRows}</div>
      </div>
      ${plus3Count > 0 ? `<div class="solution-tuning-plus3"><span>${l("+3模式", "+3模式", "+3 mode")}</span><strong>×${plus3Count}</strong></div>` : ""}
      <div class="solution-tuning-secondary">
        <span>${l("建议 −5 分配（可自由选择）", "建議 −5 分配（可自由選擇）", "Suggested -5 allocation (freely selected)")}</span>
        <div class="solution-stat-list">${suggestedMinusRows}</div>
      </div>
    </div>
    <div class="solution-allocation-group">
      <div class="solution-allocation-title"><strong>${t("armorMod")}</strong><span>${l("玩家安装", "玩家安裝", "Player-installed")}</span></div>
      <div class="solution-stat-list">${armorModRows}</div>
    </div>
  </div>${exoticSummary}`;
}

// Everything here is diagnostic: proofs, canonical identity, search counters and
// the per-piece recomputation. It stays collapsed so the first screen answers
// "which loadout, how many owned" instead of "what did the solver prove".
function renderAdvancedDetails(entry, totals = null) {
  const witness = entry.witness || {};
  const certificate = witness.certificate || {};
  // Search metadata lives on the result collection. Entry construction gathers
  // it into `entry.search`, so this panel never has to guess between
  // witness.search, plan.solution.search and a bare search object.
  const search = entry.search || witness.search || null;
  const coverage = search?.coverage || {};
  const proofLabel = searchProofLabel(witness, search);
  const canonicalId = witness.canonicalId || entry.plan?.solution?.canonicalId || "—";
  const searchStats = search
    ? [
      `${Math.round(search.elapsedMs || 0)} ms`,
      `${Number(search.nodes || 0).toLocaleString()} ${l("节点", "節點", "nodes")}`,
      coverage.statesExamined !== undefined
        ? `statesExamined=${Number(coverage.statesExamined).toLocaleString()}` : "",
      search.termination ? `${l("终止原因", "終止原因", "termination")}=${search.termination}` : "",
      coverage.frontierComplete !== undefined ? `frontierComplete=${String(coverage.frontierComplete)}` : "",
      coverage.assignmentComplete !== undefined ? `assignmentComplete=${String(coverage.assignmentComplete)}` : "",
      coverage.complete !== undefined ? `complete=${String(coverage.complete)}` : "",
      search.running !== undefined ? `running=${String(search.running)}` : "",
    ].filter(Boolean).join(" · ")
    : "—";
  // The preflight verdict is worded by evidence class first and by raw code
  // second, so "UNVERIFIED" can never be read as "confirmed installable" and a
  // BLOCKED plan always says there is a confirmed obstacle.
  const preflightCode = entry.kind === "inventory"
    ? (witness.executionStatus || null)
    : null;
  const preflightWords = {
    [EXECUTION_STATUS.VERIFIED]: l("可执行", "可執行", "Executable"),
    [EXECUTION_STATUS.UNVERIFIED]: l("尚未完全验证（按当前证据估算）", "尚未完全驗證（依目前證據估算）", "Not fully verified (estimated from current evidence)"),
    [EXECUTION_STATUS.BLOCKED]: l("已确认存在执行阻碍", "已確認存在執行阻礙", "A confirmed execution obstacle exists"),
  };
  const preflight = entry.kind === "inventory"
    ? `${preflightWords[preflightCode] || l("未标注", "未標示", "Not reported")}${preflightCode ? `（${preflightCode}）` : ""}`
    : (entry.planFeasible ? l("理论方案：无实例可预检", "理論方案：無實例可預檢", "Theoretical plan: no instance to preflight")
      : l("不可实施：套装或库存映射不可达", "無法實施：套裝或庫存映射不可達", "Unmappable: the set/owned mapping cannot reach it"));
  const totalsModel = totals || getUnifiedTotalsModel(entry);
  const totalsRows = STATS.map(stat => {
    const mathematical = Number(totalsModel.mathematical[stat] || 0);
    const installable = Number(totalsModel.installable[stat] || 0);
    const projected = Number(totalsModel.projected[stat] || 0);
    return `<span class="advanced-totals-row"><em style="color:${STAT_COLORS[stat]}">${STAT_LABELS[stat]}</em>`
      + `<span>${l("数学", "數學", "math")} ${mathematical}</span>`
      + `<span class="${projected === mathematical ? "" : "is-blocked"}">${l("升级后", "升級後", "projected")} ${projected}</span>`
      + `<span class="${installable === mathematical ? "" : "is-estimated"}">${l("执行估算", "執行估算", "estimated")} ${installable}</span></span>`;
  }).join("");
  // Evidence counts, so the panel shows *why* the preflight is not VERIFIED
  // instead of a bare status word. Families come from the core classifier, so a
  // BLOCKED plan always names at least one reason.
  const detailParts = [
    totalsModel.blocked?.energy ? l(`能量不足 ${totalsModel.blocked.energy}`, `能量不足 ${totalsModel.blocked.energy}`, `${totalsModel.blocked.energy} out of energy`) : "",
    totalsModel.blocked?.socket ? l(`插槽不支持 ${totalsModel.blocked.socket}`, `插槽不支援 ${totalsModel.blocked.socket}`, `${totalsModel.blocked.socket} unsupported socket(s)`) : "",
    totalsModel.blocked?.plug ? l(`模组不可用 ${totalsModel.blocked.plug}`, `模組無法使用 ${totalsModel.blocked.plug}`, `${totalsModel.blocked.plug} unavailable plug(s)`) : "",
    totalsModel.blocked?.tuning ? l(`调整不兼容 ${totalsModel.blocked.tuning}`, `調校不相容 ${totalsModel.blocked.tuning}`, `${totalsModel.blocked.tuning} incompatible tuning`) : "",
    totalsModel.blocked?.instance ? l(`实例/库存映射错误 ${totalsModel.blocked.instance}`, `實例/庫存對應錯誤 ${totalsModel.blocked.instance}`, `${totalsModel.blocked.instance} instance mapping error(s)`) : "",
    totalsModel.blocked?.consistency ? l(`数学投影一致性错误 ${totalsModel.blocked.consistency}`, `數學投影一致性錯誤 ${totalsModel.blocked.consistency}`, `${totalsModel.blocked.consistency} projection mismatch(es)`) : "",
    totalsModel.unverified?.total ? l(`尚未验证 ${totalsModel.unverified.total}`, `尚未驗證 ${totalsModel.unverified.total}`, `${totalsModel.unverified.total} unverified`) : "",
  ].filter(Boolean);
  return `<details class="advanced-details" data-disclosure-key="advanced">
    <summary>${l("高级信息", "進階資訊", "Advanced")}</summary>
    <div class="advanced-list">
      <div class="advanced-row advanced-proof" data-proof-label="${escapeHtml(proofLabel)}">
        <span class="advanced-label">${l("数学证明", "數學證明", "Mathematical proof")}</span>
        <strong>${escapeHtml(proofLabel)}</strong>
      </div>
      <div class="advanced-row">
        <span class="advanced-label">${l("证书 / Canonical", "憑證 / Canonical", "Certificate / Canonical")}</span>
        <code>${escapeHtml(certificate.status || "—")}</code>
        <code>${escapeHtml(String(canonicalId))}</code>
      </div>
      <div class="advanced-row">
        <span class="advanced-label">${l("搜索统计", "搜尋統計", "Search statistics")}</span>
        <span>${escapeHtml(searchStats)}</span>
      </div>
      <div class="advanced-row">
        <span class="advanced-label">${l("执行预检", "執行預檢", "Execution preflight")}</span>
        <span>${escapeHtml(String(preflight))}${detailParts.length ? ` · ${escapeHtml(detailParts.join(" · "))}` : ""}</span>
      </div>
      <div class="advanced-row advanced-totals">
        <span class="advanced-label">${l("数学 / 升级后 / 执行估算", "數學 / 升級後 / 執行估算", "Math / projected / estimated")}</span>
        <span class="advanced-totals-grid">${totalsRows}</span>
      </div>
      <details class="advanced-sub" data-disclosure-key="advanced-allocation">
        <summary>${l("属性计算", "數值計算", "Stat allocation")}</summary>
        ${renderAllocationBreakdown(witness)}
      </details>
      ${safeWitnessBreakdown(witness)}
    </div>
  </details>`;
}

// The selected-plan note explains how execution reality relates to the
// mathematical result — and nothing else. Wording is evidence-gated so a data
// gap is never described as a refusal:
//   已确认…无法安装        — only for metadata-proven negatives (energy/socket/plug).
//   尚未验证…              — for missing capability data (DIM CSV exports).
//   部分护甲尚未完成大师杰作 — when the only gap is the armor's upgrade tier.
// The "installable" number is the instance state after the plan runs, so a
// blocked replacement keeps the modifier that is already installed; the note
// therefore says what is *in effect*, never "the mod was removed".
function renderExecutionNote(totalsModel) {
  const { status, blocked, unverified, mathematicalVsInstallable, masterworkPending } = totalsModel;
  if (!status && blocked.total === 0 && unverified.total === 0) return "";
  const formatTotals = source => mathematicalVsInstallable
    .map(stat => `${STAT_LABELS[stat]} ${Number(source[stat] || 0)}`).join(" / ");
  const sentences = [];
  if (mathematicalVsInstallable.length > 0) {
    sentences.push(l(
      `数学结果 ${formatTotals(totalsModel.mathematical)}；按当前证据实际生效 ${formatTotals(totalsModel.installable)}。`,
      `數學結果 ${formatTotals(totalsModel.mathematical)}；依目前證據實際生效 ${formatTotals(totalsModel.installable)}。`,
      `Mathematical ${formatTotals(totalsModel.mathematical)}; actually in effect under current evidence ${formatTotals(totalsModel.installable)}.`,
    ));
  }
  // One entry per named family. A BLOCKED plan always lands in at least one of
  // these, so the "why" area can never be empty.
  const confirmed = [];
  if (blocked.energy) confirmed.push(l(
    `${blocked.energy} 个属性模组因能量不足无法安装（原有模组保持不动）`,
    `${blocked.energy} 個數值模組因能量不足無法安裝（原有模組保持不動）`,
    `${blocked.energy} stat mod(s) cannot be installed for lack of energy (the installed mod stays)`,
  ));
  if (blocked.socket) confirmed.push(l(
    `${blocked.socket} 个模组因插槽不支持无法安装`,
    `${blocked.socket} 個模組因插槽不支援無法安裝`,
    `${blocked.socket} mod(s) cannot be installed because the socket does not support the role`,
  ));
  if (blocked.plug) confirmed.push(l(
    `${blocked.plug} 个模组不可用（插槽不接受该模组）`,
    `${blocked.plug} 個模組無法使用（插槽不接受該模組）`,
    `${blocked.plug} mod(s) are unavailable for the socket`,
  ));
  if (blocked.tuning) confirmed.push(l(
    `${blocked.tuning} 个调整模组与该护甲的固定调整属性不兼容`,
    `${blocked.tuning} 個調校模組與該防具的固定調校數值不相容`,
    `${blocked.tuning} tuning mod(s) are incompatible with the armor's fixed Tuning Stat`,
  ));
  if (blocked.instance) confirmed.push(l(
    `${blocked.instance} 处实例或库存映射错误（该槽位没有可写入的实例）`,
    `${blocked.instance} 處實例或庫存對應錯誤（該欄位沒有可寫入的實例）`,
    `${blocked.instance} instance/inventory mapping error(s) — no writable instance in that slot`,
  ));
  if (blocked.consistency) confirmed.push(l(
    `${blocked.consistency} 处数学投影一致性检查失败`,
    `${blocked.consistency} 處數學投影一致性檢查失敗`,
    `${blocked.consistency} mathematical projection consistency failure(s)`,
  ));
  // Defensive: a future reason this build does not know still gets a sentence.
  if (confirmed.length === 0 && blocked.total > 0) confirmed.push(l(
    `${blocked.total} 个写入被确认无法执行`,
    `${blocked.total} 個寫入被確認無法執行`,
    `${blocked.total} write(s) are confirmed impossible`,
  ));
  if (confirmed.length) sentences.push(l(
    `已确认：${confirmed.join("，")}。`,
    `已確認：${confirmed.join("，")}。`,
    `Confirmed: ${confirmed.join("; ")}.`,
  ));
  const unknown = [];
  if (unverified.socket) unknown.push(l(
    `${unverified.socket} 件护甲的插槽信息缺失（DIM 导出不含完整插槽数据）`,
    `${unverified.socket} 件防具的插槽資訊缺失（DIM 匯出不含完整插槽資料）`,
    `${unverified.socket} piece(s) carry no socket metadata (the DIM export omits it)`,
  ));
  if (unverified.socketWrite) unknown.push(l(
    `${unverified.socketWrite} 个模组的插槽可用性未知`,
    `${unverified.socketWrite} 個模組的插槽可用性未知`,
    `${unverified.socketWrite} mod(s) have unknown socket availability`,
  ));
  if (unverified.energy) unknown.push(l(
    `${unverified.energy} 件护甲的能量数据缺失`,
    `${unverified.energy} 件防具的能量資料缺失`,
    `${unverified.energy} piece(s) have no energy metadata`,
  ));
  if (unverified.tuning) unknown.push(l(
    `${unverified.tuning} 件护甲的调整能力未知`,
    `${unverified.tuning} 件防具的調校能力未知`,
    `${unverified.tuning} piece(s) have unknown tuning capability`,
  ));
  if (unknown.length) sentences.push(l(
    `尚未验证：${unknown.join("，")}；执行能力尚未完全验证，数值按完整方案给出。`,
    `尚未驗證：${unknown.join("，")}；執行能力尚未完全驗證，數值按完整方案給出。`,
    `Unverified: ${unknown.join("; ")}. Execution capability is not fully verified; values are shown for the complete plan.`,
  ));
  if (masterworkPending) sentences.push(l(
    "部分护甲尚未完成大师杰作，升级后的数值见下方。",
    "部分防具尚未完成大師之作，升級後的數值見下方。",
    "Some armor is not fully masterworked yet; the upgraded values are listed below.",
  ));
  if (sentences.length === 0) return "";
  const tone = confirmed.length ? "" : " is-unverified";
  return `<p class="inventory-projection-note${tone}">${sentences.join("")}</p>`;
}

function renderSelectedLoadout(entry, index) {
  if (!entry) return "";
  // One normalization, consumed by both the five-piece table and the
  // acquisition plan. Neither renderer reads `entry.pieces` positionally, so
  // they can never disagree about slot order or assignment index.
  const rows = createEntryPieceRows(entry);
  const { metCount, feasible } = getUnifiedEntrySummary(entry);
  const totalsModel = getUnifiedTotalsModel(entry);
  // The main six-stat bars are the Solver's mathematical result, in the same
  // domain as the certificate that decides 达标. `installable` is execution
  // preflight only and lives in the advanced panel and the note below.
  const finalTotals = totalsModel.mathematical;
  const projectionNote = renderExecutionNote(totalsModel);
  const ownership = entry.farmCount > 0
    ? l(
      `已有 ${entry.ownedCount}/5 · 待刷 ${entry.farmCount}`,
      `已有 ${entry.ownedCount}/5 · 待取得 ${entry.farmCount}`,
      `${entry.ownedCount}/5 owned · ${entry.farmCount} to farm`,
    )
    : l("五件已有齐全", "五件已有齊全", "All five owned");
  const state = getEntryStateBadge(entry);
  const headline = feasible
    ? (entry.exact
      ? l("精确解 · 已验证", "精確解 · 已驗證", "Exact solution · verified")
      : l("满足规则 · 已验证", "滿足規則 · 已驗證", "Rules satisfied · verified"))
    : state.label || searchProofLabel(entry.witness, entry.search);
  const canExport = entry.farmCount === 0;
  const searchingNote = entry.search?.running === true
    ? `<p class="loadout-note">${l(
      "已找到验证方案，仍在继续搜索更优候选。",
      "已找到驗證方案，仍在繼續搜尋更佳候選。",
      "A verified loadout was found; the search is still looking for better candidates.",
    )}</p>`
    : "";
  return `
    <header class="loadout-header">
      <div class="loadout-header-main">
        <span class="inventory-result-detail-label">${l(`方案 #${String(index + 1).padStart(2, "0")}`, `方案 #${String(index + 1).padStart(2, "0")}`, `Loadout #${String(index + 1).padStart(2, "0")}`)}</span>
        <h3 class="loadout-status ${feasible ? "is-met" : "is-short"}" data-proof-label="${escapeHtml(searchProofLabel(entry.witness, entry.search))}">${escapeHtml(headline)}</h3>
        <p class="loadout-subline">${l(`目标达标 ${metCount}/6`, `目標達標 ${metCount}/6`, `${metCount} of 6 targets met`)} · ${ownership}</p>
        ${searchingNote}
        ${projectionNote}
      </div>
      <div class="inventory-result-actions">
        <button type="button" class="btn inventory-export-button" onclick="exportInventorySolution(${index})" ${canExport ? "" : "disabled"}>${icon("share")}${l("导出 DIM", "匯出 DIM", "Export DIM")}</button>
        <button type="button" class="btn" onclick="saveBuild()">${icon("save")}${l("保存", "儲存", "Save")}</button>
      </div>
    </header>
    ${entry.kind === "inventory" ? renderInventoryBungieEquip(entry.witness, index) : ""}
    ${renderStatsSummary(entry, finalTotals)}
    ${renderArmorLoadoutTable(rows, entry)}
    ${renderAcquisitionPlan(rows)}
    ${renderAdvancedDetails(entry, totalsModel)}`;
}

function selectInventorySolution(index) {
  const entry = lastUnifiedLoadouts[index];
  if (!entry) return;
  selectedUnifiedIndex = index;
  selectedEntryKey = unifiedEntryKey(entry);
  if (entry.kind === "theory") {
    // `currentSolutionIdx` is the theory solver's own cursor (the legacy
    // solution nav still reads it). It is never the user's current choice —
    // Save/DIM/Equip resolve the selection from the unified list instead.
    const solutionIndex = allSolutions.indexOf(entry.plan?.solution);
    if (solutionIndex >= 0) currentSolutionIdx = solutionIndex;
  }
  // Keep the reader's viewport and every open accordion: only the selection and
  // the detail column change here.
  if (lastTargets && lastFragments && calculatorMode === "solve") {
    displayAllResults(entry.witness, lastTargets, lastFragments, {
      scroll: false, skipOwnedPlan: true, refreshList: false,
    });
  } else {
    renderUnifiedResults();
    return;
  }
  applyPlanSelection();
}

// A DIM import link: https://app.destinyitemmanager.com/loadouts?loadout=<JSON>
// This is the same format DIM itself produces for shared loadouts, accepted by
// its "Import Loadout" flow without any upload, so the app stays static. The
// link carries the five armor instances plus the plan's stat mods and tuning
// mods in parameters.mods, which DIM auto-assigns when the loadout is applied.
// Only pieces imported from the DIM CSV carry the hash + instance id DIM needs.
let lastDimExportUrl = "";

function getDimLoadoutExport(pieces, tuningAssignments, modAssignments) {
  const classTypeById = { titan: 0, hunter: 1, warlock: 2 };
  const equipped = [];
  const mods = [];
  pieces.forEach((piece, index) => {
    if (!piece?.hash || !piece?.sourceId) return;
    equipped.push({ id: piece.sourceId, hash: Number(piece.hash), amount: 1 });
    const mod = modAssignments?.[index];
    if (mod?.size > 0) {
      const modHash = STAT_MOD_HASHES[mod.stat]?.[mod.size];
      if (modHash) mods.push(modHash);
    }
    const tuning = tuningAssignments?.[index];
    if (tuning?.mode === '+3') {
      mods.push(BALANCED_TUNING_MOD_HASH);
    } else if (tuning?.mode === '+5-5' && tuning.to && tuning.from) {
      const tuningHash = TUNING_MOD_HASH_BY_TUNING[`${tuning.to}:${tuning.from}`];
      if (tuningHash) mods.push(tuningHash);
    }
  });
  const loadout = {
    id: `d2armor-${Date.now().toString(36)}`,
    name: l("T5 配装方案", "T5 配裝方案", "T5 Armor Loadout"),
    classType: classTypeById[importClassFilter] ?? 3,
    equipped,
    unequipped: [],
    parameters: { mods },
  };
  return {
    url: `https://app.destinyitemmanager.com/loadouts?loadout=${encodeURIComponent(JSON.stringify(loadout))}`,
    count: equipped.length,
    modCount: mods.length,
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderDimExportMessage(messages, url, count, modCount, ok, warning = "") {
  const note = count < 5
    ? l(
      `（${5 - count} 件缺少 DIM 实例信息，未包含）`,
      `（${5 - count} 件缺少 DIM 實例資訊，未包含）`,
      ` (${5 - count} piece(s) lack DIM instance data and were skipped)`
    )
    : '';
  const modNote = modCount > 0
    ? l(
      `，已包含 ${modCount} 个护甲模组/调整设置`,
      `，已包含 ${modCount} 個防具模組/調校設定`,
      `, includes ${modCount} armor mod/tuning settings`
    )
    : l(
      "（未包含模组设置）",
      "（未包含模組設定）",
      " (no mod settings included)"
    );
  const heading = ok
    ? l(
      `已复制 DIM 配装链接（${count} 件护甲）${note}${modNote}`,
      `已複製 DIM 配裝連結（${count} 件防具）${note}${modNote}`,
      `DIM loadout link copied (${count} armor pieces)${note}${modNote}`
    )
    : l(
      "复制失败，请用下方按钮复制或打开链接：",
      "複製失敗，請用下方按鈕複製或開啟連結：",
      "Copy failed. Use the buttons below to copy or open the link:"
    );
  messages.innerHTML = `<div class="msg ${ok ? "info" : "error"} dim-export-msg">${
    icon(ok ? "check" : "block")
  }<div class="dim-export-body">
    <span>${heading}</span>
    ${warning ? `<p class="dim-export-warning">${escapeHtml(warning)}</p>` : ""}
    <div class="dim-export-actions">
      <a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">${icon("share")}${l("在 DIM 中打开", "在 DIM 中開啟", "Open in DIM")}</a>
      <button type="button" class="btn" onclick="copyDimExportLink()">${icon("save")}${l("重新复制链接", "重新複製連結", "Copy link again")}</button>
    </div>
    <p class="dim-export-hint">${l(
      "打开前请确保浏览器已登录 DIM；或复制链接后，粘贴到 DIM → Loadouts → Import Loadout。模组与调整（含 -5 来源）已随链接带入，需已拥有对应模组（未拥有的会灰显忽略）；护甲需完成大师杰作。",
      "開啟前請確保瀏覽器已登入 DIM；或複製連結後，貼上到 DIM → Loadouts → Import Loadout。模組與調校（含 -5 來源）已隨連結帶入，需已擁有對應模組（未擁有的會灰顯忽略）；防具需完成大師之作。",
      "Make sure DIM is logged in before opening the link, or paste it into DIM → Loadouts → Import Loadout. Stat mods and the full tuning setup (including the -5 source) are included in the link — you must own them (missing mods are greyed out and ignored); armor must be fully masterworked."
    )}</p>
  </div></div>`;
}

async function copyDimExportLink() {
  if (!lastDimExportUrl) return;
  try {
    await copyText(lastDimExportUrl);
  } catch (error) {
    console.error('DIM loadout link copy failed', error);
  }
}

async function exportInventorySolution(index) {
  const unified = resolveUnifiedEntry(index);
  if (!unified) return;
  const witness = unified.witness;
  const messages = document.getElementById('messages');
  // A plan that still needs farmed armor has no complete instance set, so a DIM
  // link would be misleading. Say what is missing instead of exporting it.
  const exportPieces = unified.pieces.map(piece => unified.kind === "inventory"
    ? piece
    : (piece.item ? {...piece.item, slot: piece.slot} : null));
  if (exportPieces.some(piece => !piece?.sourceId || !piece?.hash)) {
    messages.innerHTML += `<div class="msg warn">${icon('warn')}${l(
      `该方案还需刷取 ${unified.farmCount} 件护甲，补齐后才能导出可用的 DIM 配装链接。`,
      `該方案還需取得 ${unified.farmCount} 件防具，補齊後才能匯出可用的 DIM 配裝連結。`,
      `This plan still needs ${unified.farmCount} farmed armor piece(s); complete it before exporting a usable DIM link.`
    )}</div>`;
    return;
  }
  assertSolutionConsistency(witness.problemSpec, witness, witness.visibleTotals);
  const { url, count, modCount } = getDimLoadoutExport(
    exportPieces, unified.tuningAssignments, unified.modAssignments
  );
  lastDimExportUrl = url;
  // With a Bungie inventory the same plan drives the direct-equip preflight; a
  // plan with unassignable mods must not be exported as if it were exact.
  let exportWarning = '';
  if (importSource === "bungie" && bungieProfileState && unified.kind === "inventory") {
    const equipState = getInventorySolutionEquipState(witness);
    if (!equipState.available && equipState.plan) {
      const blocking = equipState.plan.assignment?.unassignedMods || [];
      if (blocking.length > 0) {
        const first = bungiePlanErrorMessage(equipState.plan.errors[0]);
        exportWarning = l(
          `链接已生成，但 ${blocking.length} 个模组无法在目标角色上安装（${first}）。DIM 会自动灰显无法放置的模组。`,
          `連結已產生，但 ${blocking.length} 個模組無法在目標角色上安裝（${first}）。DIM 會自動灰顯無法放置的模組。`,
          `The link was generated, but ${blocking.length} mod(s) cannot be installed on the target character (${first}). DIM will grey out mods it cannot place.`,
        );
      }
    }
  }
  try {
    await copyText(url);
    renderDimExportMessage(messages, url, count, modCount, true, exportWarning);
  } catch (error) {
    console.error('DIM loadout export failed', error);
    renderDimExportMessage(messages, url, count, modCount, false, exportWarning);
  }
}

async function analyzeArmorUpgrades() {
  const revision = beginSearch();
  const button = document.getElementById('btnUpgradeAnalyze');
  const loading = document.getElementById('loading');
  const messages = document.getElementById('messages');
  const targets = getUpgradeTargets();
  const fragments = getUpgradeFragments();
  const constraints = buildUpgradeFuzzyConstraints(fragments);
  const requiredStats = getUpgradeRequiredStats();
  const reassignModifiers = document.getElementById('upgradeReassignModifiers')?.checked !== false;
  const onlyPlus5Tuning = document.getElementById('upgradeOnlyPlus5')?.checked === true;
  messages.innerHTML = '';

  // With an imported inventory the "no farming" option comes from the pieces
  // you already own; the theoretical plan below is the "farming" option.
  let inventoryMessage = '';
  if (importedInventory.length > 0) {
    inventoryMessage = await solveInventoryRequirement({
      targets, fragments, requiredStats, onlyPlus5Tuning, constraints,
    });
    if (inventoryMessage === null) return;
  }

  // The replacement plan is stat-only: set membership does not constrain the
  // archetype/tertiary search (legendary set pieces roll any frame), so it is
  // computed independently of the set requirement. The set constraint applies
  // only to the owned-armor search above.
  const unlockedCount = upgradeBuildState.filter(piece => !piece.locked).length;
  if (unlockedCount === 0) {
    messages.innerHTML = inventoryMessage + `<div class="msg error">${icon('block')}${l(
      '5 件护甲都被固定了。至少放开一件，才能继续找替换方案。',
      '5 件防具都被固定了。至少放開一件，才能繼續找替換方案。',
      'All five pieces are fixed. Unlock at least one before looking for replacements.'
    )}</div>`;
    return;
  }

  button.disabled = true;
  loading.querySelector('p').textContent = l('正在帮你排替换顺序...','正在幫你排替換順序...','Planning the replacement order...');
  loading.classList.add('show');
  loading.setAttribute('aria-busy', 'true');
  saveUpgradeDraft();

  try {
      const analysis = await analyzeUpgradeAsync({
        searchProfile,
        pieces: upgradeBuildState.map(piece => ({ ...piece })),
        targets,
        fragments,
        reassignModifiers,
        requiredStats,
        onlyPlus5Tuning,
        constraints,
      }, {onProgress: (partial, search) => {
        if (revision !== searchUiRevision) return;
        renderSearchStatus(partial, search);
        if (partial?.baseline) renderUpgradeAnalysis(partial, false);
      }});
      if (revision !== searchUiRevision) return;
      renderUpgradeAnalysis(analysis, true);
      renderSearchStatus(analysis);
      messages.innerHTML = inventoryMessage + `<div class="msg info">${escapeHtml(searchProofLabel(analysis))}</div>`;
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Armor upgrade analysis failed', error);
      messages.innerHTML = inventoryMessage + '<div class="msg error">' + icon('block') + l(
        '替换分析过程中发生错误，请重试。',
        '替換分析過程中發生錯誤，請重試。',
        'The replacement analysis failed. Please try again.'
      ) + '</div>';
    } finally {
      if (revision === searchUiRevision) {
        button.disabled = false;
        loading.classList.remove('show');
        loading.setAttribute('aria-busy', 'false');
        loading.querySelector('p').textContent = t('calculating');
      }
    }
}

// ============================================================
// SAVED BUILDS (shared user data, not channel state)
// ============================================================
// A Saved Build is split into two very different lifetimes:
//   input            — the user's targets, fragments, budget, Exotic and set
//                      constraints. Long-term durable: a future Solver V4/V5
//                      must still be able to restore it and re-solve.
//   solutionSnapshot — canonicalId/pieces/assignments/totals plus the raw
//                      sealed witness as a cache. Convenient, never required:
//                      when the Solver contract moves on and the snapshot no
//                      longer re-verifies, the build is *kept* and the reader
//                      is told to re-solve, instead of losing the loadout.

function getSavedBuilds() {
  return buildRepository.readSavedBuilds();
}

// A cheap fingerprint of everything that can change a plan. Comparing it with
// the signature captured when the current result was produced answers
// "are there unsaved condition edits on screen?" without diffing drafts.
function currentInputSignature() {
  const pieces = (upgradeBuildState || []).map(piece => [
    piece?.slot ?? null, piece?.sourceId ?? null, piece?.archetypeId ?? null,
    piece?.tertiary ?? null, piece?.tuningMode ?? null, piece?.tuningFrom ?? null,
    piece?.tuningTo ?? null, piece?.armorModSize ?? 0, piece?.armorModStat ?? null,
    piece?.exotic ? 1 : 0, piece?.locked ? 1 : 0,
  ]);
  const targets = Object.fromEntries(STATS.map(stat => [stat, getVal('target_' + stat)]));
  const required = STATS.filter(stat => document.getElementById('upgradeRequired_' + stat)?.checked === true);
  const fragments = Object.fromEntries(STATS.map(stat => [stat, getFragVal(stat)]));
  const exotic = document.getElementById('useExoticMode')?.checked === true
    ? [document.getElementById('exoticClass')?.value, document.getElementById('exoticPrimaryPerk')?.value, document.getElementById('exoticSecondaryPerk')?.value]
    : null;
  return JSON.stringify({
    mode: calculatorMode,
    targets, required, fragments, exotic,
    classFilter: importClassFilter,
    inventoryCount: importedInventory.length,
    fixedExotic: [inventoryExoticSlotFilter, inventoryFixedExoticKey],
    setRequirement: snapshotSetRequirement(),
    budget: [getVal('numPlus5'), getVal('numPlus10'), document.getElementById('usePlus3')?.checked === true, getPlus3Count()],
    onlyPlus5: isOnlyPlus5Tuning(),
    pieces,
  });
}

function hasUnsavedConditionEdits() {
  if (lastCommittedInputSignature === null) return false;
  return currentInputSignature() !== lastCommittedInputSignature;
}

// Returns false when the write did not land. The caller must surface that:
// reporting "saved" for a build that was never persisted is how a user loses
// a loadout without ever being told.
function saveBuildsToStorage(builds) {
  return buildRepository.writeSavedBuilds(builds) === true;
}

// Status text lives in the saved-plan drawer, next to the list it is about.
function showSavedBuildStatus(message, tone = "info") {
  const status = document.getElementById('savedBuildStatus');
  if (!status) return;
  status.innerHTML = `<div class="msg ${tone}">${icon(tone === 'error' ? 'block' : tone === 'warn' ? 'warn' : 'check')}<span>${escapeHtml(message)}</span></div>`;
}

function clearSavedBuildStatus() {
  const status = document.getElementById('savedBuildStatus');
  if (status) status.innerHTML = '';
}

// ============================================================
// OVERLAYS (saved-plan drawer, save dialog, toasts)
// ============================================================
// One scrim, one Escape handler, one state read: the overlays never stack, so
// closing "everything" is always correct and no overlay can trap focus behind
// another one.
function setOverlay(id, open) {
  const node = document.getElementById(id);
  if (node) node.hidden = !open;
  const scrim = document.getElementById('overlayScrim');
  if (scrim && open) scrim.hidden = false;
}

function closeOverlays() {
  setOverlay('savedBuildsDrawer', false);
  setOverlay('saveBuildDialog', false);
  const scrim = document.getElementById('overlayScrim');
  if (scrim) scrim.hidden = true;
  document.body.classList.remove('has-overlay');
}

function openSavedBuildsDrawer() {
  closeOverlays();
  renderSavedBuilds();
  setOverlay('savedBuildsDrawer', true);
  document.body.classList.add('has-overlay');
}

// Non-blocking feedback that never moves the page: "saved", "deleted" and the
// Undo affordance all land here instead of in a status block that would have to
// be scrolled to.
function showToast(message, { tone = "info", action = null, actionLabel = "", duration = 6000 } = {}) {
  const stack = document.getElementById('toastStack');
  if (!stack) return () => {};
  const toast = document.createElement('div');
  toast.className = `toast is-${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  const dismiss = () => { clearTimeout(timer); toast.remove(); };
  if (typeof action === 'function' && actionLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = actionLabel;
    button.addEventListener('click', () => { action(); dismiss(); });
    toast.append(button);
  }
  const timer = setTimeout(dismiss, duration);
  stack.append(toast);
  return dismiss;
}

// Long-term user input, whichever shape the record happens to carry: the new
// nested `input` block, or the flat fields older versions wrote.
function readSavedBuildInput(build) {
  const nested = build?.input && typeof build.input === 'object' ? build.input : {};
  const pick = (key, fallback) => {
    if (nested[key] !== undefined) return nested[key];
    if (build?.[key] !== undefined) return build[key];
    return fallback;
  };
  return {
    targets: pick('targets', {}),
    targetMax: pick('targetMax', {}),
    fragments: pick('fragments', {}),
    targetLocks: pick('targetLocks', {}),
    statPriority: pick('statPriority', {}),
    statFuzzyMode: pick('statFuzzyMode', {}),
    numPlus5: pick('numPlus5', 0),
    numPlus10: pick('numPlus10', 0),
    onlyPlus5Tuning: pick('onlyPlus5Tuning', false),
    n3Enabled: pick('n3Enabled', false),
    numPlus3: pick('numPlus3', 0),
    exotic: pick('exotic', null),
    setRequirement: pick('setRequirement', null),
    classFilter: pick('classFilter', null),
  };
}

function createSavedBuildId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `build-${Date.now().toString(36)}-${random}`;
}

function buildSavedBuildRecord(entry, name) {
  const witness = entry.witness;
  const targets = {};
  const fragments = {};
  for (const s of STATS) {
    targets[s] = getVal('target_' + s);
    fragments[s] = getFragVal(s);
  }
  const exoticSettings = getExoticSettings();
  const onlyPlus5Tuning = isOnlyPlus5Tuning();
  const input = {
    targets,
    targetMax: Object.fromEntries(STATS.map(s => [s, getVal('targetMax_' + s)])),
    fragments,
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
    statPriority: { ...statPriority },
    statFuzzyMode: { ...statFuzzyMode },
    numPlus5: getVal('numPlus5'),
    numPlus10: getVal('numPlus10'),
    onlyPlus5Tuning,
    n3Enabled: !onlyPlus5Tuning && (document.getElementById('usePlus3')?.checked || false),
    numPlus3: getPlus3Count(),
    exotic: exoticSettings ? {
      enabled: true,
      classId: exoticSettings.classId,
      primaryPerkId: exoticSettings.primaryPerkId,
      secondaryPerkId: exoticSettings.secondaryPerkId,
      priorityOrder: exoticSettings.priorityOrder,
    } : null,
    setRequirement: snapshotSetRequirement(),
    classFilter: importClassFilter || null,
  };
  const now = Date.now();
  const snapshot = {
    canonicalId: witness.canonicalId || createCanonicalId(witness),
    kind: entry.kind,
    pieces: (witness.pieces || witness.config || []).map(piece => ({
      slot: piece?.slot ?? null,
      sourceId: piece?.sourceId ?? piece?.id ?? null,
      hash: piece?.hash ?? null,
      name: piece?.itemName || piece?.name || null,
      archetypeId: piece?.archetypeId ?? piece?.archetype ?? null,
      tertiary: piece?.tertiary ?? null,
      exotic: Boolean(piece?.exotic),
      setHash: piece?.setHash ?? null,
    })),
    tuningAssignments: witness.tuningAssignments || null,
    modAssignments: witness.modAssignments || null,
    visibleTotals: witness.visibleTotals || null,
    armorTotals: witness.armorTotals || null,
    certificateStatus: witness.certificate?.status || null,
    solverVersion: SOLVER_V3_SCHEMA_VERSION,
  };
  return {
    schemaVersion: SAVED_BUILD_SCHEMA_VERSION,
    id: createSavedBuildId(),
    name,
    createdAt: now,
    updatedAt: now,
    // Ordering field older versions wrote and this one still reads.
    savedAt: now,
    language: getPageLanguage(),
    kind: entry.kind,
    input,
    solutionSnapshot: snapshot,
    // Cache only. Its absence, or a future contract change that makes it
    // fail re-verification, must never delete the build.
    result: structuredClone(witness),
  };
}

// A default name that already says something useful: the solved plan, the
// class, and when it was made.
function defaultSavedBuildName(entry) {
  const input = {};
  for (const stat of STATS) input[stat] = getVal('target_' + stat);
  const classLabel = { hunter: l('猎人', '獵人', 'Hunter'), titan: l('泰坦', '泰坦', 'Titan'), warlock: l('术士', '術士', 'Warlock') }[importClassFilter] || '';
  const requirement = snapshotSetRequirement();
  const setLabel = requirement && requirement.type !== 'none' ? formatSetRequirementLabel(requirement) : '';
  const kindLabel = entry?.farmCount === 0
    ? l('已有齐全', '已有齊全', 'Fully owned')
    : l('从零配装', '從零配裝', 'From scratch');
  const date = new Date().toLocaleDateString(localeCode());
  const time = new Date().toLocaleTimeString(localeCode()).slice(0, 5);
  return [l('配装', '配裝', 'Loadout'), date, time, classLabel, setLabel, kindLabel]
    .filter(Boolean).join(' · ');
}

// `saveBuild()` (the command-bar button and the plan header button) opens the
// dialog. Keeping the naming step in a dialog instead of prompt() means the
// save flow cannot scroll the page, cannot jump to another section, and can
// report a storage failure inline.
function saveBuild() {
  const entry = getSelectedUnifiedEntry();
  if (!entry) {
    showToast(l('请先求解配装再保存。', '請先求解配裝再儲存。', 'Solve a loadout before saving it.'), { tone: 'warn' });
    return;
  }
  const summary = getUnifiedEntrySummary(entry);
  const dialog = document.getElementById('saveBuildDialog');
  const nameInput = document.getElementById('saveBuildName');
  const summaryEl = document.getElementById('saveBuildSummary');
  if (!dialog || !nameInput) return;
  pendingSave = { mode: 'create', index: -1, entry };
  nameInput.value = defaultSavedBuildName(entry);
  if (summaryEl) {
    summaryEl.textContent = l(
      `方案 #${String(selectedUnifiedIndex + 1).padStart(2, '0')} · 达标 ${summary.metCount}/6 · 已有 ${entry.ownedCount}/5`,
      `方案 #${String(selectedUnifiedIndex + 1).padStart(2, '0')} · 達標 ${summary.metCount}/6 · 已有 ${entry.ownedCount}/5`,
      `Plan #${String(selectedUnifiedIndex + 1).padStart(2, '0')} · ${summary.metCount}/6 met · ${entry.ownedCount}/5 owned`,
    );
  }
  const title = dialog.querySelector('h2');
  if (title) title.textContent = t('saveDialogTitle');
  closeOverlays();
  setOverlay('saveBuildDialog', true);
  document.body.classList.add('has-overlay');
  nameInput.focus();
  nameInput.select();
}

function renameBuild(index) {
  const build = getSavedBuilds()[index];
  if (!build) return;
  const dialog = document.getElementById('saveBuildDialog');
  const nameInput = document.getElementById('saveBuildName');
  const summaryEl = document.getElementById('saveBuildSummary');
  if (!dialog || !nameInput) return;
  pendingSave = { mode: 'rename', index, entry: null };
  nameInput.value = String(build.name ?? '');
  if (summaryEl) summaryEl.textContent = savedBuildSubtitle(build);
  const title = dialog.querySelector('h2');
  if (title) title.textContent = l('重命名方案', '重新命名方案', 'Rename plan');
  closeOverlays();
  setOverlay('saveBuildDialog', true);
  document.body.classList.add('has-overlay');
  nameInput.focus();
  nameInput.select();
}

// The dialog's submit handler. Storage failures surface inline and the dialog
// stays open, because reporting "saved" for a build that was never persisted is
// how a user loses a loadout without being told.
function submitSaveBuild(event) {
  event?.preventDefault?.();
  const nameInput = document.getElementById('saveBuildName');
  const errorEl = document.getElementById('saveBuildDialogStatus');
  const name = String(nameInput?.value || '').trim();
  if (!name) {
    if (errorEl) {
      errorEl.innerHTML = `<div class="msg error">${icon('block')}<span>${escapeHtml(l(
        '请输入方案名称。', '請輸入方案名稱。', 'Enter a plan name.',
      ))}</span></div>`;
    }
    nameInput?.focus();
    return false;
  }
  if (errorEl) errorEl.innerHTML = '';

  if (pendingSave?.mode === 'rename') {
    const builds = getSavedBuilds();
    const target = builds[pendingSave.index];
    if (!target) { closeOverlays(); return false; }
    target.name = name;
    target.updatedAt = Date.now();
    if (!saveBuildsToStorage(builds)) {
      if (errorEl) {
        errorEl.innerHTML = `<div class="msg error">${icon('block')}<span>${escapeHtml(l(
          '重命名失败：浏览器存储不可用或已满。',
          '重新命名失敗：瀏覽器儲存空間無法使用或已滿。',
          'Rename failed: browser storage is unavailable or full.',
        ))}</span></div>`;
      }
      return false;
    }
    closeOverlays();
    clearSavedBuildStatus();
    renderSavedBuilds();
    showToast(l('已重命名。', '已重新命名。', 'Renamed.'));
    return false;
  }

  const entry = pendingSave?.entry;
  if (!entry) { closeOverlays(); return false; }
  const witness = entry.witness;
  try {
    assertSolutionConsistency(witness.problemSpec, witness);
  } catch (error) {
    console.error('Saved build consistency check failed', error);
    if (errorEl) {
      errorEl.innerHTML = `<div class="msg error">${icon('block')}<span>${escapeHtml(l(
        '方案未通过一致性检查，请重新求解后再保存。',
        '方案未通過一致性檢查，請重新求解後再儲存。',
        'This plan failed its consistency check. Solve again before saving.',
      ))}</span></div>`;
    }
    return false;
  }

  const builds = getSavedBuilds();
  builds.unshift(buildSavedBuildRecord(entry, name));
  if (builds.length > SAVED_BUILD_LIMIT) builds.length = SAVED_BUILD_LIMIT;
  if (!saveBuildsToStorage(builds)) {
    const message = l(
      `保存失败：浏览器存储不可用或已满，方案「${name}」没有写入。请清理站点存储后重试。`,
      `儲存失敗：瀏覽器儲存空間無法使用或已滿，方案「${name}」沒有寫入。請清理網站儲存空間後重試。`,
      `Save failed: browser storage is unavailable or full, so "${name}" was not written. Free up site storage and try again.`,
    );
    if (errorEl) {
      errorEl.innerHTML = `<div class="msg error">${icon('block')}<span>${escapeHtml(message)}</span></div>`;
    }
    showSavedBuildStatus(message, 'error');
    return false;
  }
  closeOverlays();
  clearSavedBuildStatus();
  renderSavedBuilds();
  // Deliberately no navigation: the save lands as a toast so the reader keeps
  // their scroll position and their selection.
  showToast(l(
    `已保存「${name}」。可在右上角「已保存方案」中载入。`,
    `已儲存「${name}」。可在右上角「已儲存方案」中載入。`,
    `Saved "${name}". Open it any time from "Saved plans" in the top-right corner.`,
  ));
  return false;
}

// Restores the durable input half of a build. Always safe: it touches only
// form state, so a build whose snapshot cannot be re-verified still loads its
// constraints and can be re-solved with the current algorithm.
function applySavedBuildInput(build) {
  const input = readSavedBuildInput(build);
  statPriority = { ...(input.statPriority || {}) };
  statFuzzyMode = { ...(input.statFuzzyMode || {}) };
  for (const s of STATS) {
    document.getElementById('target_' + s).value = input.targets?.[s] ?? 0;
    const maxEl = document.getElementById('targetMax_' + s);
    if (maxEl) maxEl.value = input.targetMax?.[s] ?? 0;
    const lockEl = document.getElementById('targetLock_' + s);
    if (lockEl) lockEl.checked = input.targetLocks?.[s] || false;
    const el = document.getElementById('fragVal_' + s);
    if (el) {
      const value = input.fragments?.[s] ?? 0;
      el.textContent = value;
      el.style.color = value !== 0 ? STAT_COLORS[s] : '';
    }
  }
  for (const s of STATS) {
    syncPriorityUI(s);
    syncStatModeUI(s);
  }
  document.getElementById('numPlus5').value = input.numPlus5;
  document.getElementById('numPlus10').value = input.numPlus10;
  document.getElementById('onlyPlus5Tuning').checked = input.onlyPlus5Tuning === true;
  document.getElementById('usePlus3').checked = !input.onlyPlus5Tuning && !!input.n3Enabled;
  if (input.n3Enabled) {
    document.getElementById('plus3CountVal').textContent = input.numPlus3;
  }
  syncPlus3PreferenceUI();
  document.getElementById('useExoticMode').checked = !!input.exotic?.enabled;
  toggleExoticMode();
  if (input.exotic?.enabled) {
    if (input.exotic.classId && EXOTIC_CLASSES[input.exotic.classId]) {
      document.getElementById('exoticClass').value = input.exotic.classId;
      updateExoticPerkOptions();
    }
    if (input.exotic.primaryPerkId) document.getElementById('exoticPrimaryPerk').value = input.exotic.primaryPerkId;
    if (input.exotic.secondaryPerkId) document.getElementById('exoticSecondaryPerk').value = input.exotic.secondaryPerkId;
    updateExoticFramework();
  }
  if (input.setRequirement?.type) {
    setRequirement = snapshotSetRequirement(input.setRequirement);
    invalidateOwnedPlanCache();
    renderSetEffects();
  }
  updateBudget();
  return input;
}

function loadBuild(build) {
  if (!build) return;
  // Loading replaces the whole input state, so an unsaved edit must be
  // confirmed first — silently discarding a half-edited target set is exactly
  // the kind of "the app ate my work" moment to avoid.
  if (hasUnsavedConditionEdits() && !confirm(l(
    '当前条件尚未保存。\n载入该方案会覆盖当前输入。',
    '目前條件尚未儲存。\n載入該方案會覆蓋目前輸入。',
    'Your current conditions are not saved.\nLoading this plan will overwrite the current input.',
  ))) {
    return;
  }
  const input = applySavedBuildInput(build || {});
  const buildLanguage = build?.language || build?.exotic?.language;
  if (['zh-chs', 'zh-cht', 'en'].includes(buildLanguage) && buildLanguage !== getPageLanguage()) {
    document.getElementById('pageLanguage').value = buildLanguage;
    changePageLanguage();
  }
  // The load becomes the new committed baseline, so the next load does not warn
  // about the edits the user just intentionally replaced.
  const commit = () => { lastCommittedInputSignature = currentInputSignature(); };
  closeOverlays();
  // Snapshot half. A missing or no-longer-verifiable witness degrades to
  // "re-solve with the current solver" — it never removes the build.
  const cached = build?.result || null;
  if (!cached) {
    document.getElementById('messages').innerHTML = '<div class="msg warn">' + l(
      '旧版本方案：已载入目标与约束，请重新求解。',
      '舊版本方案：已載入目標與限制，請重新求解。',
      'This saved plan predates the current format. Its targets and constraints are loaded — solve again.',
    ) + '</div>';
    commit();
    return;
  }
  try {
    assertSolutionConsistency(cached.problemSpec, cached);
  } catch {
    document.getElementById('messages').innerHTML = '<div class="msg warn">UNVERIFIED: ' + l(
      '旧版本方案，需要重新求解。目标与约束已载入。',
      '舊版本方案，需要重新求解。目標與限制已載入。',
      'Saved with an older solver version; solve again. Targets and constraints are loaded.',
    ) + '</div>';
    commit();
    return;
  }
  allSolutions = [cached];
  allSolutions.status = cached.certificate?.status || 'SEARCH_LIMIT_REACHED';
  allSolutions.certificate = cached.certificate;
  currentSolutionIdx = 0;
  lastTargets = input.targets;
  lastFragments = input.fragments;
  lastNumPlus5 = input.numPlus5;
  lastNumPlus10 = input.numPlus10;
  lastNumPlus3 = input.onlyPlus5Tuning || !input.n3Enabled ? 0 : input.numPlus3;
  lastExoticSettings = getExoticSettings();
  displayAllResults(cached, input.targets, input.fragments);
  commit();
}

function deleteBuild(idx) {
  const builds = getSavedBuilds();
  const target = builds[idx];
  if (!target) return;
  if (!confirm(l(`确定删除「${target.name}」？`, `確定刪除「${target.name}」？`, `Delete "${target.name}"?`))) return;
  builds.splice(idx, 1);
  if (!saveBuildsToStorage(builds)) {
    showSavedBuildStatus(l(
      '删除失败：浏览器存储不可用或已满，方案仍然保留。',
      '刪除失敗：瀏覽器儲存空間無法使用或已滿，方案仍然保留。',
      'Delete failed: browser storage is unavailable or full. The loadout is still saved.',
    ), 'error');
    return;
  }
  clearSavedBuildStatus();
  renderSavedBuilds();
  // Undo instead of a second confirmation: the destructive step already asked,
  // and a one-click restore is strictly safer than a modal nobody reads.
  showToast(l(
    `已删除「${target.name}」。`,
    `已刪除「${target.name}」。`,
    `Deleted "${target.name}".`,
  ), {
    action: () => {
      const restored = getSavedBuilds();
      restored.splice(Math.min(idx, restored.length), 0, target);
      if (saveBuildsToStorage(restored)) {
        clearSavedBuildStatus();
        renderSavedBuilds();
        showToast(l('已恢复。', '已復原。', 'Restored.'));
      } else {
        showSavedBuildStatus(l(
          '恢复失败：浏览器存储不可用。', '復原失敗：瀏覽器儲存空間無法使用。',
          'Restore failed: browser storage is unavailable.',
        ), 'error');
      }
    },
    actionLabel: l('撤销', '復原', 'Undo'),
  });
}

function clearAllBuilds() {
  const builds = getSavedBuilds();
  if (builds.length === 0) return;
  if (!confirm(l(
    `确定清空全部 ${builds.length} 个已保存方案？此操作不可撤销。`,
    `確定清除全部 ${builds.length} 個已儲存方案？此操作無法復原。`,
    `Clear all ${builds.length} saved plans? This cannot be undone.`,
  ))) return;
  if (!buildRepository.clearSavedBuilds()) {
    showSavedBuildStatus(l(
      '清空失败：浏览器存储不可用。',
      '清除失敗：瀏覽器儲存空間無法使用。',
      'Clear failed: browser storage is unavailable.',
    ), 'error');
    return;
  }
  clearSavedBuildStatus();
  renderSavedBuilds();
  showToast(l('已清空全部方案。', '已清除全部方案。', 'All saved plans cleared.'));
}

// One compact line per saved plan: when it was saved, what kind of plan it is,
// and the context (class / set) that tells two similar names apart.
function savedBuildSubtitle(build) {
  const savedAt = Number(build.savedAt || build.updatedAt || build.createdAt) || 0;
  const dateStr = savedAt > 0
    ? new Date(savedAt).toLocaleString(localeCode(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const input = readSavedBuildInput(build);
  const kindLabel = (build?.kind || build?.solutionSnapshot?.kind) === 'inventory'
    ? l('已有护甲方案', '已有防具方案', 'Owned armor')
    : l('从零求解', '從零求解', 'From scratch');
  const classLabel = {
    hunter: l('猎人', '獵人', 'Hunter'),
    titan: l('泰坦', '泰坦', 'Titan'),
    warlock: l('术士', '術士', 'Warlock'),
  }[input.classFilter] || '';
  const requirement = input.setRequirement;
  const setLabel = requirement && requirement.type && requirement.type !== 'none'
    ? formatSetRequirementLabel(requirement)
    : '';
  return [dateStr, kindLabel, classLabel, setLabel].filter(Boolean).join(' · ');
}

// Clicking a row selects it and reveals its full target line. It never mutates
// the working state — loading is always an explicit button.
function selectSavedBuild(index) {
  const list = document.getElementById('savedBuildsList');
  if (!list) return;
  for (const item of list.querySelectorAll('.saved-item')) {
    const isSelected = Number(item.dataset.buildIndex) === index;
    item.classList.toggle('is-selected', isSelected);
    const detail = item.querySelector('.saved-item-detail');
    if (detail) detail.hidden = !isSelected;
  }
}

function renderSavedBuilds() {
  const builds = getSavedBuilds();
  const list = document.getElementById('savedBuildsList');
  const countEl = document.getElementById('savedBuildsCount');
  const drawerCount = document.getElementById('savedBuildsDrawerCount');
  if (countEl) countEl.textContent = String(builds.length);
  if (drawerCount) {
    drawerCount.textContent = builds.length > 0
      ? l(`${builds.length} 个`, `${builds.length} 個`, `${builds.length}`)
      : '';
  }
  const clearButton = document.getElementById('savedBuildsClearAll');
  if (clearButton) clearButton.disabled = builds.length === 0;
  if (!list) return;
  if (builds.length === 0) {
    list.innerHTML = `<p class="saved-empty">${l(
      '还没有保存的方案。求解后在方案详情里点「保存」即可。',
      '還沒有儲存的方案。求解後在方案詳情裡點「儲存」即可。',
      'No saved plans yet. Solve a loadout and use "Save" in the plan detail.',
    )}</p>`;
    return;
  }
  const query = String(document.getElementById('savedBuildsSearch')?.value || '').trim().toLocaleLowerCase();
  const rows = builds.map((build, index) => ({ build, index }));
  const visible = query
    ? rows.filter(({ build }) => String(build?.name ?? '').toLocaleLowerCase().includes(query))
    : rows;
  if (visible.length === 0) {
    list.innerHTML = `<p class="saved-empty">${l(
      '没有匹配的方案。', '沒有符合的方案。', 'No plan matches this search.',
    )}</p>`;
    return;
  }
  list.innerHTML = visible.map(({ build, index }) => {
    const input = readSavedBuildInput(build);
    const statLine = STATS.map(stat => Number(input.targets?.[stat] ?? 0)).join(' · ');
    const name = String(build.name ?? '');
    const canLoad = Boolean(build.result);
    const targetsLine = STATS
      .map(stat => `${STAT_LABELS[stat]} ${Number(input.targets?.[stat] ?? 0)}`).join(' · ');
    return `<article class="saved-item" role="listitem" data-build-index="${index}" onclick="selectSavedBuild(${index})">
      <div class="saved-item-main">
        <span class="saved-item-name">${escapeHtml(name)}</span>
        <small class="saved-item-meta">${escapeHtml(savedBuildSubtitle(build))}</small>
        <span class="saved-item-stats">${escapeHtml(statLine)}</span>
        <p class="saved-item-detail" hidden>${escapeHtml(l(
          `目标六维：${targetsLine}`, `目標六維：${targetsLine}`, `Targets: ${targetsLine}`,
        ))}</p>
      </div>
      <div class="saved-item-actions">
        <button type="button" class="btn saved-item-load" ${canLoad ? '' : 'disabled'} onclick="event.stopPropagation();loadBuild(getSavedBuilds()[${index}])" aria-label="${escapeHtml(l(`载入 ${name}`, `載入 ${name}`, `Load ${name}`))}">${l('载入', '載入', 'Load')}</button>
        <button type="button" class="btn saved-item-rename" onclick="event.stopPropagation();renameBuild(${index})">${l('重命名', '重新命名', 'Rename')}</button>
        <button type="button" class="btn danger saved-item-delete" onclick="event.stopPropagation();deleteBuild(${index})" aria-label="${escapeHtml(l(`删除 ${name}`, `刪除 ${name}`, `Delete ${name}`))}">${icon('trash')}<span class="sr-only">${l('删除', '刪除', 'Delete')}</span></button>
      </div>
    </article>`;
  }).join('');
}

// The command bar is sticky and its height depends on how its own controls wrap,
// which is a function of the window width, the language and the current search
// state — not something a media query can express. A fixed `top` offset for the
// sticky plan browser would therefore slide the filter/sort toolbar underneath
// the bar at some widths (measured: 60px at 1440, 100px at 1024). The bar's real
// height is measured and published as a custom property instead, so the sticky
// offsets and the panel's height cap follow it.
function syncCommandBarOffset() {
  const bar = document.getElementById("searchCommandBar");
  const root = document.documentElement;
  if (!bar || !root) return;
  const height = Math.ceil(bar.getBoundingClientRect().height);
  if (height > 0) root.style.setProperty("--cmd-bar-offset", `${height}px`);
}

function initializeCommandBarOffset() {
  const bar = document.getElementById("searchCommandBar");
  if (!bar) return;
  syncCommandBarOffset();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(syncCommandBarOffset).observe(bar);
  } else {
    window.addEventListener("resize", syncCommandBarOffset);
  }
}

function initializeFloatingJumpVisibility() {
  const controls = document.getElementById('floatJump');
  const footer = document.querySelector('.footer');
  if (!controls || !footer || !('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver(entries => {
    controls.classList.toggle('is-footer-visible', entries[0]?.isIntersecting === true);
  });
  observer.observe(footer);
}


Object.assign(window, {
  adjFragment,
  adjPlus3,
  analyzeArmorUpgrades,
  addManualOwnedArmor,
  applyBungieSavedLoadout,
  applyEquippedLoadout,
  applyOwnedArmorItemAction,
  applyNearestTargetSuggestion,
  balanceTargetsToBudget,
  bungieLogin,
  bungieLogout,
  handleBungieLoadoutDetailKeydown,
  changePageLanguage,
  // The presentation projection and its Tuning formatters, so the browser
  // regression suite can assert slot ordering / assignment-index mapping against
  // synthetic entries as well as against solved plans.
  createEntryPieceRows,
  formatIntrinsicTuning,
  formatFinalMinusTuning,
  renderAcquisitionPlan,
  unifiedEntryKey,
  clearAllBuilds,
  copyDimExportLink,
  cycleFuzzyMode,
  cyclePriority,
  exportInventorySolution,
  editBungieSavedLoadout,
  equipInventorySolution,
  clearImportedInventory,
  clearOwnedGear,
  deleteBuild,
  renameBuild,
  selectSavedBuild,
  getSavedBuilds,
  getSelectedUnifiedEntry,
  getSelectedUnifiedWitness,
  handleDimCsvFile,
  handleUpgradeDragEnd,
  handleUpgradeDragStart,
  handleUpgradeDrop,
  importInventoryFromBungie,
  loadBuild,
  removeManualOwnedArmor,
  refineWithPriorities,
  resetConstraints,
  resetTargetStats,
  saveBuild,
  selectInventorySolution,
  setBungieTargetCharacter,
  setPlanFilter,
  setPlanSort,
  showMorePlans,
  toggleBungieLoadoutDetail,
  toggleConditionsDrawer,
  toggleManualOwnedEditor,
  setCalculatorMode,
  shouldAutoRefresh,
  solve,
  setSearchProfile,
  stopSearches,
  switchSolution,
  sync10to5,
  sync5to10,
  toggleExoticMode,
  toggleInventoryImportPanel,
  toggleOnlyPlus5Tuning,
  togglePlus3,
  setAllUpgradeLocked,
  openSavedBuildsDrawer,
  closeOverlays,
  submitSaveBuild,
  updateImportOptions,
  updateInventoryExoticSlot,
  updateInventorySolveOptions,
  updateUpgradeRequiredStat,
  updateExoticFramework,
  updateExoticPerkOptions,
  updateManualOwnedTertiaryOptions,
  setManualOwnedEditorOpen,
  updateRefineActionState,
  updateUpgradeOption,
  updateUpgradePiece,
  updateSetRequirementMode,
  updateSetRequirementPicks,
  updateUpgradeTuningChoice
});

// ============================================================
// INIT
// ============================================================
initializePageLanguage();
renderSearchControls();
renderInputs();
renderExoticInputs();
syncPlus3PreferenceUI();
toggleConditionsDrawer(false);
document.addEventListener('toggle', rememberDetailDisclosure, true);
// At most one current-loadout piece is expanded: opening a summary closes the
// previously open one, so the card cannot grow back into five stacked editors.
document.addEventListener('toggle', event => {
  const row = event.target;
  if (!row?.matches?.('.upgrade-piece-row[open]')) return;
  for (const other of document.querySelectorAll('#upgradeBuildEditor .upgrade-piece-row[open]')) {
    if (other !== row) other.open = false;
  }
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeOverlays();
});
document.getElementById('inputCard').addEventListener('input', () => {
  stopSearches();
  updateBudget();
  scheduleRealtimeRanges();
  saveCurrentDraft();
  saveUpgradeDraft();
});
document.getElementById('inputCard').addEventListener('change', () => {
  scheduleRealtimeRanges();
  saveCurrentDraft();
  saveUpgradeDraft();
});
updateBudget();
loadCurrentDraft();
renderSavedBuilds();
initializeUpgradeOptimizer();
initializeFloatingJumpVisibility();
initializeCommandBarOffset();
handleBungieOAuthCallback().finally(syncBungieAutoRefresh);
document.addEventListener("visibilitychange", () => {
  syncBungieAutoRefresh();
  if (shouldAutoRefresh()) importInventoryFromBungie({ silent: true });
});
document.addEventListener('input', event => {
  if (event.target.closest('#fragmentCard, #upgradeBuildCard')) stopSearches();
});
