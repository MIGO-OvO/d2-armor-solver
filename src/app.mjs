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
  setStatLabels,
  t
} from "./core/armor-model.mjs";
import {
  analyzeUpgradeAsync,
  calculateReachabilityAsync,
  solveInventoryAsync,
  solveLoadoutAsync,
} from "./core/armor-engine-client.mjs";
import {
  createBalancedTargetPlan,
} from "./core/budget.mjs";
import { rankInventoryPlans } from "./core/inventory-plan.mjs";
import { buildRepository } from "./core/build-repository.mjs";
import {
  UPGRADE_SLOTS,
  createUpgradePieceFromItem,
  finalizeUpgradeTotals,
  getManualUpgradeArmorTotals,
  getUpgradeConfig,
  getUpgradeModifierBudget,
  normalizeUpgradePiece,
} from "./core/upgrade-optimizer.mjs";
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
  getActiveSetBonuses,
  getArmorSetByHash,
  getSetName,
  getSetPieceCounts,
} from "./core/armor-sets.mjs";
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "./core/armor-mods.data.mjs";

let lastTargets = null;
let lastFragments = null;
let lastNumPlus5 = 0;
let lastNumPlus10 = 0;
let lastNumPlus3 = 0;
let allSolutions = [];
let currentSolutionIdx = 0;
let lastExoticSettings = null;
let showAllSolutions = false;

function displayArchetypeKey(config, exoticIndex = null) {
  const freq = {};
  for (let index = 0; index < 5; index++) {
    if (index === exoticIndex) continue;
    const name = config[index].archetype;
    freq[name] = (freq[name] || 0) + 1;
  }
  const key = Object.entries(freq)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `${getArchetypeLabel(name)}×${count}`)
    .join(getPageLanguage() === 'en' ? ', ' : '、');
  if (exoticIndex === null || exoticIndex === undefined) return key;
  const exoticLabel = getArchetypeLabel(config[exoticIndex].archetype);
  return l(
    `${t('exoticClassItem')}：${exoticLabel} | ${t('legendaryArmor')}：${key}`,
    `${t('exoticClassItem')}：${exoticLabel} | ${t('legendaryArmor')}：${key}`,
    `${t('exoticClassItem')}: ${exoticLabel} | ${t('legendaryArmor')}: ${key}`
  );
}

function getUpgradeStatOptions(selectedValue, excludedValue = '') {
  return STATS
    .filter(stat => stat !== excludedValue)
    .map(stat => `<option value="${stat}" ${stat === selectedValue ? 'selected' : ''}>${STAT_LABELS[stat]}</option>`)
    .join('');
}

// ============================================================
// UI HELPERS
// ============================================================

function getStatInputHTML(prefix, stat, val) {
  const isUpgradeRequired = upgradeRequiredStats.includes(stat);
  return `
    <div class="input-group ${prefix === 'target' ? 'target-stat-group' : ''}">
      <div class="stat-label" style="color:${STAT_COLORS[stat]};display:flex;align-items:center;justify-content:space-between;">
        <span class="icon-text stat-name target-stat-name">${icon(stat)}<span>${STAT_LABELS[stat]}</span></span>
        ${prefix === 'target' ? `<label class="lock-control">
          <input type="checkbox" id="targetLock_${stat}" aria-label="${STAT_LABELS[stat]} ${t('lock')}" style="accent-color:var(--accent);width:13px;height:13px;">${icon('lock', { size: 'sm' })}<span>${t('lock')}</span>
        </label><label class="required-control">
          <input type="checkbox" id="upgradeRequired_${stat}" ${isUpgradeRequired ? 'checked' : ''}
            aria-label="${STAT_LABELS[stat]} ${t('upgradeRequiredStat')}"
            onchange="updateUpgradeRequiredStat('${stat}',this.checked)"><span class="required-label-long">${t('upgradeRequiredStat')}</span><span class="required-label-short">${t('upgradeRequiredStatShort')}</span>
        </label>` : ''}
      </div>
      <input type="number" id="${prefix}_${stat}" value="${val||0}"${prefix === 'target' ? ` aria-describedby="rangeHint_${stat}"` : ''}
        inputmode="numeric" min="0" max="200" aria-label="${STAT_LABELS[stat]}"
        style="border-color:${(val||0)!==0?STAT_COLORS[stat]:'var(--border)'}">
      ${prefix === 'target' ? `<div class="stat-range-hint" id="rangeHint_${stat}" aria-live="polite"></div>` : ''}
    </div>`;
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
      `每件+3防具：傑作5 + 免費1 = <strong>6點</strong>，${n3}件 × 6 = <strong>${armorBase}點</strong>。`,
      `Each +3 armor piece: 5 Masterwork + 1 free point = <strong>6</strong>; ${n3} × 6 = <strong>${armorBase}</strong>.`
    )
    : l(
      `未启用+3模式，+5/-5调整可将属性降至0，护甲基础最低<strong>0点</strong>。`,
      `未啟用+3模式，+5/-5調整可將數值降至0，防具基礎最低<strong>0點</strong>。`,
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
              `全部5件使用+3模式，沒有-5調整欄位可用。所有數值最低為防具基礎${armorBase}點+碎片。`,
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
                `<strong>調整欄位不足！</strong>${availSlots}個欄位可用，但需${totalNeeded}個：<br>${slotLines}<br>請提高低數值目標或增加+3件數。`,
                `<strong>Not enough Tuning slots.</strong> ${availSlots} available, ${totalNeeded} required:<br>${slotLines}<br>Raise low targets or use more +3 pieces.`
              ) + '</span>';
            }
            return icon('check') + ' ' + l(
              `调整槽足够（${availSlots}个，已用${totalNeeded}个）。基准为${noTuneBase}点，低于该值的属性由-5调整压低。`,
              `調整欄位足夠（${availSlots}個，已用${totalNeeded}個）。基準為${noTuneBase}點，低於該值的數值由-5調整壓低。`,
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
  const enabled = document.getElementById('useExoticMode')?.checked;
  const showSettings = enabled && calculatorMode !== 'upgrade';
  document.getElementById('exoticSettingsBody').style.display = showSettings ? 'block' : 'none';
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
  if (controlState) {
    renderInputs();
    for (const stat of STATS) {
      document.getElementById('target_' + stat).value = controlState.targets[stat];
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
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
    targetLocksExplicit: true,
    fragments: Object.fromEntries(STATS.map(s => [s, getFragVal(s)])),
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
  const draftLanguage = draft.language || draft.exotic?.language;
  if (['zh-chs', 'zh-cht', 'en'].includes(draftLanguage) && draftLanguage !== getPageLanguage()) {
    document.getElementById('pageLanguage').value = draftLanguage;
    changePageLanguage();
  }

  for (const stat of STATS) {
    if (draft.targets && draft.targets[stat] !== undefined) {
      document.getElementById('target_' + stat).value = draft.targets[stat];
    }
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
    stat, Math.max(0, getVal('target_' + stat) - (fragments[stat] || 0)),
  ]));
  const cacheKey = [
    exoticSettings.config.baseStats ? STATS.map(stat => exoticSettings.config.baseStats[stat]).join(',') : '',
    numPlus5, numPlus10, numPlus3,
    STATS.map(stat => fragments[stat] || 0).join(','),
    STATS.map(stat => getVal('target_' + stat)).join(','),
    exoticSettings.priorityOrder.join(','),
  ].join('|');
  const cached = nearestTargetCache.get(cacheKey);
  if (cached) return cached;

  const result = (await solveLoadoutAsync({
    target: targets,
    numPlus5,
    numPlus10,
    numPlus3,
    constraints: buildExoticConstraints(exoticSettings, fragments),
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
      console.error('Reachability calculation failed', error);
      resetRealtimeRangeUI();
    }
    return;
  }
  if (revision !== realtimeRangeRevision) return;

  if (!reachable.feasible) {
    nearestTargetSuggestion = await getNearestTargetSuggestion(
      exoticSettings, numPlus5, numPlus10, numPlus3, fragments
    );
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
  updateInlineRangeHints(reachable.ranges, locks);
  const items = STATS.map(stat => {
    const range = reachable.ranges[stat];
    const locked = locks.includes(stat);
    return `<div class="range-item${locked ? ' is-locked' : ''}">
      <div class="range-item-label" style="color:${STAT_COLORS[stat]}">${STAT_LABELS[stat]}${locked ? ' ' : ''}</div>
      <div class="range-item-value">${formatReachableRange(range)}</div>
    </div>`;
  }).join('');
  const lockText = locks.length > 0
    ? `${l('已锁定','已鎖定','Locked')} ${joinLocalized(locks.map(stat => `${STAT_LABELS[stat]} ${lockedTargets[stat]}`))}`
    : l('尚未锁定具体属性，先显示全局可达范围','尚未鎖定具體數值，先顯示全域可達範圍','No stats locked yet; showing the global reachable range');
  summary.innerHTML = `<div class="range-panel">
    <div class="range-panel-head">
      <div class="range-panel-title">${l('职业金真实可达范围','職業金真實可達範圍','Exotic Class Item reachable range')}</div>
      <div class="range-panel-caption">${lockText}</div>
    </div>
    <div class="range-grid">${items}</div>
    <div style="margin-top:8px;font-size:11px;color:var(--text-dim);">
      ${l(
        '可达值已逐件枚举异域职业物品、四件传说护甲、调整模组与护甲模组。“步进5”表示只可选择该序列中的值，斜杠分隔不同的可达序列。',
        '可達值已逐件列舉異域職業物品、四件傳說防具、調整模組與防具模組。「步進5」表示只可選擇該序列中的值，斜線分隔不同的可達序列。',
        'Reachable values enumerate the Exotic Class Item, four Legendary Armor pieces, Tuning Mods, and Armor Mods. “Step 5” means only values in that sequence are valid; slashes separate different reachable sequences.'
      )}
    </div>
  </div>`;
  summary.style.display = 'block';
}

function scheduleRealtimeRanges() {
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
  msgs.innerHTML = '';
  delete msgs.dataset.imperfectShown;
  showAllSolutions = false;
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

  // Compute adjusted target (armor must provide this)
  // First pass: calculate raw adjTarget
  const adjTarget = {};
  const armorMinPerStat = numPlus3 * 6; // +3 pieces give each mw stat +1 (5->6), +5/-5 can tune to 0
  let minViolations = [];

  for (const s of STATS) {
    let raw = targets[s] - (fragments[s] || 0);
    if (targets[s] === 0 || raw < 0) raw = 0; // Game floors at 0

    // Check against achievable minimum (final = armor + fragment, armor can't go below armorMinPerStat)
    const finalMin = Math.max(0, armorMinPerStat + (fragments[s] || 0));
    if (targets[s] < finalMin) {
      minViolations.push({ stat: s, target: targets[s], min: finalMin });
      adjTarget[s] = finalMin;
    } else {
      adjTarget[s] = raw;
    }
  }

  if (minViolations.length > 0 && !exoticSettings) {
    const vList = minViolations.map(v => l(
      `${STAT_LABELS[v.stat]}：目标<strong>${v.target}</strong>，当前最低只能到<strong>${v.min}</strong>（${armorMinPerStat}点护甲基础 + 碎片${fragments[v.stat]||0}）。请改为${v.min}或以上。`,
      `${STAT_LABELS[v.stat]}：目標<strong>${v.target}</strong>，目前最低只能到<strong>${v.min}</strong>（${armorMinPerStat}點防具基礎 + 碎片${fragments[v.stat]||0}）。請改為${v.min}或以上。`,
      `${STAT_LABELS[v.stat]}: target <strong>${v.target}</strong>, but the current minimum is <strong>${v.min}</strong> (${armorMinPerStat} armor base + ${fragments[v.stat]||0} from Fragments). Set it to ${v.min} or higher.`
    )
    ).join('<br>');
    msgs.innerHTML += `<div class="msg error">${icon('block')}
      ${l('<strong>以下属性目标低于可达最低值，无法求解：</strong>','<strong>以下數值目標低於可達最低值，無法求解：</strong>','<strong>These target stats are below their reachable minimums:</strong>')}<br>
      ${vList}
    </div>`;
    return; // Stop — user must fix values first
  }

  // Check tuning slot feasibility
  // Stats below the "no-tuning" baseline need -5 slots. Sum must fit within available slots.
  if (numPlus3 < 5 && !exoticSettings) {
    const availSlots = 5 - numPlus3;
    const noTuneBase = armorMinPerStat + availSlots * 5;
    const slotDetails = [];
    let totalSlotsNeeded = 0;

    for (const s of STATS) {
      if (adjTarget[s] < noTuneBase) {
        const deficit = noTuneBase - adjTarget[s];
        const needed = Math.ceil(deficit / 5);
        totalSlotsNeeded += needed;
        slotDetails.push({ stat: s, adj: adjTarget[s], deficit, needed, frag: fragments[s] || 0 });
      }
    }

    if (totalSlotsNeeded > availSlots) {
      const detailList = slotDetails.map(d => l(
        `${STAT_LABELS[d.stat]}：目标${targets[d.stat]}（护甲需${d.adj}点），比基准${noTuneBase}低${d.deficit}，需${d.needed}个-5槽。`,
        `${STAT_LABELS[d.stat]}：目標${targets[d.stat]}（防具需${d.adj}點），比基準${noTuneBase}低${d.deficit}，需${d.needed}個-5欄位。`,
        `${STAT_LABELS[d.stat]}: target ${targets[d.stat]} (${d.adj} armor points), ${d.deficit} below baseline ${noTuneBase}; needs ${d.needed} -5 slot(s).`
      )
      ).join('<br>');
      msgs.innerHTML += `<div class="msg error">${icon('block')}
        ${l('<strong>调整槽不足，无法求解：</strong>','<strong>調整欄位不足，無法求解：</strong>','<strong>Not enough Tuning slots:</strong>')}<br>
        ${l(
          `只有<strong>${availSlots}</strong>个-5调整槽可用，但低于基准（${noTuneBase}点）的属性共需<strong>${totalSlotsNeeded}</strong>个：`,
          `只有<strong>${availSlots}</strong>個-5調整欄位可用，但低於基準（${noTuneBase}點）的數值共需<strong>${totalSlotsNeeded}</strong>個：`,
          `Only <strong>${availSlots}</strong> -5 Tuning slots are available, but stats below baseline ${noTuneBase} require <strong>${totalSlotsNeeded}</strong>:`
        )}<br>
        ${detailList}<br><br>
        ${l('请提高低属性目标、增加+3件数（会提高基准但释放槽位），或降低高属性目标。','請提高低數值目標、增加+3件數（會提高基準但釋放欄位），或降低高數值目標。','Raise low targets, use more +3 pieces (raising the baseline but freeing slots), or lower high targets.')}
      </div>`;
      return;
    }
  }

  let adjSum = 0;
  for (const s of STATS) adjSum += adjTarget[s];

  const totalBudget = 450 + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
  const fragSumVal = Object.values(fragments).reduce((a,b)=>a+b,0);

  // Validation: total sum
  const diff = adjSum - totalBudget;
  if (diff > 0 && !exoticSettings) {
    msgs.innerHTML += `<div class="msg error">${icon('block')}
      ${l(
        `<strong>目标总和超出预算</strong><br>护甲需提供<strong>${adjSum}</strong>点（目标${Object.values(targets).reduce((a,b)=>a+b,0)} - 碎片${fragSumVal}），但护甲上限为<strong>${totalBudget}</strong>点（基础450 + 模组${numPlus5*5+numPlus10*10}）。<br>超出<strong>${diff}</strong>点，请降低目标或增加模组。`,
        `<strong>目標總和超出預算</strong><br>防具需提供<strong>${adjSum}</strong>點（目標${Object.values(targets).reduce((a,b)=>a+b,0)} - 碎片${fragSumVal}），但防具上限為<strong>${totalBudget}</strong>點（基礎450 + 模組${numPlus5*5+numPlus10*10}）。<br>超出<strong>${diff}</strong>點，請降低目標或增加模組。`,
        `<strong>Target total exceeds the budget.</strong><br>Armor must provide <strong>${adjSum}</strong> (${Object.values(targets).reduce((a,b)=>a+b,0)} target minus ${fragSumVal} from Fragments), but the maximum is <strong>${totalBudget}</strong> (450 base + ${numPlus5*5+numPlus10*10} from mods).<br>Lower targets or add ${diff} points of mods.`
      )}
    </div>`;
    return;
  } else if (diff < 0 && !exoticSettings) {
    msgs.innerHTML += `<div class="msg warn">${icon('warn')}
      ${l(
        `<strong>目标总和（${adjSum}点）低于护甲产出（${totalBudget}点），相差${-diff}点。</strong><br>多余点数无法消除。请将目标总和调整为<strong>${totalBudget}</strong>再求解。`,
        `<strong>目標總和（${adjSum}點）低於防具產出（${totalBudget}點），相差${-diff}點。</strong><br>多餘點數無法消除。請將目標總和調整為<strong>${totalBudget}</strong>再求解。`,
        `<strong>The target total (${adjSum}) is ${-diff} below armor output (${totalBudget}).</strong><br>Those points cannot be removed. Set the total to <strong>${totalBudget}</strong> and solve again.`
      )}
    </div>`;
    return;
  }
  if (exoticSettings && diff !== 0) {
    const priorityText = exoticSettings.priorityOrder.length > 0
      ? exoticSettings.priorityOrder.map(s => STAT_LABELS[s]).join(' -> ')
      : l('综合接近目标','綜合接近目標','overall closeness to targets');
    msgs.innerHTML += `<div class="msg warn">${icon('warn')}
      ${l(
        `异域职业物品模式允许目标超出或低于当前预算。求解器将按<strong>${priorityText}</strong>的顺序计算可达极限，再兼顾其余属性。`,
        `異域職業物品模式允許目標超出或低於目前預算。求解器將依<strong>${priorityText}</strong>的順序計算可達極限，再兼顧其餘數值。`,
        `Exotic Class Item mode allows targets above or below the current budget. The solver maximizes reachable values in this order: <strong>${priorityText}</strong>, then balances the remaining stats.`
      )}
    </div>`;
  }

  // Run solver
  loading.classList.add('show');
  loading.setAttribute('aria-busy', 'true');
  document.getElementById('btnSolve').disabled = true;

  try {
    const solverConstraints = buildExoticConstraints(exoticSettings, fragments);
    allSolutions = await solveLoadoutAsync({
      target: adjTarget,
      numPlus5,
      numPlus10,
      numPlus3,
      constraints: solverConstraints,
      exoticSettings,
    });
    currentSolutionIdx = 0;

    if (!allSolutions[0]) {
      msgs.innerHTML += `<div class="msg error">${icon('block')}${l('未找到满足当前异域职业物品框架的候选方案。','找不到符合目前異域職業物品原型的候選方案。','No candidate matches the current Exotic Class Item archetype.')}</div>`;
      return;
    }
    if (exoticSettings) {
      const exoticRanges = await calculateExoticRanges(
        exoticSettings.config, numPlus5, numPlus10, numPlus3, fragments
      );
      for (const solution of allSolutions) {
        solution.exoticRanges = exoticRanges;
        solution.priorityOrder = [...exoticSettings.priorityOrder];
      }
    }
    refreshInventoryPlansFromSolutions({ rerender: false });
    const bestResult = allSolutions[0];

    // Count +3 pieces in best result
    const plus3Count = bestResult.tuningAssignments.filter(t => t.mode === '+3').length;

    // Post-solve analysis
    if (bestResult.score === 0) {
      msgs.innerHTML += `<div class="msg info">${icon('check')}${isOnlyPlus5Tuning()
        ? l('找到完美配装！全部护甲使用+5/-5调整。','找到完美配裝！全部防具使用+5/-5調整。','Perfect loadout found. Every piece uses +5/-5 Tuning.')
        : l(`找到完美配装！${plus3Count}件使用+3模式。`,`找到完美配裝！${plus3Count}件使用+3模式。`,`Perfect loadout found. ${plus3Count} piece(s) use +3 mode.`)}</div>`;
    } else if (exoticSettings) {
      const limitLines = exoticSettings.priorityOrder.map(stat => {
        const actual = bestResult.totals[stat] + (fragments[stat] || 0);
        const target = targets[stat];
        return actual < target
          ? l(`${STAT_LABELS[stat]}目标${target}，当前异域职业物品框架下最高为<strong>${actual}</strong>`,`${STAT_LABELS[stat]}目標${target}，目前異域職業物品原型下最高為<strong>${actual}</strong>`,`${STAT_LABELS[stat]} target ${target}; maximum with this Exotic Class Item archetype is <strong>${actual}</strong>`)
          : l(`${STAT_LABELS[stat]}达到目标<strong>${target}</strong>`,`${STAT_LABELS[stat]}達成目標<strong>${target}</strong>`,`${STAT_LABELS[stat]} reaches <strong>${target}</strong>`);
      });
      msgs.innerHTML += `<div class="msg info">${icon('check')}${limitLines.join(l('；','；','; ')) || l('已找到固定异域职业物品框架下的最佳方案。','已找到固定異域職業物品原型下的最佳方案。','Best loadout for the fixed Exotic Class Item archetype found.')}</div>`;
    } else if (bestResult.score >= 100) {
      msgs.innerHTML += `<div class="msg warn">${icon('warn')}${l('最优解与目标有偏差，当前约束下可能无法精确达成。','最佳解與目標有偏差，目前限制下可能無法精確達成。','The best result differs from the targets; an exact result may be impossible under the current constraints.')}</div>`;
    }

    displayAllResults(bestResult, targets, fragments);
  } catch (error) {
    console.error('Armor solver failed', error);
    msgs.innerHTML += '<div class="msg error">' + icon('block') + l(
      '求解过程中发生错误，请重试。',
      '求解過程中發生錯誤，請重試。',
      'The solver failed. Please try again.'
    ) + '</div>';
  } finally {
    loading.classList.remove('show');
    loading.setAttribute('aria-busy', 'false');
    document.getElementById('btnSolve').disabled = false;
  }
}

// ============================================================
// DISPLAY RESULTS
// ============================================================

function buildRefineCard(targets, finalTotals) {
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
    <div role="columnheader">${l('强制最低','強制最低','Force minimum')}<small>${l('压到可达最低值','降至可達最低值','Use reachable min')}</small></div>
    <div role="columnheader">${l('当前结果','目前結果','Current')}<small>${l('相对目标','相對目標','vs target')}</small></div>`;

  for (const s of STATS) {
    const diff = finalTotals[s] - targets[s];
    const notExact = diff !== 0;
    const notOver100 = finalTotals[s] <= 100;
    // Force-minimum: checked when at the achievable minimum (armor base + fragments)
    const armorBase = getEnabledPlus3Count() * 6;
    const statMin = Math.max(0, armorBase + (parseInt(document.getElementById('fragVal_' + s)?.textContent) || 0));
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
      `${STAT_LABELS[s]}：强制为最低可达值 ${statMin}`,
      `${STAT_LABELS[s]}：強制為最低可達值 ${statMin}`,
      `${STAT_LABELS[s]}: force reachable minimum ${statMin}`
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
  return { priorities, le100, force0 };
}

async function refineWithPriorities() {
  if (!lastTargets || allSolutions.length === 0) return;

  const constraints = readConstraints();
  if (lastExoticSettings) {
    Object.assign(constraints, buildExoticConstraints(lastExoticSettings, lastFragments));
  }
  const hasConstraint = Object.values(constraints.priorities).some(v=>v) ||
                        Object.values(constraints.le100).some(v=>v) ||
                        Object.values(constraints.force0).some(v=>v);
  if (!hasConstraint) {
    alert(l('请至少选择一个优化目标或约束条件。','請至少選擇一個最佳化目標或限制條件。','Select at least one optimization goal or constraint.'));
    return;
  }

  // Re-compute adjusted target
  const adjTarget = {};
  const armorMinPerStat = lastNumPlus3 * 6;
  for (const s of STATS) {
    let raw = lastTargets[s] - (lastFragments[s] || 0);
    if (lastTargets[s] === 0 || raw < 0) raw = 0;
    const finalMin = Math.max(0, armorMinPerStat + (lastFragments[s] || 0));
    // force0 constraint: override target to minimum possible
    if (constraints.force0[s]) adjTarget[s] = finalMin;
    else if (lastTargets[s] < finalMin) adjTarget[s] = finalMin;
    else adjTarget[s] = raw;
  }

  // Show loading
  document.getElementById('loading').classList.add('show');

  try {
    const newSolutions = await solveLoadoutAsync({
      target: adjTarget,
      numPlus5: lastNumPlus5,
      numPlus10: lastNumPlus10,
      numPlus3: lastNumPlus3,
      constraints,
      exoticSettings: lastExoticSettings,
    });
    const newResult = newSolutions[0];
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

    // Store new solutions
    const prevResult = allSolutions[currentSolutionIdx];
    allSolutions = newSolutions;
    currentSolutionIdx = 0;

    // Full refresh (comparison, pieces, refine card, nav)
    displayAllResults(newResult, lastTargets, lastFragments);

    // Add before/after cost analysis on top
    const newFinal = { ...newResult.totals };
    const oldFinal = { ...prevResult.totals };
    for (const s of STATS) { newFinal[s] += (lastFragments[s] || 0); oldFinal[s] += (lastFragments[s] || 0); }

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
    console.error('Armor refinement failed', error);
    document.getElementById('messages').innerHTML += '<div class="msg error">' +
      icon('block') + l(
        '重新优化失败，请重试。',
        '重新最佳化失敗，請重試。',
        'Refinement failed. Please try again.'
      ) + '</div>';
  } finally {
    document.getElementById('loading').classList.remove('show');
  }
}

function generateExoticRecommendation(result) {
  const config = result.config;
  if (result.exoticIndex !== null && result.exoticIndex !== undefined) {
    const exotic = config[result.exoticIndex];
    const selection = result.exoticSelection || lastExoticSettings;
    const purpleFreq = {};
    for (let i = 0; i < config.length; i++) {
      if (i === result.exoticIndex) continue;
      const name = config[i].archetype;
      purpleFreq[name] = (purpleFreq[name] || 0) + 1;
    }
    let html = '<div style="padding:10px 14px;border-radius:8px;border:1px solid rgba(244,181,61,0.35);background:rgba(244,181,61,0.06);font-size:13px;line-height:1.8;">';
    if (selection) {
      const classId = selection.classId || lastExoticSettings?.classId || 'hunter';
      const primaryId = selection.primaryPerkId || lastExoticSettings?.primaryPerkId;
      const secondaryId = selection.secondaryPerkId || lastExoticSettings?.secondaryPerkId;
      html += `<div><strong>${EXOTIC_CLASS_LABELS[classId]?.[getExoticLanguage()] || selection.classLabel || ''}</strong> · ` +
        `${getExoticPerkName(primaryId, selection.primaryPerkName || '')} + ${getExoticPerkName(secondaryId, selection.secondaryPerkName || '')}</div>`;
    }
    const fixedPrefix = getPageLanguage() === 'en' ? `${t('exoticClassItem')}: ` : `${t('exoticClassItem')}：`;
    const statSep = getPageLanguage() === 'en' ? ' ' : '';
    html += `<div><strong style="color:var(--accent);">${fixedPrefix}</strong>${getArchetypeLabel(exotic.archetype)} · ${t('primaryStat')}${statSep}${STAT_LABELS[exotic.primary]} 30 / ${t('secondaryStat')}${statSep}${STAT_LABELS[exotic.secondary]} 25 / ${t('tertiaryStat')}${statSep}${STAT_LABELS[exotic.tertiary]} 20</div>`;
    html += `<div><strong>${t('legendaryArmor')}：</strong>` +
      Object.entries(purpleFreq).map(([name, count]) => `${getArchetypeLabel(name)} ×${count}`).join(l('，','，',', ')) + '</div>';
    html += `<div style="color:var(--text-dim);">${l('调整属性已参与自动优化，无需预先指定。','調整數值已參與自動最佳化，無需預先指定。','Tuning is optimized automatically; no stat needs to be preselected.')}</div></div>`;
    return html;
  }

  const freq = {};
  for (let i = 0; i < 5; i++) { const name = config[i].archetype; freq[name] = (freq[name] || 0) + 1; }
  const entries = Object.entries(freq).sort((a, b) => a[1] - b[1]);
  const allSame = entries.length === 1;
  let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
  html += `<tr style="color:var(--text-dim);"><th style="text-align:left;padding:4px;">${t('armorArchetype')}</th><th style="text-align:center;padding:4px;">${l('件数','件數','Count')}</th><th style="text-align:left;padding:4px;">${l('用途','用途','Use')}</th></tr>`;
  for (let idx = entries.length - 1; idx >= 0; idx--) {
    const [name, count] = entries[idx];
    const isExotic = count === entries[0][1] && !allSame;
    html += `<tr style="border-top:1px solid var(--border);"><td style="padding:4px;">${getArchetypeLabel(name)}</td><td style="text-align:center;padding:4px;font-weight:700;">${count}</td><td style="padding:4px;">${isExotic ? t('exoticArmor') : t('legendaryArmor')}</td></tr>`;
  }
  html += '</table>'; return html;
}

function renderSolutionStatRows(counts, prefix = '') {
  return Object.entries(counts).map(([stat, count]) => `
    <div class="solution-stat-row">
      <span style="color:${STAT_COLORS[stat]};">${prefix}${STAT_LABELS[stat]}</span>
      <strong>×${count}</strong>
    </div>`).join('');
}

function formatFarmTuning(piece) {
  return piece.tuningMode === 'plus3'
    ? l('+3模式', '+3模式', '+3 mode')
    : l(`固定 +5 ${STAT_LABELS[piece.tuningTo]}`, `固定 +5 ${STAT_LABELS[piece.tuningTo]}`, `Fixed +5 ${STAT_LABELS[piece.tuningTo]}`);
}

function renderFarmRequirements(result) {
  const plan = getOwnedArmorPlan(result, { allowEmpty: true });
  if (!plan) return '';
  const missing = plan.pieces.filter(piece => !piece.item);
  if (missing.length === 0) {
    return `<section class="farm-requirements is-complete">
      <div class="farm-requirements-heading">
        <h3>${l('已有护甲已满足方案', '已有防具已符合方案', 'Owned armor completes this solution')}</h3>
        <span>${icon('check')}${l('无需刷取', '無需取得', 'No farming needed')}</span>
      </div>
    </section>`;
  }

  const fixedExotic = getSelectedInventoryExotic();
  const classItemSettings = document.getElementById('useExoticMode')?.checked ? getExoticSettings() : null;
  const rows = missing.map(piece => {
    const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === piece.slot);
    const frame = getArchetypeLabel(piece.archetype);
    const setName = piece.farmSetHash ? formatInventoryPlanSet(piece.farmSetHash) : '';
    let identity = frame;
    if (piece.exotic && piece.slot === 'classItem') {
      identity = `${getExoticClassItemName(classItemSettings?.classId || importClassFilter || 'hunter')} · ${frame}`;
    } else if (piece.exotic && fixedExotic?.slot === piece.slot) {
      identity = `${escapeHtml(fixedExotic.name)} · ${frame}`;
    }
    const detail = [
      `${t('tertiaryStat')} ${STAT_LABELS[piece.tertiary]}`,
      formatFarmTuning(piece),
      setName,
    ].filter(Boolean).join(' · ');
    return `<div class="farm-requirement-row">
      <span class="farm-requirement-kind">${piece.exotic ? l('异域', '異域', 'Exotic') : l('待刷', '待取得', 'Farm')}</span>
      <strong>${getUpgradeSlotLabel(slotIndex)}</strong>
      <span class="farm-requirement-body"><b>${identity}</b><small>${detail}</small></span>
    </div>`;
  }).join('');

  return `<section class="farm-requirements">
    <div class="farm-requirements-heading">
      <div>
        <h3 class="farm-requirements-title">${l('还需刷取', '還需取得', 'Still to farm')}</h3>
        <p>${l('以下护甲尚未在已有清单或手动新增中找到精确匹配。', '以下防具尚未在已有清單或手動新增中找到精確符合。', 'These pieces have no exact match in the imported or manually added armor.')}</p>
      </div>
      <span>${missing.length} ${l('件', '件', 'piece(s)')}</span>
    </div>
    <div class="farm-requirement-list">${rows}</div>
    <p class="farm-requirements-note">${l(
      '刷取时优先核对框架、第三属性和固定 +5 属性；−5 属性可在装备上自由选择，并按上方建议分配以达到方案总属性。',
      '取得時優先核對原型、第三數值和固定 +5 數值；−5 數值可在裝備上自由選擇，並依上方建議分配以達到方案總數值。',
      'When farming, prioritize the frame, tertiary stat, and fixed +5 roll. The −5 stat is freely selected and can follow the suggestion above to reach the final totals.'
    )}</p>
  </section>`;
}

function displayPieceResults(result, _fragments) {
  const piecesOutput = document.getElementById('piecesOutput');
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
    if (tuning.mode !== '+3') {
      tuneFromCount[tuning.from] = (tuneFromCount[tuning.from] || 0) + 1;
      tuneToCount[tuning.to] = (tuneToCount[tuning.to] || 0) + 1;
    }
    const armorMod = result.modAssignments[index];
    if (armorMod) {
      const key = `${armorMod.stat}|${armorMod.size}`;
      modCount[key] = (modCount[key] || 0) + 1;
    }
  }

  const plus3Count = result.tuningAssignments.filter(assignment => assignment.mode === '+3').length;
  const exoticConfig = result.exoticIndex !== null && result.exoticIndex !== undefined
    ? result.config[result.exoticIndex]
    : null;
  const exoticSummary = exoticConfig
    ? `<div class="solution-exotic-summary">
        <strong>${t('exoticClassItem')}</strong>
        <span>${getArchetypeLabel(exoticConfig.archetype)} · ${t('primaryStat')} ${STAT_LABELS[exoticConfig.primary]} 30 / ${t('secondaryStat')} ${STAT_LABELS[exoticConfig.secondary]} 25 / ${t('tertiaryStat')} ${STAT_LABELS[exoticConfig.tertiary]} 20</span>
      </div>`
    : '';
  const archetypeRows = Object.entries(archCount).map(([name, count]) => `
    <div class="solution-archetype-row">
      <span>${getArchetypeLabel(name)}</span>
      <strong>×${count}</strong>
    </div>`).join('');
  const fixedTuningRows = Object.keys(tuneToCount).length > 0
    ? renderSolutionStatRows(tuneToCount, '+5 ')
    : `<p class="solution-allocation-empty">${l('本方案没有固定 +5 调整。', '本方案沒有固定 +5 調整。', 'This solution has no fixed +5 Tuning.')}</p>`;
  const suggestedMinusRows = Object.keys(tuneFromCount).length > 0
    ? renderSolutionStatRows(tuneFromCount, '−5 ')
    : `<p class="solution-allocation-empty">${l('无需分配 −5。', '無需分配 −5。', 'No −5 allocation needed.')}</p>`;
  const armorModRows = Object.entries(modCount).map(([key, count]) => {
    const [stat, size] = key.split('|');
    return `<div class="solution-stat-row"><span style="color:${STAT_COLORS[stat]};">+${size} ${STAT_LABELS[stat]}</span><strong>×${count}</strong></div>`;
  }).join('') || `<p class="solution-allocation-empty">${l('无', '無', 'None')}</p>`;

  piecesOutput.innerHTML = `
    <section class="solution-detail-section">
      <div class="solution-detail-heading">
        <h3>${l('护甲构成', '防具構成', 'Armor composition')}</h3>
        <p>${l('框架和第三属性属于装备固定内容，刷取时需要逐件核对。', '原型和第三數值屬於裝備固定內容，取得時需要逐件核對。', 'Frames and tertiary stats are fixed on the item and must be checked per piece.')}</p>
      </div>
      ${exoticSummary}
      <div class="solution-archetype-list">${archetypeRows}</div>
    </section>

    <section class="solution-detail-section solution-allocation-section">
      <div class="solution-detail-heading">
        <h3>${l('属性与模组分配', '數值與模組分配', 'Stats and mod allocation')}</h3>
        <p>${l('先核对装备固定属性，再按建议配置可自由调整的内容。', '先核對裝備固定數值，再依建議配置可自由調整的內容。', 'Check fixed item rolls first, then configure the freely adjustable choices.')}</p>
      </div>
      <div class="solution-allocation-grid">
        <div class="solution-allocation-group">
          <div class="solution-allocation-title"><strong>${t('tertiaryStat')}</strong><span>${l('装备固定 20', '裝備固定 20', 'Fixed roll · 20')}</span></div>
          <div class="solution-stat-list">${renderSolutionStatRows(tertCount)}</div>
        </div>
        <div class="solution-allocation-group solution-tuning-group">
          <div class="solution-allocation-title"><strong>${t('tuningMod')}</strong><span>${l('固定 +5 优先核对', '固定 +5 優先核對', 'Check fixed +5 first')}</span></div>
          <div class="solution-tuning-primary">
            <span>${l('固定 +5 属性', '固定 +5 數值', 'Fixed +5 rolls')}</span>
            <div class="solution-stat-list">${fixedTuningRows}</div>
          </div>
          ${plus3Count > 0 ? `<div class="solution-tuning-plus3"><span>${l('+3模式', '+3模式', '+3 mode')}</span><strong>×${plus3Count}</strong></div>` : ''}
          <div class="solution-tuning-secondary">
            <span>${l('建议 −5 分配（可自由选择）', '建議 −5 分配（可自由選擇）', 'Suggested -5 allocation (freely selected)')}</span>
            <div class="solution-stat-list">${suggestedMinusRows}</div>
          </div>
        </div>
        <div class="solution-allocation-group">
          <div class="solution-allocation-title"><strong>${t('armorMod')}</strong><span>${l('玩家安装', '玩家安裝', 'Player-installed')}</span></div>
          <div class="solution-stat-list">${armorModRows}</div>
        </div>
      </div>
    </section>

    ${renderFarmRequirements(result)}
  `;

  const exoticCard = document.getElementById('exoticCard');
  const exoticRec = document.getElementById('exoticRecommendation');
  exoticRec.innerHTML = generateExoticRecommendation(result);
  exoticCard.style.display = 'block';
}

function displayAllResults(result, targets, fragments, { scroll = true } = {}) {
  const results = document.getElementById('results');
  results.classList.add('show');
  document.getElementById('floatJump').style.display = 'flex';
  const finalTotals = { ...result.totals };
  for (const s of STATS) finalTotals[s] += (fragments[s] || 0);

  renderSolutionNav();

  // Comparison grid
  const compGrid = document.getElementById('comparisonGrid');
  let compHTML = '';
  for (const st of STATS) {
    const target = targets[st];
    const actual = finalTotals[st];
    const diff = actual - target;
    let diffClass = diff === 0 ? 'good' : (diff > 0 ? 'ok' : 'bad');
    let diffText = diff === 0
      ? `${icon('check', { size: 'sm' })} ${l('精确','精確','Exact')}`
      : (diff > 0 ? `+${diff}` : `${diff}`);

    compHTML += `
      <div class="comp-item">
        <div class="stat-label icon-text" style="color:${STAT_COLORS[st]}">${icon(st)}${STAT_LABELS[st]}</div>
        <div class="stat-values">
          <span style="color:${STAT_COLORS[st]}">${actual}</span>
          <span style="color:var(--text-dim);font-size:14px;"> / ${target}</span>
        </div>
        <div class="diff ${diffClass}">${diffText}</div>
      </div>`;
  }
  compGrid.innerHTML = compHTML;

  const rangeSummary = document.getElementById('exoticRangeSummary');
  if (result.exoticRanges) {
    const priorityOrder = result.priorityOrder || [];
    const rangeItems = STATS.map(st => {
      const range = result.exoticRanges[st];
      const rank = priorityOrder.indexOf(st);
      const badge = rank >= 0 ? `<span style="color:var(--accent);font-size:10px;">${l('优先','優先','Priority ')}${rank + 1}</span>` : '';
      return `<div style="padding:8px;border-radius:6px;background:var(--bg);border:1px solid var(--border);text-align:center;">
        <div class="icon-text" style="color:${STAT_COLORS[st]};font-weight:700;justify-content:center;">${icon(st)}${STAT_LABELS[st]} ${badge}</div>
        <div style="font-size:16px;font-weight:700;">${formatReachableRange(range)}</div>
      </div>`;
    }).join('');
    rangeSummary.innerHTML = `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">
      ${l(
        `固定异域职业物品框架后，逐件枚举四件传说护甲、调整模组和护甲模组得到真实可达范围（不叠加下方自定义硬约束）：`,
        `固定異域職業物品原型後，逐件列舉四件傳說防具、調整模組和防具模組得到真實可達範圍（不疊加下方自訂硬性限制）：`,
        `With the Exotic Class Item archetype fixed, real reachable ranges are enumerated across four Legendary Armor pieces, Tuning Mods, and Armor Mods (custom hard constraints below are not applied):`
      )}
    </div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">${rangeItems}</div>`;
    rangeSummary.style.display = 'block';
  } else {
    rangeSummary.innerHTML = '';
    rangeSummary.style.display = 'none';
  }

  document.getElementById('scoreDisplay').innerHTML =
    l(
      `得分：<strong>${result.score.toFixed(0)}</strong>（0=完美）| 总属性：<strong>${Object.values(finalTotals).reduce((a,b)=>a+b,0)}</strong>`,
      `得分：<strong>${result.score.toFixed(0)}</strong>（0=完美）| 總數值：<strong>${Object.values(finalTotals).reduce((a,b)=>a+b,0)}</strong>`,
      `Score: <strong>${result.score.toFixed(0)}</strong> (0 = perfect) | Total stats: <strong>${Object.values(finalTotals).reduce((a,b)=>a+b,0)}</strong>`
    );

  // "已有毕业装备" section
  buildOwnedGearSection(finalTotals, targets);

  // Show refine card
  const refineCard = document.getElementById('refineCard');
  refineCard.style.display = 'block';
  buildRefineCard(targets, finalTotals);

  // Pieces output
  displayPieceResults(result, fragments);
  if (scroll) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatInventoryItemTuning(item) {
  if (item?.tuningMode === 'plus3') return l('+3调整', '+3調整', '+3 Tuning');
  const tuningTo = item?.tuningTo || item?.tuningStat;
  return tuningTo
    ? l(`+5${STAT_LABELS[tuningTo]} 调谐`, `+5${STAT_LABELS[tuningTo]} 調諧`, `+5 ${STAT_LABELS[tuningTo]} Tuning`)
    : l('调整属性未知', '調整數值未知', 'Unknown Tuning');
}

function formatInventoryPlanSet(setHash) {
  if (!setHash) return '';
  const set = getArmorSetByHash(setHash);
  return set ? getSetName(set) : String(setHash);
}

function createOwnedArmorPlanRequest(solutions, maxResults, { allowEmpty = false } = {}) {
  if (calculatorMode !== 'solve' || solutions.length === 0) return null;
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
  if (items.length === 0 && !allowEmpty) return null;
  return {
    solutions,
    items,
    classId,
    fixedExotic: classItemSettings ? null : getSelectedInventoryExotic(),
    setRequirement: snapshotSetRequirement(),
    maxResults,
  };
}

function getOwnedArmorPlan(solution, { allowEmpty = true } = {}) {
  const request = createOwnedArmorPlanRequest([solution], 1, { allowEmpty });
  return request ? rankInventoryPlans(request)[0] || null : null;
}

function refreshInventoryPlansFromSolutions({ rerender = true } = {}) {
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
  currentSolutionIdx = Math.max(0, allSolutions.indexOf(plans[0]?.solution));
  if (rerender && allSolutions.length > 0) {
    displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments, { scroll: false });
  }
}

// ============================================================
// SOLUTION NAV
// ============================================================

// Warning shown when no loadout hits every target exactly. Extracted because
// renderSolutionNav needs it on two different paths.
function appendImperfectWarning() {
  const msgDiv = document.getElementById('messages');
  if (msgDiv.dataset.imperfectShown === '1') return;
  msgDiv.dataset.imperfectShown = '1';

  const adjSum = STATS.reduce((s, st) => s + Math.max(0, (lastTargets[st] || 0) - (lastFragments[st] || 0)), 0);
  const budget = 450 + lastNumPlus3 * 3 + lastNumPlus5 * 5 + lastNumPlus10 * 10;
  const advice = adjSum !== budget
    ? l(
        `目标总和与预算不一致（差${Math.abs(budget - adjSum)}点），请先调整目标使总和等于预算。`,
        `目標總和與預算不一致（差${Math.abs(budget - adjSum)}點），請先調整目標使總和等於預算。`,
        `Target total differs from budget by ${Math.abs(budget - adjSum)}. Adjust targets to match the budget first.`
      )
    : l(
        '尝试<strong>修改调整+3数量</strong>，或<strong>调整六维属性目标</strong>。',
        '嘗試<strong>修改調整+3數量</strong>，或<strong>調整六維數值目標</strong>。',
        'Try changing the number of +3 Tuning pieces or adjusting target stats.'
      );

  msgDiv.insertAdjacentHTML('beforeend', `<div class="msg warn">${icon('warn')}${l(
      '没有配装能精确达成全部目标。以下方案<strong>按符合程度排序</strong>（越靠前越接近目标）。',
      '沒有配裝能精確達成全部目標。以下方案<strong>按符合程度排序</strong>（越前越接近目標）。',
      'No loadout reaches every target exactly. The solutions below are <strong>sorted by fit</strong> (closer to the top is closer to target).'
    )}<br>${icon('hint')} ${advice}</div>`);
}

function toggleAllSolutions() {
  showAllSolutions = !showAllSolutions;
  renderSolutionNav();
}

function renderSolutionNav() {
  const navBar = document.getElementById('solutionNav');

  // Filter: if any perfect solutions exist, only show those
  const perfectSolutions = allSolutions.filter(s => s.score === 0);
  const rankedSolutions = perfectSolutions.length > 0 ? perfectSolutions : allSolutions;
  const hasPerfect = perfectSolutions.length > 0;

  if (allSolutions.length <= 1 && !hasPerfect) {
    navBar.style.display = 'none';
    if (allSolutions.length > 0 && allSolutions[0].score > 0 && !lastExoticSettings) {
      appendImperfectWarning();
    }
    return;
  }

  const total = rankedSolutions.length;
  const truncated = !showAllSolutions && total > SOLUTION_PREVIEW_COUNT;
  const showSolutions = truncated ? rankedSolutions.slice(0, SOLUTION_PREVIEW_COUNT) : rankedSolutions;

  navBar.style.display = 'block';
  const title = hasPerfect
    ? l(
        `共 ${total} 种精确达成方案，按易刷程度排序`,
        `共 ${total} 種精確達成方案，按取得難度排序`,
        `${total} exact solutions, sorted by farmability`
      )
    : l(
        `无精确方案，${total} 种近似方案，按符合程度排序`,
        `無精確方案，${total} 種近似方案，按符合程度排序`,
        `No exact solution; ${total} approximate solutions sorted by fit`
      );
  const shownNote = truncated
    ? l(
        `　显示最优 ${showSolutions.length} 种`,
        `　顯示最佳 ${showSolutions.length} 種`,
        `　showing the top ${showSolutions.length}`
      )
    : '';

  let navHTML = `<div class="icon-text" style="font-size:14px;color:var(--text-dim);margin-bottom:6px;">`
    + `${icon(hasPerfect ? 'check' : 'warn')}<span>${title}${shownNote}</span></div>`;
  navHTML += `<div style="margin-bottom:8px;"><button class="btn" onclick="document.getElementById('compCard').scrollIntoView({behavior:'smooth'})" style="font-size:11px;padding:4px 10px;">${icon('down')}${l('跳过方案列表','跳過方案列表','Skip solution list')}</button></div>`;
  navHTML += `<div role="list" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">`;
  for (let si = 0; si < showSolutions.length; si++) {
    const sol = showSolutions[si];
    const key = displayArchetypeKey(sol.config, sol.exoticIndex);
    const active = sol === allSolutions[currentSolutionIdx];
    const badge = sol.score === 0 ? icon('check', { size: 'sm' }) : '';
    navHTML += `<button role="listitem" aria-pressed="${active}" onclick="switchSolution(${allSolutions.indexOf(sol)})"
      style="padding:8px 14px;border-radius:8px;border:2px solid ${active?'var(--accent)':'var(--border)'};background:${active?'rgba(244,181,61,0.12)':'var(--bg)'};color:${active?'#fff':'var(--text)'};cursor:pointer;font-size:13px;font-family:inherit;font-weight:${active?'700':'400'};transition:all 0.15s;text-align:left;">
      <span style="color:${active?'var(--accent)':'var(--text-dim)'};">#${si+1}</span> ${badge} <span style="color:var(--archetype);">${key}</span>
    </button>`;
  }
  navHTML += '</div>';

  if (total > SOLUTION_PREVIEW_COUNT) {
    navHTML += `<button class="btn" onclick="toggleAllSolutions()" style="margin-top:10px;width:100%;">`
      + (showAllSolutions
        ? l(`仅显示最优 ${SOLUTION_PREVIEW_COUNT} 种`, `僅顯示最佳 ${SOLUTION_PREVIEW_COUNT} 種`, `Show only the top ${SOLUTION_PREVIEW_COUNT}`)
        : l(`显示其余 ${total - SOLUTION_PREVIEW_COUNT} 种方案`, `顯示其餘 ${total - SOLUTION_PREVIEW_COUNT} 種方案`, `Show remaining ${total - SOLUTION_PREVIEW_COUNT} solutions`))
      + '</button>';
  }
  navBar.innerHTML = navHTML;

  if (!hasPerfect && !lastExoticSettings) appendImperfectWarning();
}

function switchSolution(realIdx) {
  if (realIdx < 0 || realIdx >= allSolutions.length) return;
  currentSolutionIdx = realIdx;
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
    archetypeId: ARCHETYPES.find(entry => entry.name === piece?.archetype)?.id || ARCHETYPES[0].id,
    tertiary: piece?.tertiary || STATS[0],
    tuning: piece?.tuningMode === 'plus3' ? '+3' : piece?.tuningTo || '+3',
  };
}

function getManualTertiaryOptions(archetypeId) {
  const archetype = ARCHETYPES.find(entry => entry.id === archetypeId) || ARCHETYPES[0];
  return STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
}

function renderOwnedArmorMatch(piece) {
  const item = piece.item;
  const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === piece.slot);
  const sourceLabel = item.manualOwned
    ? l('手动', '手動', 'Manual')
    : l('清单', '清單', 'Inventory');
  const itemName = item.name || l('手动新增护甲', '手動新增防具', 'Manually added armor');
  const setName = item.setHash ? formatInventoryPlanSet(item.setHash) : '';
  const details = [
    getArchetypeLabel(item.archetypeId || piece.archetype),
    `${t('tertiaryStat')} ${STAT_LABELS[item.tertiary || piece.tertiary] || '—'}`,
    formatInventoryItemTuning(item),
    setName,
  ].filter(Boolean).join(' · ');
  return `<div class="owned-armor-match">
    <span class="owned-armor-source${item.manualOwned ? ' is-manual' : ''}">${sourceLabel}</span>
    <strong>${getUpgradeSlotLabel(slotIndex)}</strong>
    <span class="owned-armor-match-body"><b>${escapeHtml(itemName)}</b><small>${details}</small></span>
  </div>`;
}

function renderManualOwnedItem(item, index) {
  const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === item.slot);
  const tuning = item.tuningMode === 'plus3' ? l('+3调整', '+3調整', '+3 Tuning') : `+5 ${STAT_LABELS[item.tuningTo]}`;
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
  const solution = allSolutions[currentSolutionIdx];
  if (!section || !solution) return;
  const plan = getOwnedArmorPlan(solution);
  const matches = plan?.pieces?.filter(piece => piece.item) || [];
  const defaultPiece = getManualOwnedDefault(plan);
  const tertiaryOptions = getManualTertiaryOptions(defaultPiece.archetypeId);
  if (!tertiaryOptions.includes(defaultPiece.tertiary)) defaultPiece.tertiary = tertiaryOptions[0];
  const summary = plan
    ? l(`匹配 ${plan.ownedCount}/5 件 · 还需 ${plan.farmCount} 件`, `符合 ${plan.ownedCount}/5 件 · 尚需 ${plan.farmCount} 件`, `${plan.ownedCount}/5 matched · ${plan.farmCount} remaining`)
    : l('尚无可匹配的已有护甲', '尚無可符合的已有防具', 'No owned armor available to match');
  const matchContent = matches.length > 0
    ? `<div class="owned-armor-match-list">${matches.map(renderOwnedArmorMatch).join('')}</div>`
    : `<p class="owned-armor-empty">${l(
      importedInventory.length > 0 && !importClassFilter
        ? '请先在上方选择职业，再匹配清单中的已有护甲。'
        : '当前方案没有精确匹配的已有护甲，可在下方手动新增。',
      importedInventory.length > 0 && !importClassFilter
        ? '請先在上方選擇職業，再符合清單中的已有防具。'
        : '目前方案沒有精確符合的已有防具，可在下方手動新增。',
      importedInventory.length > 0 && !importClassFilter
        ? 'Choose a class above before matching imported armor.'
        : 'No owned armor exactly matches this solution. You can add a piece manually below.'
    )}</p>`;
  const manualList = manualOwnedItems.length > 0
    ? `<ul class="manual-owned-list">${manualOwnedItems.map(renderManualOwnedItem).join('')}</ul>`
    : '';

  document.body.classList.toggle('is-editing-owned-armor', manualOwnedEditorOpen);
  section.innerHTML = `<div class="owned-gear-header">
    <div>
      <h3 class="owned-gear-title">${l('已有护甲', '已有防具', 'Owned armor')}</h3>
      <p class="owned-gear-copy">${l(
        '这里只显示与当前方案精确匹配的已有件；导入清单或手动新增后，方案会自动更新。',
        '此處只顯示與目前方案精確符合的現有件；匯入清單或手動新增後，方案會自動更新。',
        'Only exact matches for this solution appear here. Importing or manually adding armor updates the solution automatically.'
      )}</p>
    </div>
    <div class="owned-gear-summary">${summary}</div>
  </div>
  ${matchContent}
  <details class="manual-owned-editor" ${manualOwnedEditorOpen ? 'open' : ''} ontoggle="setManualOwnedEditorOpen(this.open)">
    <summary>${icon('plus')}${l('手动新增已有护甲', '手動新增已有防具', 'Add owned armor manually')}<span>${manualOwnedItems.length}</span></summary>
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
      <label><span>${l('调整', '調整', 'Tuning')}</span><select id="manualOwnedTuning">
        <option value="+3" ${defaultPiece.tuning === '+3' ? 'selected' : ''}>${l('+3模式', '+3模式', '+3 mode')}</option>
        ${STATS.map(stat => `<option value="${stat}" ${stat === defaultPiece.tuning ? 'selected' : ''}>+5 ${STAT_LABELS[stat]}</option>`).join('')}
      </select></label>
      <button type="button" class="btn owned-gear-add" id="addManualOwnedButton" onclick="addManualOwnedArmor()">${icon('plus')}${l('添加并更新方案', '新增並更新方案', 'Add and update')}</button>
    </div>
    ${manualList}
    ${manualOwnedItems.length > 0 ? `<button type="button" class="btn manual-owned-clear" onclick="clearOwnedGear()">${icon('trash')}${l('清空手动新增', '清空手動新增', 'Clear manual armor')}</button>` : ''}
  </details>`;
  section.style.display = 'block';
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
  manualOwnedEditorOpen = true;
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function removeManualOwnedArmor(sourceId) {
  manualOwnedItems = manualOwnedItems.filter(item => item.sourceId !== sourceId);
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function clearOwnedGear() {
  manualOwnedItems = [];
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
let inventoryImportExpanded = false;
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
    ? EXOTIC_SLOT_ORDER.filter(slot => slot === 'classItem' || pool.some(item => item.slot === slot))
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
  }
  if (!names.some(entry => entry.key === inventoryFixedExoticKey)) {
    inventoryFixedExoticKey = "";
  }
  return { pool, slots, names };
}

function renderUpgradeImportPanel() {
  const el = document.getElementById("upgradeImportPanel");
  if (!el) return;
  const isScratchMode = calculatorMode === "solve";
  const importHeading = l("已有护甲", "已有防具", "Owned armor");
  const importDescription = isScratchMode
    ? l(
      "导入清单后，求解会自动优先匹配你已有的护甲。",
      "匯入清單後，求解會自動優先符合你已有的防具。",
      "Import an inventory to prioritize armor you already own.",
    )
    : l(
      "导入清单后，可填入当前穿戴或直接查找已有护甲方案。",
      "匯入清單後，可填入目前穿戴或直接尋找已有防具方案。",
      "Import an inventory to fill the equipped loadout or search owned armor directly.",
    );
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

  el.classList.toggle('is-collapsed', !inventoryImportExpanded);
  el.innerHTML = `
    <div class="upgrade-import-heading">
      <div>
        <h3>${importHeading}</h3>
        <p>${importDescription}</p>
      </div>
      <div class="upgrade-import-heading-actions">
        <span class="upgrade-import-state">${importState}</span>
        <label class="upgrade-import-file">
          <span class="btn upgrade-import-primary">${icon("folder")}${importedInventory.length > 0 ? l("重新导入", "重新匯入", "Replace inventory") : l("导入清单", "匯入清單", "Import inventory")}</span>
          <input type="file" id="dimCsvFile" accept=".csv,text/csv" onchange="handleDimCsvFile(this)">
        </label>
        <span class="bungie-auth" id="bungieAuthArea" aria-live="polite"></span>
        <button type="button" class="btn upgrade-import-toggle" id="toggleInventoryImportButton" aria-expanded="${inventoryImportExpanded}" aria-controls="upgradeImportBody" onclick="toggleInventoryImportPanel()">${icon(inventoryImportExpanded ? 'up' : 'down')}<span>${toggleLabel}</span></button>
      </div>
    </div>
    <div class="upgrade-import-body" id="upgradeImportBody" ${inventoryImportExpanded ? '' : 'hidden'}>
      <p class="upgrade-import-hint">${l(
        "清单可从 DIM → 设置 → 电子表格 → 防具（Export CSV）导出；文件只在浏览器本地处理。",
        "清單可從 DIM → 設定 → 試算表 → 防具（Export CSV）匯出；檔案只在瀏覽器本機處理。",
        "Export the list from DIM → Settings → Spreadsheets → Armor (Export CSV). The file stays in your browser."
      )}</p>
      <div class="upgrade-import-status" id="upgradeImportSummary" aria-live="polite"></div>
      <div class="upgrade-import-toolbar" aria-label="${l("已有护甲筛选与操作", "已有防具篩選與操作", "Owned armor filters and actions")}">
      <label class="import-class-select">
        <span>${l("职业", "職業", "Class")}</span>
        <select id="importClass" data-import-dependent onchange="updateImportOptions()">${classOptions}</select>
      </label>
      <label class="import-tier-toggle">
        <input type="checkbox" id="importTier5Only" data-import-dependent ${importTier5Only ? "checked" : ""} onchange="updateImportOptions()">
        <span>${l("仅 Tier 5", "僅 Tier 5", "Tier 5 only")}</span>
      </label>
      <div class="upgrade-import-actions">
        ${isScratchMode ? "" : `<button type="button" class="btn" data-import-dependent onclick="applyEquippedLoadout()">${icon("refresh")}${l("填入当前穿戴", "填入目前穿戴", "Fill equipped loadout")}</button>`}
        <button type="button" class="btn danger" data-import-dependent onclick="clearImportedInventory()">${icon("trash")}${l("清空", "清空", "Clear")}</button>
      </div>
      </div>
      <div class="inventory-solve-options" id="inventorySolveOptions">
      <div class="inventory-solve-option-copy">
        <strong>${l("从零配装：优先使用已有护甲", "從零配裝：優先使用已有防具", "Build from scratch: prefer owned armor")}</strong>
        <span>${l("按职业筛选库存；如需固定普通异域，再按部位和名称选择。方案优先减少刷取件数，其次选择最接近需求的同名异域。", "依職業篩選庫存；如需固定一般異域，再依部位和名稱選擇。方案優先減少取得件數，其次選擇最接近需求的同名異域。", "Filter inventory by class. To fix a regular Exotic, choose its slot and name. Plans minimize farming first, then prefer the closest owned copy of that Exotic.")}</span>
      </div>
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
      <p class="inventory-solve-option-hint" id="inventorySolveOptionHint">${l(
        "先选择职业，再从该职业已有异域中选择部位和名称；同名多件会自动比较框架、第三属性与 +5 调整。",
        "先選擇職業，再從該職業現有異域中選擇部位和名稱；同名多件會自動比較原型、第三數值與 +5 調整。",
        "Choose a class, slot, and Exotic name. Multiple owned copies are compared by frame, tertiary, and rolled +5 Tuning."
      )}</p>
      </div>
      <div class="upgrade-set-effects" id="upgradeSetEffects"></div>
    </div>
  `;
  updateImportSummary();
  updateInventorySolveOptions();
  renderSetEffects();
  renderBungieAuthState();
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

const BUNGIE_DISPLAY_NAME_KEY = "d2_armor_bungie_display_name_v1";
const BUNGIE_AUTO_REFRESH_MIN_MS = 15 * 1000;

let isBungieImporting = false;
let lastBungieImportAt = 0;
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
      "Bungie API key 無效或未獲審批，請檢查 Bungie 入口網站的应用設定。",
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

// Shared markup builder: both the import-area entry (#bungieAuthArea) and the
// header entry (#headerBungieAuth) render the same compact control set.
function bungieAuthAreaHtml(loginButtonId = "", nameClass = "bungie-auth-name") {
  if (!__BUNGIE_OAUTH_CLIENT_ID__) return "";
  const displayName = `<span class="${nameClass}">${escapeHtml(getBungieDisplayName())}</span>`;
  const logoutButton = `<button type="button" class="btn" onclick="bungieLogout()">${l("登出", "登出", "Sign out")}</button>`;
  if (isBungieImporting) {
    return displayName +
      `<button type="button" class="btn" disabled>${icon("refresh")}${l("导入中…", "匯入中…", "Importing…")}</button>` +
      logoutButton;
  }
  if (hasToken()) {
    return displayName +
      `<button type="button" class="btn" onclick="importInventoryFromBungie()">${icon("refresh")}${l("刷新库存", "重新整理庫存", "Refresh inventory")}</button>` +
      logoutButton;
  }
  return `<button type="button" class="btn"${loginButtonId ? ` id="${loginButtonId}"` : ""} onclick="bungieLogin()">${l("Bungie 登录", "Bungie 登入", "Bungie login")}</button>`;
}

// Single render entry point: updating the import-area entry keeps the header
// entry in sync (the login id stays unique to the import area).
function renderBungieAuthState() {
  const area = document.getElementById("bungieAuthArea");
  if (area) area.innerHTML = bungieAuthAreaHtml("bungieLoginButton");
  renderHeaderBungieAuthState();
}

function renderHeaderBungieAuthState() {
  const area = document.getElementById("headerBungieAuth");
  if (area) area.innerHTML = bungieAuthAreaHtml("", "header-bungie-auth-name");
}

function bungieLogin() {
  const state = crypto.randomUUID();
  try {
    sessionStorage.setItem("bungieOAuthState", state);
  } catch {
    // sessionStorage unavailable: the state check on return falls through and errors
  }
  window.location.href = buildAuthorizeUrl(state);
}

function bungieLogout() {
  clearToken();
  try {
    localStorage.removeItem(BUNGIE_DISPLAY_NAME_KEY);
  } catch {
    // ignore storage failures
  }
  bungieSubclassFragments = null;
  if (importSource === "bungie") {
    importedInventory = [];
    importSource = "";
    clearInventoryResults();
    renderUpgradeImportPanel();
  }
  renderBungieAuthState();
}

// Throttle gate for the visibilitychange auto-refresh: refresh at most once
// per 15s per visible-return. No timers involved.
function shouldAutoRefresh(now = Date.now()) {
  return hasToken() && now - lastBungieImportAt > BUNGIE_AUTO_REFRESH_MIN_MS;
}

async function importInventoryFromBungie() {
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
    const response = await bungieFetch(
      `/Destiny2/${membershipType}/Profile/${membershipId}/?components=${ARMOR_COMPONENTS.join(",")}`,
      { auth: true },
    );
    const { items, characters } = buildArmorInventory(response, { language: getPageLanguage() });
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
    applyImportedInventory(items, "bungie");
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
    if (calculatorMode === "solve") {
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
  const expectedState = sessionStorage.getItem("bungieOAuthState");
  if (!expectedState || params.get("state") !== expectedState) {
    showImportMessage(l(
      "登录状态校验失败，请重试。",
      "登入狀態驗證失敗，請重試。",
      "OAuth state check failed. Try again.",
    ));
    return;
  }
  sessionStorage.removeItem("bungieOAuthState");
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
function applyImportedInventory(items, source) {
  importedInventory = items;
  importSource = source;
  inventoryImportExpanded = true;
  clearInventoryResults();
  const importedClasses = new Set(items.map(item => item.classId).filter(Boolean));
  const detectedClass = detectEquippedClass(items);
  if (!importedClasses.has(importClassFilter)) {
    importClassFilter = detectedClass || (importedClasses.size === 1 ? [...importedClasses][0] : "");
  }
  inventoryExoticSlotFilter = "";
  inventoryFixedExoticKey = "";
  renderUpgradeImportPanel();
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
  renderUpgradeImportPanel();
  saveCurrentDraft();
}

function updateInventorySolveOptions({ refreshPlans = true } = {}) {
  const slotSelect = document.getElementById("inventoryExoticSlotFilter");
  const nameSelect = document.getElementById("inventoryFixedExoticName");
  if (slotSelect) inventoryExoticSlotFilter = slotSelect.value || "";
  if (nameSelect) inventoryFixedExoticKey = nameSelect.value || "";
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
          : selected
            ? l(`已固定：${selected.name}（${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}）；会优先使用同名且属性最接近的已有件。`, `已固定：${selected.name}（${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}）；會優先使用同名且數值最接近的現有件。`, `Fixed: ${selected.name} (${getUpgradeSlotLabel(UPGRADE_SLOTS.findIndex(slot => slot.id === selected.slot))}); the closest owned copy is preferred.`)
            : getFilteredInventoryExotics().length === 0
              ? l('当前职业和 Tier 5 筛选下没有可固定的普通异域。', '目前職業和 Tier 5 篩選下沒有可固定的一般異域。', 'No regular Exotics are available under the current class and Tier 5 filters.')
              : l('可选。先选异域部位和名称；没有完全匹配时，结果会显示同名最接近的现有件以及建议刷取属性。', '可選。先選異域部位和名稱；沒有完全符合時，結果會顯示同名最接近的現有件以及建議取得數值。', 'Optional. Choose an Exotic slot and name. If no copy fully matches, the result shows the closest owned copy and the roll to farm.');
  }
  saveUpgradeDraft();
  if (refreshPlans) refreshInventoryPlansFromSolutions();
}

function setImportClass(classId) {
  importClassFilter = classId || "";
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
  const items = pickCurrentLoadout(filterArmorItems(importedInventory, {
    classId: importClassFilter || null,
    tier5Only: importTier5Only,
  }));
  if (!importClassFilter && items[0]?.classId) setImportClass(items[0].classId);
  applyLoadoutItems(items);
  // Bungie imports carry the subclass item's installed Aspects/Fragments:
  // fill the fragment steppers from the selected class's current subclass.
  const fragmentsApplied = applySubclassFragmentsToUI();
  // Auto-set the six-stat targets to the current stats (armor + fragments),
  // so the user starts from where the equipped loadout already is instead of
  // re-entering the whole target set by hand.
  applyCurrentStatsToTargets();
  saveCurrentDraft();
  saveUpgradeDraft();
  showImportMessage(l(
    fragmentsApplied
      ? `已按当前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件护甲，并识别了当前星象/碎片的属性调整；六维目标已设为当前六维。`
      : `已按当前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件护甲；六维目标已设为当前六维。`,
    fragmentsApplied
      ? `已依目前穿戴（${getClassLabel(importClassFilter)}）填入 ${items.length} 件防具，並辨識了目前星象/碎片的數值調整；六維目標已設為目前六維。`
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
  if (!bungieSubclassFragments || !importClassFilter) return false;
  const fragments = bungieSubclassFragments[importClassFilter];
  if (!fragments) return false;
  for (const stat of STATS) {
    const el = document.getElementById('fragVal_' + stat);
    if (!el) continue;
    const value = fragments[stat] || 0;
    el.textContent = value;
    el.style.color = value !== 0 ? STAT_COLORS[stat] : '';
  }
  updateBudget();
  updateUpgradeBudgetSummary();
  scheduleRealtimeRanges();
  return true;
}

// Set the six-stat targets (target_*) to the current loadout's final stats:
// armor totals plus the (just-filled) fragment adjustments.
function applyCurrentStatsToTargets() {
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const totals = finalizeUpgradeTotals(
    getManualUpgradeArmorTotals(upgradeBuildState),
    getUpgradeFragments()
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

function renderSetEffects() {
  const el = document.getElementById("upgradeSetEffects");
  if (!el) return;
  // Scratch mode has no current five-piece loadout. Do not leak the last
  // upgrade draft's active bonuses into the shared set picker.
  const currentHashes = calculatorMode === "upgrade"
    ? (upgradeBuildState || []).map(piece => piece?.hash).filter(Boolean)
    : [];
  const hashes = currentHashes;
  const counts = getSetPieceCounts(hashes);
  const active = getActiveSetBonuses(hashes, getPageLanguage());
  const inventorySetHashes = [...new Set(importedInventory.map(item => item.setHash).filter(Boolean))];
  const pieceSetHashes = [...counts.keys()].map(set => set.hash);
  const available = [...new Set([...inventorySetHashes, ...pieceSetHashes])]
    .sort((a, b) => getSetName(getArmorSetByHash(a)).localeCompare(getSetName(getArmorSetByHash(b))));
  const setOptions = available.map(hash => {
    const set = getArmorSetByHash(hash);
    const isSelected = setRequirement.type !== "none"
      && (Number(setRequirement.setHash) === hash
        || Number(setRequirement.a) === hash
        || Number(setRequirement.b) === hash);
    return `<option value="${hash}" ${isSelected ? "selected" : ""}>${escapeHtml(getSetName(set))}</option>`;
  }).join("");
  const mode = setRequirement.type === "set" ? `set${setRequirement.count}` : setRequirement.type;
  const noSets = available.length === 0;
  const setRequirementDescription = calculatorMode === "solve"
    ? l(
      "可选。用于给从零配装规划指定套装；已有件会优先覆盖要求，缺失件会标出应刷的套装。",
      "可選。用於為從零配裝規劃指定套裝；現有件會優先覆蓋要求，缺失件會標出應取得的套裝。",
      "Optional. Set the desired set for scratch-build plans; owned pieces cover it first, and missing pieces are tagged with the set to farm.",
    )
    : l(
      "可选。启用后，求解会从已导入清单中搭配并保留所有固定装备。",
      "可選。啟用後，求解會從已匯入清單中搭配並保留所有固定裝備。",
      "Optional. When enabled, the solver builds from the imported list while preserving every fixed piece.",
    );

  el.innerHTML = `
    <div class="set-effects-head">
      <div>
        <span class="set-effects-title">${l("套装约束", "套裝約束", "Set requirement")}</span>
        <p>${setRequirementDescription}</p>
      </div>
      <div class="set-requirement-controls">
        <label>
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
          <select id="setReqB" onchange="updateSetRequirementPicks()">${setOptions}</select>
        </label>
      </div>
    </div>
    ${calculatorMode === "upgrade" ? `<div class="set-active-list">${active.length === 0
      ? `<div class="set-active-empty">${l(
        "当前五件护甲没有激活任何套装效果（2 件或 4 件）。",
        "目前五件防具沒有啟動任何套裝效果（2 件或 4 件）。",
        "No set bonus (2pc/4pc) is active with the current five pieces."
      )}</div>`
      : active.map(bonus => `
        <div class="set-active-card">
          <div class="set-active-head">
            <strong>${escapeHtml(getSetName(bonus.set))}</strong>
            <span class="set-active-count">${bonus.pieceCount}/${5}</span>
            <span class="set-active-tier">${bonus.requiredCount} ${l("件套", "件套", "pc")}</span>
          </div>
          <div class="set-active-name">${escapeHtml(bonus.name)}</div>
          <p class="set-active-desc">${escapeHtml(bonus.desc)}</p>
        </div>`).join("")}
    </div>` : ""}
    <div class="set-requirement-state" id="setRequirementState" aria-live="polite"></div>
  `;
  if (mode === "split") {
    const aSelect = document.getElementById("setReqA");
    const bSelect = document.getElementById("setReqB");
    if (aSelect && bSelect && bSelect.value === aSelect.value && bSelect.options.length > 1) {
      const alternate = [...bSelect.options].findIndex(option => option.value !== aSelect.value);
      if (alternate >= 0) bSelect.selectedIndex = alternate;
    }
  }
  syncUpgradeLocks();
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
  renderSetEffects();
  renderUpgradeBuildEditor();
  saveUpgradeDraft();
  refreshInventoryPlansFromSolutions();
}

function updateSetRequirementPicks() {
  updateSetRequirementMode(document.getElementById("setReqMode")?.value || "none");
}

// Whether the CURRENT five pieces already satisfy the chosen set requirement,
// and (informational) how many of each required set they carry. This no longer
// locks pieces — the requirement is enforced by the inventory solve, which may
// swap any non-fixed piece for a better set roll from the imported list.
function resolveSetRequirement() {
  const pieces = upgradeBuildState || [];
  const requirement = setRequirement;
  if (!requirement || requirement.type === "none") return { ok: true };

  const bySet = new Map();
  pieces.forEach(piece => {
    if (piece?.setHash) {
      if (!bySet.has(piece.setHash)) bySet.set(piece.setHash, []);
      bySet.get(piece.setHash).push(piece);
    }
  });

  if (requirement.type === "set") {
    const count = (bySet.get(Number(requirement.setHash)) || []).length;
    if (count < requirement.count) {
      return {
        ok: false,
        error: l(
          `“${getSetName(getArmorSetByHash(requirement.setHash))}”目前只有 ${count} 件，需要 ${requirement.count} 件才能满足要求。`,
          `「${getSetName(getArmorSetByHash(requirement.setHash))}」目前只有 ${count} 件，需要 ${requirement.count} 件才能滿足要求。`,
          `“${getSetName(getArmorSetByHash(requirement.setHash))}” currently has only ${count} piece(s) here; ${requirement.count} are required.`
        ),
      };
    }
    return { ok: true };
  }

  const aCount = (bySet.get(Number(requirement.a)) || []).length;
  const bCount = (bySet.get(Number(requirement.b)) || []).length;
  if (aCount < 2) {
    return {
      ok: false,
      error: l(
        `“${getSetName(getArmorSetByHash(requirement.a))}”不足 2 件。`,
        `「${getSetName(getArmorSetByHash(requirement.a))}」不足 2 件。`,
        `“${getSetName(getArmorSetByHash(requirement.a))}” needs at least 2 pieces.`
      ),
    };
  }
  if (bCount < 2) {
    return {
      ok: false,
      error: l(
        `“${getSetName(getArmorSetByHash(requirement.b))}”不足 2 件。`,
        `「${getSetName(getArmorSetByHash(requirement.b))}」不足 2 件。`,
        `“${getSetName(getArmorSetByHash(requirement.b))}” needs at least 2 pieces.`
      ),
    };
  }
  return { ok: true };
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
  const result = resolveSetRequirement();
  const requirement = setRequirement;
  if (!requirement || requirement.type === "none") {
    stateEl.innerHTML = "";
    return;
  }
  if (result.ok) {
    stateEl.innerHTML = `<div class="set-requirement-ok">${icon("check")}${l(
      "当前配装已满足所选套装要求。求解会从已导入清单中搜索更接近六维目标的搭配。",
      "目前配裝已滿足所選套裝要求。求解會從已匯入清單中搜尋更接近六維目標的搭配。",
      "The current pieces already satisfy the set requirement. Solving will still search the imported list for loadouts closer to your targets."
    )}</div>`;
    return;
  }
  stateEl.innerHTML = `<div class="set-requirement-ok">${icon("check")}${escapeHtml(result.error)}${l(
    " 求解时会从清单中搜索满足要求的组合。",
    " 求解時會從清單中搜尋滿足要求的組合。",
    " Solving will search the list for a loadout that satisfies it."
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
  updateUpgradePiece(index, 'tuningTo', STATS.includes(tuningTo) ? tuningTo : STATS[0], true);
}

function renderUpgradeBuildEditor(openIndex = null) {
  const editor = document.getElementById('upgradeBuildEditor');
  if (!editor) return;
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) {
    upgradeBuildState = UPGRADE_SLOTS.map((_, index) => normalizeUpgradePiece(upgradeBuildState[index], index));
  }
  const currentlyOpen = openIndex === null
    ? [...editor.querySelectorAll('.upgrade-piece-row[open]')].map(row => Number(row.dataset.index))
    : [openIndex];

  editor.innerHTML = `<div class="upgrade-piece-list">${upgradeBuildState.map((piece, index) => {
    const archetype = ARCHETYPES.find(item => item.id === piece.archetypeId) || ARCHETYPES[0];
    const tertiaryOptions = STATS.filter(stat => stat !== archetype.primary && stat !== archetype.secondary);
    const tuning = piece.tuningMode === 'plus3'
      ? l('调整 +3', '調整 +3', 'Tuning +3')
      : l(
          `调整 -5${STAT_LABELS[piece.tuningFrom]} / +5${STAT_LABELS[piece.tuningTo]}`,
          `調整 -5${STAT_LABELS[piece.tuningFrom]} / +5${STAT_LABELS[piece.tuningTo]}`,
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
      ? `<span class="upgrade-piece-name">${escapeHtml(piece.itemName)}</span> · `
      : '';
    const setLabel = setForPiece
      ? `<span class="upgrade-set-badge">${escapeHtml(getSetName(setForPiece))}</span> · `
      : '';
    const perkIds = [piece.primaryPerkId, piece.secondaryPerkId].filter(Boolean);
    const perkLabel = perkIds.length > 0
      ? `<span class="upgrade-piece-perks">${perkIds.map(id => escapeHtml(getExoticPerkName(id, id))).join(' + ')}</span> · `
      : '';
    const identity = `${pieceNameLabel}${setLabel}${perkLabel}<span class="upgrade-piece-arch">${getArchetypeLabel(archetype.id)}</span><span class="upgrade-piece-detail"> · ${t('tertiaryStat')} ${STAT_LABELS[piece.tertiary]} · ${tuning} · ${armorMod}</span>`;
    const status = piece.exotic
      ? l('异域固定件','異域固定件','Fixed Exotic')
      : (piece.locked ? l('固定不替换','固定不替換','Fixed') : l('可替换','可替換','Replaceable'));
    const statusIcon = piece.locked
      ? `<span class="upgrade-piece-status-icon" aria-hidden="true">${icon('lock', { size:'sm' })}</span>`
      : '';
    const isOpen = currentlyOpen.includes(index) || (currentlyOpen.length === 0 && index === 0);
    return `<details class="upgrade-piece-row" data-index="${index}" ${isOpen ? 'open' : ''}>
      <summary>
        <span class="upgrade-piece-slot">${getUpgradeSlotLabel(index)}</span>
        <span class="upgrade-piece-identity">${identity}</span>
        <span class="upgrade-piece-status ${piece.locked ? 'is-locked' : ''}">${statusIcon}<span>${status}</span></span>
      </summary>
      <div class="upgrade-piece-fields">
        <label class="input-group">
          <span>${t('armorArchetype')}</span>
          <select onchange="updateUpgradePiece(${index},'archetypeId',this.value,true)">
            ${ARCHETYPES.map(item => `<option value="${item.id}" ${item.id === piece.archetypeId ? 'selected' : ''}>${getArchetypeLabel(item.id)}</option>`).join('')}
          </select>
        </label>
        <label class="input-group">
          <span>${t('tertiaryStat')}</span>
          <select onchange="updateUpgradePiece(${index},'tertiary',this.value)">
            ${tertiaryOptions.map(stat => `<option value="${stat}" ${stat === piece.tertiary ? 'selected' : ''}>${STAT_LABELS[stat]}</option>`).join('')}
          </select>
        </label>
        <label class="input-group">
          <span>${t('tuningMod')}</span>
          <select onchange="updateUpgradeTuningChoice(${index},this.value)">
            <option value="plus3" ${piece.tuningMode === 'plus3' ? 'selected' : ''}>+3</option>
            ${STATS.map(stat => `<option value="plus5:${stat}" ${piece.tuningMode !== 'plus3' && piece.tuningTo === stat ? 'selected' : ''}>+5 ${STAT_LABELS[stat]}</option>`).join('')}
          </select>
        </label>
        ${piece.tuningMode === 'shift' ? `
        <label class="input-group">
          <span>${l('调整来源（-5，可自选）','調整來源（-5，可自選）','Tuning source (-5, your pick)')}</span>
          <select onchange="updateUpgradePiece(${index},'tuningFrom',this.value,true)">
            ${getUpgradeStatOptions(piece.tuningFrom, piece.tuningTo)}
          </select>
        </label>` : ''}
        <label class="input-group">
          <span>${t('armorMod')}</span>
          <select onchange="updateUpgradePiece(${index},'armorModSize',Number(this.value),true)">
            <option value="0" ${piece.armorModSize === 0 ? 'selected' : ''}>${t('none')}</option>
            <option value="5" ${piece.armorModSize === 5 ? 'selected' : ''}>+5</option>
            <option value="10" ${piece.armorModSize === 10 ? 'selected' : ''}>+10</option>
          </select>
        </label>
        <label class="input-group">
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
    `目標合計 ${targetSum}，碎片修正後需 ${armorNeeded}；基礎 450 + 目前調整/模組 ${modifierPoints}`,
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
  document.getElementById('inventoryResults').hidden = !isUpgrade || !lastInventoryResult?.results?.length;
  document.getElementById('floatJump').style.display = 'none';
  document.getElementById('messages').innerHTML = '';
  if (isUpgrade) {
    clearTimeout(realtimeRangeTimer);
    resetRealtimeRangeUI();
    toggleExoticMode();
    document.getElementById('results').classList.remove('show');
    document.getElementById('savedCard').style.display = 'none';
    updateUpgradeBudgetSummary();
  } else {
    toggleExoticMode();
    scheduleRealtimeRanges();
    renderSavedBuilds();
  }
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
  if (!assignment) return t('none');
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
  const roll = piece.tuningMode === 'plus3'
    ? l('调谐 +3', '調諧 +3', 'tuning +3')
    : l(`调谐 +5${STAT_LABELS[piece.tuningTo]}`, `調諧 +5${STAT_LABELS[piece.tuningTo]}`, `tuning +5 ${STAT_LABELS[piece.tuningTo]}`);
  return `${formatUpgradeConfigSummary(config)} · ${roll}`;
}

function buildUpgradeStatComparison(analysis, afterTotals) {
  return `<div class="upgrade-stat-comparison">${STATS.map(stat => {
    const before = (analysis.enteredBaseline || analysis.baseline).finalTotals[stat];
    const after = afterTotals[stat];
    const delta = after - before;
    const target = analysis.targets[stat];
    const isRequired = analysis.requiredStats?.includes(stat) === true;
    const targetReached = after >= target;
    const deltaClass = targetReached ? 'is-target-met' : 'is-shortfall';
    const targetStatus = targetReached
      ? l('达标','達標','met')
      : l(`差 ${target - after}`, `差 ${target - after}`, `${target - after} short`);
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
  const met = metrics.requiredAllReached;
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
        `左侧为当前六维；右侧按 ${projectedCount} 件未满大师护甲升满后，再保留五件并重排调谐与模组计算。升级大师不计作刷取新护甲。`,
        `左側為目前六維；右側按 ${projectedCount} 件未滿傑作防具升滿後，再保留五件並重排調諧與模組計算。升級傑作不計作取得新防具。`,
        `Left shows current stats. Right projects ${projectedCount} not-yet-fully-masterworked piece(s) to full masterwork, then keeps all five and rearranges tuning/mods. Masterworking is not counted as farming a replacement.`
      )
      : l(
        `左侧为当前六维；右侧的替换方案按所有保留护甲升满大师后的属性计算。共有 ${projectedCount} 件现有护甲需要升满大师，但不计作刷取替换件。`,
        `左側為目前六維；右側的替換方案按所有保留防具升滿傑作後的數值計算。共有 ${projectedCount} 件目前防具需要升滿傑作，但不計作取得替換件。`,
        `Left shows current stats. The replacement result projects every retained piece to full masterwork. ${projectedCount} current piece(s) need masterworking, but are not counted as farmed replacements.`
      ))
    : (keepOnly
      ? l(
        '左侧为当前六维，右侧为保留现有护甲、只重排调谐与模组后的六维。',
        '左側為目前六維，右側為保留目前防具、只重排調諧與模組後的六維。',
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
  return `<div class="upgrade-plan-flow">
    <h3>${l('替换顺序','替換順序','Replacement order')}</h3>
    <p class="upgrade-plan-copy">${l(
      '每一步都要刷到一件新护甲：框架、第三属性和调谐 +5 属性都必须对上（+5 属性是随护甲刷出来的，装上后不能改，只有 -5 来源可选）。刷到后按这一行的调谐和模组配好，六维就是这一步显示的数值。',
      '每一步都要刷到一件新防具：原型、第三數值和調諧 +5 數值都必須對上（+5 數值是隨防具刷出來的，裝上後不能改，只有 -5 來源可選）。取得後按這一行的調諧和模組配好，六維就是這一步顯示的數值。',
      'Each step needs a newly farmed piece whose archetype, tertiary stat, and rolled +5 tuning stat all match — the +5 side comes with the armor and cannot be changed, only the -5 source is yours to pick. Set it up as the row shows and you get the stats listed.'
    )}</p>
    <div class="upgrade-plan-steps">${plan.steps.map((step, index) => {
      const complete = step.evaluation.metrics.allReached;
      const finalTuning = plan.evaluation.tuningAssignments[step.slotIndex];
      const finalArmorMod = plan.evaluation.modAssignments[step.slotIndex];
      return `<div class="upgrade-plan-step">
        <span class="upgrade-plan-number">${index + 1}</span>
        <div class="upgrade-plan-change">
          <strong class="upgrade-plan-slot">${getUpgradeSlotLabel(step.slotIndex)}${step.tuningOnly
            ? ` · ${l('只差 +5 属性','只差 +5 數值','+5 stat only')}`
            : ''}</strong>
          <div class="upgrade-plan-swap">
            <span class="upgrade-plan-config upgrade-plan-config--before">${formatUpgradePieceSummary(step.beforePiece)}</span>
            <span class="upgrade-plan-arrow" aria-hidden="true">→</span>
            <strong class="upgrade-plan-config upgrade-plan-config--after">${formatUpgradePieceSummary(step.afterPiece)}</strong>
          </div>
        </div>
        <div class="upgrade-plan-setup">
          <span><strong>${l('调谐槽','調諧欄位','Tuning')}</strong>${formatUpgradeTuning(finalTuning)}</span>
          <span><strong>${t('armorMod')}</strong>${formatUpgradeArmorMod(finalArmorMod)}</span>
        </div>
        <div class="upgrade-plan-progress ${complete ? 'is-complete' : ''}">
          <strong>${complete
            ? l('换完后六维都达标','換完後六維都達標','All targets met after this step')
            : l(`换完还差 ${step.evaluation.metrics.shortfall} 点`, `換完還差 ${step.evaluation.metrics.shortfall} 點`, `${step.evaluation.metrics.shortfall} points short after this step`)}</strong>
          <div class="upgrade-plan-totals">${formatUpgradeTotals(step.evaluation.finalTotals)}</div>
        </div>
      </div>`;
    }).join('')}</div>
  </div>`;
}

function buildUpgradeAssignments(analysis, evaluation, open = false) {
  return `<details class="upgrade-assignment-details" ${open ? 'open' : ''}>
    <summary>${l('最终调谐与模组配置','最終調諧與模組配置','Final tuning and stat mods')}</summary>
    <div class="upgrade-assignment-list">${evaluation.configs.map((config, index) => `
      <div class="upgrade-assignment-row">
        <strong>${getUpgradeSlotLabel(index)}</strong>
        <span>${formatUpgradeConfigSummary(config)}</span>
        <span>${formatUpgradeTuning(evaluation.tuningAssignments[index])} · ${formatUpgradeArmorMod(evaluation.modAssignments[index])}</span>
      </div>`).join('')}
    </div>
    <p class="upgrade-empty">${l(
      '调谐的 +5 属性是护甲刷取时自带的，不能更改；表中只有 -5 来源和护甲模组是你可以自由分配的。',
      '調諧的 +5 數值是防具取得時自帶的，不能更改；表中只有 -5 來源和防具模組是你可以自由分配的。',
      'The +5 side of a tuning mod is rolled onto the armor and cannot be changed; only the -5 source and the armor mods above are yours to assign.'
    )}</p>
  </details>`;
}

// The alternative to a farming plan: keep all five pieces and only re-pick the
// tuning -5 sources and armor mods. This is what analysis.baseline already is.
function buildUpgradeKeepArmorAlternative(analysis) {
  const shortfall = analysis.baseline.metrics.shortfall;
  return `<details class="upgrade-assignment-details">
    <summary>${l(
      `备选方案：不刷护甲，保留现有五件重排调谐与模组，还差 ${shortfall} 点`,
      `備選方案：不刷防具，保留目前五件重排調諧與模組，還差 ${shortfall} 點`,
      `Alternative: no farming — keep all five pieces, rearrange tuning and mods, ${shortfall} points short`
    )}</summary>
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeBaselineNote(analysis, true)}
    <p class="upgrade-empty">${l(
      '不想刷取新护甲的话，这是现有五件能达到的最好六维；想完全达标，还是需要按上面的方案刷取替换件。',
      '不想刷取新防具的話，這是目前五件能達到的最好六維；想完全達標，還是需要按上面的方案刷取替換件。',
      'If you do not want to farm, this is the best your five current pieces can reach; to meet every target you still need the replacement plan above.'
    )}</p>
    ${buildUpgradeAssignments(analysis, analysis.baseline)}
  </details>`;
}

function renderUpgradeAnalysis(analysis, scroll = false) {
  if (!analysis) return;
  lastUpgradeAnalysis = analysis;
  const section = document.getElementById('upgradeResults');
  const body = document.getElementById('upgradeResultsBody');
  section.hidden = calculatorMode !== 'upgrade';
  let displayedEvaluation = analysis.baseline;

  if (analysis.baseline.metrics.allReached) {
    const enteredAlreadyReached = analysis.enteredBaseline.metrics.allReached;
    const needsMasterwork = (analysis.projectedMasterworkIndices?.length || 0) > 0;
    body.innerHTML = `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${l('当前配装','目前配裝','Current loadout')}</div>
        <div class="upgrade-recommendation">${enteredAlreadyReached
          ? l('不用换护甲','不用換防具','Keep all five pieces')
          : (needsMasterwork
            ? l('升满大师并重配模组','升滿傑作並重配模組','Fully masterwork and rearrange mods')
            : l('只要重配模组','只要重配模組','Just rearrange the mods'))}</div>
        <p class="upgrade-recommendation-copy">${l(
          enteredAlreadyReached
            ? '现在这套已经达标。下面是最后的模组分配，照着核对一遍就行。'
            : '护甲都可以留下。按下面重新选调谐的 -5 来源、重排属性模组就能达标；调谐的 +5 属性是护甲自带的，这里没有动过。',
          enteredAlreadyReached
            ? '目前這套已經達標。下面是最後的模組分配，照著核對一遍就行。'
            : '防具都可以留下。按下面重新選調諧的 -5 來源、重排數值模組就能達標；調諧的 +5 數值是防具自帶的，這裡沒有動過。',
          enteredAlreadyReached
            ? 'This loadout already meets every target. Check the final mod setup below and you are done.'
            : 'You can keep every armor piece. Re-pick each tuning mod\'s -5 source and rearrange the stat mods as shown to meet every target — the rolled +5 stats are untouched.'
        )}</p>
      </div>
      <div class="upgrade-outcome"><strong>${l('5 件都能留下','5 件都能留下','Keep all 5 pieces')}</strong><span>${l('不用再刷护甲','不用再刷防具','No armor farming needed')}</span></div>
    </div>
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeBaselineNote(analysis)}
    ${buildUpgradeAssignments(analysis, analysis.baseline, true)}`;
  } else if (!analysis.plan) {
    // No replacement beats the current armor: it is already the closest setup.
    const rearranged = analysis.reassignModifiers && analysis.enteredBaseline &&
      STATS.some(stat =>
        analysis.enteredBaseline.finalTotals[stat] !== analysis.baseline.finalTotals[stat]
      );
    body.innerHTML = `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${l('当前配装已是最接近目标','目前配裝已是最接近目標','Current loadout is already the closest')}</div>
        <div class="upgrade-recommendation">${rearranged
          ? l('重配模组后已是最接近的方案','重配模組後已是最接近的方案','Already the closest after rearranging the mods')
          : l('当前已是最接近目标的方案','目前已是最接近目標的方案','Already the closest setup to your targets')}</div>
        <p class="upgrade-recommendation-copy">${l(
          `所有能刷到的替换方案都无法缩小与目标的差距，当前这套就是最接近目标的选择（还差 ${analysis.baseline.metrics.shortfall} 点）。想完全达标，请降低一项目标，或放开一件固定护甲。`,
          `所有能刷到的替換方案都無法縮小與目標的差距，目前這套就是最接近目標的選擇（還差 ${analysis.baseline.metrics.shortfall} 點）。想完全達標，請降低一項目標，或放開一件固定防具。`,
          `Every replacement we could farm fails to close the gap to your targets — this loadout is already the closest (${analysis.baseline.metrics.shortfall} points short). To hit everything, lower a target or unlock one fixed piece.`
        )}</p>
      </div>
      <div class="upgrade-outcome"><strong>${l(`还差 ${analysis.baseline.metrics.shortfall} 点`, `還差 ${analysis.baseline.metrics.shortfall} 點`, `${analysis.baseline.metrics.shortfall} points short`)}</strong><span>${l('当前已是最接近 · 无需刷取','目前已是最接近 · 無需刷取','Closest available · no farming needed')}</span></div>
    </div>
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeBaselineNote(analysis)}`;
  } else {
    const plan = analysis.plan;
    displayedEvaluation = plan.evaluation;
    const reached = plan.metrics.allReached;
    const farmLabel = importedInventory.length > 0
      ? `<div class="upgrade-option-label">${l(
        '刷取方案：替换清单中没有的护甲（与上面从已有清单搭配的方案二选一）',
        '刷取方案：替換清單中沒有的防具（與上面從已有清單搭配的方案二選一）',
        'Farming plan: pieces not in your inventory (alternative to the owned-armor loadouts above)'
      )}</div>`
      : '';
    body.innerHTML = farmLabel + `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${reached
          ? l('推荐换法','推薦換法','Recommended swaps')
          : l('最接近目标的换法','最接近目標的換法','Closest match found')}</div>
        <div class="upgrade-recommendation">${reached
          ? l(`换 ${plan.replacementCount} 件就能达标`, `換 ${plan.replacementCount} 件就能達標`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} to meet every target`)
          : l(`换 ${plan.replacementCount} 件后还差 ${plan.metrics.shortfall} 点`, `換 ${plan.replacementCount} 件後還差 ${plan.metrics.shortfall} 點`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} and remain ${plan.metrics.shortfall} short`)}</div>
        <p class="upgrade-recommendation-copy">${reached
          ? l(
            '方案已按优先顺序排好，照着下面执行即可。如果暂时不想刷，也可以先保留现有护甲重排调谐与模组，但还差 ' + analysis.baseline.metrics.shortfall + ' 点（见下方备选方案）。',
            '方案已按優先順序排好，照著下面執行即可。如果暫時不想刷，也可以先保留目前防具重排調諧與模組，但還差 ' + analysis.baseline.metrics.shortfall + ' 點（見下方備選方案）。',
            'The swaps are already prioritized. Follow the steps below. If you do not want to farm yet, keeping your current armor and rearranging tuning and mods works too, but leaves ' + analysis.baseline.metrics.shortfall + ' points short (see the alternative below).'
          )
          : l(
            '目前没有一套能把六项都补齐。下面这套差得最少，可以先参考；如果不想刷，保留现有护甲重排调谐与模组还差 ' + analysis.baseline.metrics.shortfall + ' 点（见下方备选方案）。想完全达标，还得降低目标或放开一件固定护甲。',
            '目前沒有一套能把六項都補齊。下面這套差得最少，可以先參考；如果不想刷，保留目前防具重排調諧與模組還差 ' + analysis.baseline.metrics.shortfall + ' 點（見下方備選方案）。想完全達標，還得降低目標或放開一件固定防具。',
            'Nothing we found fills all six targets. This is the closest setup; without farming, keeping your current armor and rearranging tuning and mods leaves ' + analysis.baseline.metrics.shortfall + ' points short (see the alternative below). To hit everything, lower a target or unlock one fixed piece.'
          )}</p>
      </div>
      <div class="upgrade-outcome">
        <strong>${reached
          ? l('六维都达标','六維都達標','All six targets met')
          : l(`还差 ${plan.metrics.shortfall} 点`, `還差 ${plan.metrics.shortfall} 點`, `${plan.metrics.shortfall} points short`)}</strong>
        <span>${l(
          `留下现有护甲 ${5 - plan.replacementCount} / 5 件`,
          `留下目前防具 ${5 - plan.replacementCount} / 5 件`,
          `Keep ${5 - plan.replacementCount} / 5 current pieces`
        )}</span>
      </div>
    </div>
    ${buildUpgradeStatComparison(analysis, plan.evaluation.finalTotals)}
    ${buildUpgradeBaselineNote(analysis)}
    ${buildUpgradePlanFlow(analysis, plan)}
    ${buildUpgradeAssignments(analysis, plan.evaluation, true)}
    ${buildUpgradeKeepArmorAlternative(analysis)}`;
  }
  body.insertAdjacentHTML('afterbegin', buildUpgradeRequirementResult(analysis, displayedEvaluation));
  if (scroll) section.scrollIntoView({ behavior:'smooth', block:'start' });
}

let lastInventoryResult = null;
let lastInventoryTargets = null;
let lastInventoryRequiredStats = [];
let selectedInventoryResultIndex = 0;
let inventorySolveRevision = 0;

function clearInventoryResults() {
  inventorySolveRevision++;
  lastInventoryResult = null;
  lastInventoryTargets = null;
  lastInventoryRequiredStats = [];
  selectedInventoryResultIndex = 0;
  const el = document.getElementById("inventoryResults");
  if (el) {
    el.innerHTML = "";
    el.hidden = true;
  }
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
} = {}) {
  const button = document.getElementById("btnUpgradeAnalyze");
  const loading = document.getElementById("loading");
  const requirementSnapshot = snapshotSetRequirement();
  const solveRevision = ++inventorySolveRevision;
  const setControls = [...document.querySelectorAll(".set-requirement-controls select")];
  const reassignModifiers = document.getElementById("upgradeReassignModifiers")?.checked !== false;
  const pool = filterArmorItems(importedInventory, {
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
  saveUpgradeDraft();

  try {
    const result = await solveInventoryAsync({
      items: pool,
      targets,
      fragments,
      setRequirement: requirementSnapshot,
      reassignModifiers,
      currentPieces: upgradeBuildState,
      requiredStats,
      onlyPlus5Tuning,
    });
    if (solveRevision !== inventorySolveRevision ||
        !sameSetRequirement(requirementSnapshot, setRequirement)) {
      return null;
    }
    lastInventoryTargets = targets;
    lastInventoryRequiredStats = requiredStats;
    renderInventoryResults(result);
    if (result?.results?.length) {
      return `<div class="msg info">${icon("check")}${requirementSnapshot.type === "none"
        ? l(
          `从已有护甲清单中找到 ${result.results.length} 个可行组合（无需刷取），可核对后导出 DIM 配装链接。`,
          `從已有防具清單中找到 ${result.results.length} 個可行組合（無需刷取），可核對後匯出 DIM 配裝連結。`,
          `Found ${result.results.length} loadouts from armor you already own (no farming). Review one and export a DIM loadout link.`
        )
        : l(
          `找到 ${result.results.length} 个满足 ${formatSetRequirementLabel(requirementSnapshot)} 的组合，可点击“应用此方案”。`,
          `找到 ${result.results.length} 個滿足 ${formatSetRequirementLabel(requirementSnapshot)} 的組合，可點擊「套用此方案」。`,
          `Found ${result.results.length} loadouts meeting ${formatSetRequirementLabel(requirementSnapshot)}. Click “Apply” to use one.`
        )}</div>`;
    }
    return `<div class="msg error">${icon("block")}${requirementSnapshot.type === "none"
      ? l(
        "当前筛选下清单里凑不齐五件护甲，无法从清单搭配；可调整职业或 Tier 5 筛选后重试。",
        "目前篩選下清單中湊不齊五件防具，無法從清單搭配；可調整職業或 Tier 5 篩選後重試。",
        "The list cannot produce a five-piece loadout under the current filter. Adjust the class or Tier 5 filter and try again."
      )
      : l(
        "清单里凑不出满足所选套装要求的配装（当前职业 / Tier 5 筛选下套装件数不足）。",
        "清單中湊不出滿足所選套裝要求的配裝（目前職業 / Tier 5 篩選下套裝件數不足）。",
        "The list cannot produce a loadout meeting the set requirement (not enough set pieces under the current class / Tier 5 filter)."
      )}</div>`;
  } catch (error) {
    console.error("Inventory solve failed", error);
    return `<div class="msg error">${icon("block")}${l(
      "库存搭配计算失败，请重试。",
      "庫存搭配計算失敗，請重試。",
      "The inventory solve failed. Please try again."
    )}</div>`;
  } finally {
    button.disabled = false;
    setControls.forEach(control => { control.disabled = false; });
    loading.classList.remove("show");
    loading.setAttribute("aria-busy", "false");
    loading.querySelector("p").textContent = t("calculating");
  }
}

function renderInventoryResults(result) {
  const el = document.getElementById("inventoryResults");
  if (!el) return;
  lastInventoryResult = result;
  if (!result?.results?.length) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  selectedInventoryResultIndex = Math.min(
    Math.max(0, selectedInventoryResultIndex),
    result.results.length - 1,
  );
  const selected = result.results[selectedInventoryResultIndex];
  el.hidden = false;
  el.innerHTML = `
    <div class="inventory-results-head">
      <div>
        <h2 class="inventory-results-title">${l("已有护甲搭配方案", "已有防具搭配方案", "Owned armor loadouts")}</h2>
        <p>${l(
          "从已拥有的护甲清单中搭配，无需刷取；选择方案核对装备与六维后，可导出 DIM 配装链接。",
          "從已擁有的防具清單中搭配，無需刷取；選擇方案核對裝備與六維後，可匯出 DIM 配裝連結。",
          "Loadouts built from armor you already own — no farming. Pick one, review the pieces, then export a DIM loadout link."
        )}</p>
      </div>
      <span class="inventory-results-req">${result.requirement?.type === "none"
        ? l("全部已有护甲", "全部已有防具", "All owned armor")
        : formatSetRequirementLabel(result.requirement)} · ${l(
        `共检查 ${result.examined} 种组合`,
        `共檢查 ${result.examined} 種組合`,
        `${result.examined} combinations examined`
      )}</span>
    </div>
    <div class="inventory-results-layout">
      <div class="inventory-result-list" role="listbox" aria-label="${l("方案清单", "方案清單", "Loadout list")}">
        ${result.results.map((entry, index) => renderInventoryResultOption(entry, index)).join("")}
      </div>
      <div class="inventory-result-detail">${renderInventoryResultDetail(selected, selectedInventoryResultIndex)}</div>
    </div>`;
}

function getInventoryResultSummary(entry) {
  const targets = lastInventoryTargets || {};
  const metCount = STATS.filter(stat => (entry.finalTotals[stat] || 0) >= (targets[stat] || 0)).length;
  const requiredCount = entry.metrics.requiredCount || lastInventoryRequiredStats.length;
  const requiredReachedCount = entry.metrics.requiredReachedCount || 0;
  const statusMet = requiredCount > 0 ? entry.metrics.requiredAllReached : entry.metrics.allReached;
  const status = entry.metrics.allReached
    ? l("六维全部达标", "六維全部達標", "All targets met")
    : (requiredCount > 0
      ? (entry.metrics.requiredAllReached
        ? l("必达属性全部满足", "必達數值全部滿足", "All must-meet stats satisfied")
        : l(
          `必达属性还差 ${entry.metrics.requiredShortfall} 点`,
          `必達數值還差 ${entry.metrics.requiredShortfall} 點`,
          `Must-meet stats ${entry.metrics.requiredShortfall} points short`
        ))
      : l(`还差 ${entry.metrics.shortfall} 点`, `還差 ${entry.metrics.shortfall} 點`, `${entry.metrics.shortfall} points short`));
  return { metCount, requiredCount, requiredReachedCount, status, statusMet };
}

function renderInventoryResultOption(entry, index) {
  const { metCount, requiredCount, requiredReachedCount, status, statusMet } = getInventoryResultSummary(entry);
  const fixedCount = entry.pieces.filter(piece => piece.locked).length;
  return `
    <button type="button" class="inventory-result-option ${entry.isCurrent ? "is-current" : ""}"
      role="option" aria-selected="${index === selectedInventoryResultIndex}" onclick="selectInventorySolution(${index})">
      <span class="inventory-result-rank">${index + 1}</span>
      <span class="inventory-result-option-copy">
        <strong class="inventory-result-status ${statusMet ? "is-met" : ""}">${status}</strong>
        <small>${requiredCount > 0 ? l(
          `必达 ${requiredReachedCount}/${requiredCount} · `,
          `必達 ${requiredReachedCount}/${requiredCount} · `,
          `Must meet ${requiredReachedCount}/${requiredCount} · `
        ) : ''}${l(`达标 ${metCount}/6`, `達標 ${metCount}/6`, `${metCount}/6 met`)}${fixedCount
          ? l(` · 保留 ${fixedCount} 件固定装备`, ` · 保留 ${fixedCount} 件固定裝備`, ` · ${fixedCount} fixed kept`)
          : ""}</small>
      </span>
      ${entry.isCurrent ? `<span class="inventory-result-current">${l("当前", "目前", "Current")}</span>` : ""}
    </button>`;
}

function renderInventoryResultDetail(entry, index) {
  const targets = lastInventoryTargets || {};
  const { metCount, requiredCount, requiredReachedCount, status, statusMet } = getInventoryResultSummary(entry);
  return `
    <div class="inventory-result-detail-head">
      <div>
        <span class="inventory-result-detail-label">${l(`方案 ${index + 1}`, `方案 ${index + 1}`, `Loadout ${index + 1}`)}</span>
        <h3 class="${statusMet ? "is-met" : ""}">${status}</h3>
        <p>${requiredCount > 0 ? l(
          `必达 ${requiredReachedCount}/${requiredCount} · `,
          `必達 ${requiredReachedCount}/${requiredCount} · `,
          `Must meet ${requiredReachedCount}/${requiredCount} · `
        ) : ''}${l(`目标达成 ${metCount}/6`, `目標達成 ${metCount}/6`, `${metCount} of 6 targets met`)}</p>
      </div>
      <div class="inventory-result-actions">
        <button type="button" class="btn-solve inventory-export-button" onclick="exportInventorySolution(${index})">${icon("share")}${l("导出 DIM 配装链接", "匯出 DIM 配裝連結", "Export DIM loadout link")}</button>
      </div>
    </div>
    <div class="inventory-result-stats" role="list">
      ${STATS.map(stat => {
        const actual = entry.finalTotals[stat] || 0;
        const target = targets[stat] || 0;
        const met = actual >= target;
        const isRequired = lastInventoryRequiredStats.includes(stat);
        return `<div class="inventory-result-stat ${met ? "is-met" : "is-short"} ${isRequired ? 'is-required' : ''}" role="listitem">
          <span style="color:${STAT_COLORS[stat]}">${icon(stat)}${STAT_LABELS[stat]}</span>
          <strong>${actual}</strong>
          <small>${isRequired ? `${l('必须达标','必須達標','Must meet')} · ` : ''}${l("目标", "目標", "Target")} ${target}${met
            ? ` · ${l("达标", "達標", "met")}`
            : ` · ${l(`差 ${target - actual}`, `差 ${target - actual}`, `${target - actual} short`)}`}</small>
        </div>`;
      }).join("")}
    </div>
    <div class="inventory-result-pieces" role="list">
      ${entry.pieces.map(piece => {
        const slotIndex = UPGRADE_SLOTS.findIndex(slot => slot.id === piece.slot);
        const set = piece.setHash ? getArmorSetByHash(piece.setHash) : null;
        return `<div class="inventory-result-piece" role="listitem">
          <span class="inventory-result-piece-slot">${getUpgradeSlotLabel(slotIndex)}</span>
          <span class="inventory-result-piece-name">${escapeHtml(piece.itemName || "—")}</span>
          ${set ? `<span class="upgrade-set-badge">${escapeHtml(getSetName(set))}</span>` : `<span></span>`}
          ${piece.locked ? `<span class="inventory-fixed-badge">${icon("lock", { size: "sm" })}${piece.exotic
            ? l("异域固定", "異域固定", "Fixed Exotic")
            : l("固定保留", "固定保留", "Fixed")}</span>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}

function selectInventorySolution(index) {
  if (!lastInventoryResult?.results?.[index]) return;
  selectedInventoryResultIndex = index;
  renderInventoryResults(lastInventoryResult);
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

function renderDimExportMessage(messages, url, count, modCount, ok) {
  const note = count < 5
    ? l(
      `（${5 - count} 件缺少 DIM 实例信息，未包含）`,
      `（${5 - count} 件缺少 DIM 實例資訊，未包含）`,
      ` (${5 - count} piece(s) lack DIM instance data and were skipped)`
    )
    : '';
  const modNote = modCount > 0
    ? l(
      `，已包含 ${modCount} 个护甲模组/调谐设置`,
      `，已包含 ${modCount} 個防具模組/調諧設定`,
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
    <div class="dim-export-actions">
      <a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">${icon("share")}${l("在 DIM 中打开", "在 DIM 中開啟", "Open in DIM")}</a>
      <button type="button" class="btn" onclick="copyDimExportLink()">${icon("save")}${l("重新复制链接", "重新複製連結", "Copy link again")}</button>
    </div>
    <p class="dim-export-hint">${l(
      "打开前请确保浏览器已登录 DIM；或复制链接后，粘贴到 DIM → Loadouts → Import Loadout。模组与调谐（含 -5 来源）已随链接带入，需已拥有对应模组（未拥有的会灰显忽略）；护甲需已满大师。",
      "開啟前請確保瀏覽器已登入 DIM；或複製連結後，貼上到 DIM → Loadouts → Import Loadout。模組與調諧（含 -5 來源）已隨連結帶入，需已擁有對應模組（未擁有的會灰顯忽略）；防具需已滿傑作。",
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
  const entry = lastInventoryResult?.results?.[index];
  if (!entry) return;
  const { url, count, modCount } = getDimLoadoutExport(
    entry.pieces, entry.tuningAssignments, entry.modAssignments
  );
  lastDimExportUrl = url;
  const messages = document.getElementById('messages');
  try {
    await copyText(url);
    renderDimExportMessage(messages, url, count, modCount, true);
  } catch (error) {
    console.error('DIM loadout export failed', error);
    renderDimExportMessage(messages, url, count, modCount, false);
  }
}

async function analyzeArmorUpgrades() {
  const button = document.getElementById('btnUpgradeAnalyze');
  const loading = document.getElementById('loading');
  const messages = document.getElementById('messages');
  const targets = getUpgradeTargets();
  const fragments = getUpgradeFragments();
  const requiredStats = getUpgradeRequiredStats();
  const reassignModifiers = document.getElementById('upgradeReassignModifiers')?.checked !== false;
  const onlyPlus5Tuning = document.getElementById('upgradeOnlyPlus5')?.checked === true;
  messages.innerHTML = '';

  // With an imported inventory the "no farming" option comes from the pieces
  // you already own; the theoretical plan below is the "farming" option.
  let inventoryMessage = '';
  if (importedInventory.length > 0) {
    inventoryMessage = await solveInventoryRequirement({
      targets, fragments, requiredStats, onlyPlus5Tuning,
    });
    if (inventoryMessage === null) return;
  }

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
        pieces: upgradeBuildState.map(piece => ({ ...piece })),
        targets,
        fragments,
        reassignModifiers,
        requiredStats,
        onlyPlus5Tuning,
      });
      renderUpgradeAnalysis(analysis, true);
      messages.innerHTML = inventoryMessage + `<div class="msg info">${icon('check')}${analysis.baseline.metrics.allReached
        ? l('算好了：现在这套不用换护甲。','算好了：目前這套不用換防具。','Done: you can keep the current armor.')
        : (analysis.plan
          ? (analysis.plan.metrics.allReached
            ? l(`算好了：换 ${analysis.plan.replacementCount} 件就能达标。`, `算好了：換 ${analysis.plan.replacementCount} 件就能達標。`, `Done: replace ${analysis.plan.replacementCount} piece(s) to meet every target.`)
            : l(`算好了：最接近的方案还差 ${analysis.plan.metrics.shortfall} 点。`, `算好了：最接近的方案還差 ${analysis.plan.metrics.shortfall} 點。`, `Done: the closest setup is still ${analysis.plan.metrics.shortfall} points short.`))
          : l('没有找到能缩小缺口的替换方案。','沒有找到能縮小缺口的替換方案。','No replacement plan reduces the gap.'))}</div>`;
    } catch (error) {
      console.error('Armor upgrade analysis failed', error);
      messages.innerHTML = inventoryMessage + '<div class="msg error">' + icon('block') + l(
        '替换分析过程中发生错误，请重试。',
        '替換分析過程中發生錯誤，請重試。',
        'The replacement analysis failed. Please try again.'
      ) + '</div>';
    } finally {
      button.disabled = false;
      loading.classList.remove('show');
      loading.setAttribute('aria-busy', 'false');
      loading.querySelector('p').textContent = t('calculating');
    }
}

// ============================================================
// SAVED BUILDS (localStorage)
// ============================================================

function getSavedBuilds() {
  return buildRepository.readSavedBuilds();
}

function saveBuildsToStorage(builds) {
  buildRepository.writeSavedBuilds(builds);
}

function saveBuild() {
  if (allSolutions.length === 0) { alert(l('请先求解配装再保存。','請先求解配裝再儲存。','Solve a loadout before saving it.')); return; }

  const targets = {};
  const fragments = {};
  for (const s of STATS) {
    targets[s] = getVal('target_' + s);
    fragments[s] = getFragVal(s);
  }
  const name = prompt(l('给这套配装起个名字（留空自动命名）：','為這套配裝命名（留空自動命名）：','Name this loadout (leave blank for an automatic name):')) ||
    l('配装 ','配裝 ','Loadout ') + new Date().toLocaleDateString(localeCode()) + ' ' + new Date().toLocaleTimeString(localeCode()).slice(0,5);
  const exoticSettings = getExoticSettings();
  const onlyPlus5Tuning = isOnlyPlus5Tuning();

  const build = {
    name,
    language: getPageLanguage(),
    targets,
    fragments,
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
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
    result: allSolutions[currentSolutionIdx],
    savedAt: Date.now(),
  };

  const builds = getSavedBuilds();
  builds.unshift(build);
  if (builds.length > 255) builds.length = 255;
  saveBuildsToStorage(builds);
  renderSavedBuilds();
}

function loadBuild(build) {
  const buildLanguage = build.language || build.exotic?.language;
  if (['zh-chs', 'zh-cht', 'en'].includes(buildLanguage) && buildLanguage !== getPageLanguage()) {
    document.getElementById('pageLanguage').value = buildLanguage;
    changePageLanguage();
  }
  for (const s of STATS) {
    document.getElementById('target_' + s).value = build.targets[s];
    const lockEl = document.getElementById('targetLock_' + s);
    if (lockEl) lockEl.checked = build.targetLocks?.[s] || false;
    const el = document.getElementById('fragVal_' + s);
    if (el) { el.textContent = build.fragments[s]; el.style.color = build.fragments[s] !== 0 ? STAT_COLORS[s] : ''; }
  }
  document.getElementById('numPlus5').value = build.numPlus5;
  document.getElementById('numPlus10').value = build.numPlus10;
  document.getElementById('onlyPlus5Tuning').checked = build.onlyPlus5Tuning === true;
  document.getElementById('usePlus3').checked = !build.onlyPlus5Tuning && !!build.n3Enabled;
  if (build.n3Enabled) {
    document.getElementById('plus3CountVal').textContent = build.numPlus3;
  }
  syncPlus3PreferenceUI();
  document.getElementById('useExoticMode').checked = !!build.exotic?.enabled;
  toggleExoticMode();
  if (build.exotic?.enabled) {
    if (build.exotic.classId && EXOTIC_CLASSES[build.exotic.classId]) {
      document.getElementById('exoticClass').value = build.exotic.classId;
      updateExoticPerkOptions();
    }
    if (build.exotic.primaryPerkId) document.getElementById('exoticPrimaryPerk').value = build.exotic.primaryPerkId;
    if (build.exotic.secondaryPerkId) document.getElementById('exoticSecondaryPerk').value = build.exotic.secondaryPerkId;
    updateExoticFramework();
  }
  updateBudget();
  if (build.result) {
    allSolutions = [build.result];
    currentSolutionIdx = 0;
    lastTargets = build.targets;
    lastFragments = build.fragments;
    lastNumPlus5 = build.numPlus5;
    lastNumPlus10 = build.numPlus10;
    lastNumPlus3 = build.onlyPlus5Tuning || !build.n3Enabled ? 0 : build.numPlus3;
    lastExoticSettings = getExoticSettings();
    displayAllResults(build.result, build.targets, build.fragments);
  }
}

function deleteBuild(idx) {
  if (!confirm(l('确定删除这套配装？','確定刪除這套配裝？','Delete this loadout?'))) return;
  const builds = getSavedBuilds();
  builds.splice(idx, 1);
  saveBuildsToStorage(builds);
  renderSavedBuilds();
}

function clearAllBuilds() {
  if (!confirm(l('确定清空全部已保存配装？此操作不可撤销。','確定清除全部已儲存配裝？此操作無法復原。','Clear all saved loadouts? This cannot be undone.'))) return;
  buildRepository.clearSavedBuilds();
  renderSavedBuilds();
}

function renderSavedBuilds() {
  const builds = getSavedBuilds();
  const card = document.getElementById('savedCard');
  const list = document.getElementById('savedBuildsList');
  if (builds.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  let html = '';
  builds.forEach((b, i) => {
    const d = new Date(b.savedAt);
    const dateStr = d.toLocaleString(localeCode(), { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const statSummary = STATS
      .map(stat => `${STAT_LABELS[stat]}${b.targets?.[stat] ?? 0}`)
      .join(' | ');
    const deleteLabel = l('删除', '刪除', 'Delete') + ' ' + b.name;
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);font-size:12px;">' +
      '<button onclick="loadBuild(getSavedBuilds()[' + i + '])" style="flex:1;min-width:0;cursor:pointer;border:none;background:none;color:var(--accent);font-weight:600;font-size:12px;line-height:1.6;font-family:inherit;text-align:left;">' +
      b.name +
      ' <span style="color:var(--text-dim);font-weight:400;">' + dateStr + ' | ' + statSummary + '</span>' +
      '</button>' +
      '<button class="icon-btn" onclick="deleteBuild(' + i + ')" style="cursor:pointer;border:none;background:none;color:var(--health);font-size:14px;padding:0 4px;" title="' + deleteLabel + '" aria-label="' + deleteLabel + '">' + icon('close') + '</button>' +
      '</div>';
  });
  list.innerHTML = html;
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
  applyEquippedLoadout,
  applyNearestTargetSuggestion,
  balanceTargetsToBudget,
  bungieLogin,
  bungieLogout,
  changePageLanguage,
  clearAllBuilds,
  copyDimExportLink,
  exportInventorySolution,
  clearImportedInventory,
  clearOwnedGear,
  deleteBuild,
  getSavedBuilds,
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
  setCalculatorMode,
  shouldAutoRefresh,
  solve,
  switchSolution,
  sync10to5,
  sync5to10,
  toggleAllSolutions,
  toggleExoticMode,
  toggleInventoryImportPanel,
  toggleOnlyPlus5Tuning,
  togglePlus3,
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
renderInputs();
renderExoticInputs();
syncPlus3PreferenceUI();
document.getElementById('inputCard').addEventListener('input', () => {
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
handleBungieOAuthCallback();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldAutoRefresh()) {
    importInventoryFromBungie();
  }
});
