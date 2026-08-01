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
  getExoticClassData,
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
  solveLoadoutAsync,
} from "./core/armor-engine-client.mjs";
import {
  createBalancedTargetPlan,
} from "./core/budget.mjs";
import { farmabilityScore } from "./core/solver.mjs";
import { buildRepository } from "./core/build-repository.mjs";
import {
  UPGRADE_SLOTS,
  finalizeUpgradeTotals,
  getArchetypeIdForConfig,
  getManualUpgradeArmorTotals,
  getUpgradeConfig,
  getUpgradeModifierBudget,
  normalizeUpgradePiece,
} from "./core/upgrade-optimizer.mjs";

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
  return `
    <div class="input-group ${prefix === 'target' ? 'target-stat-group' : ''}">
      <div class="stat-label" style="color:${STAT_COLORS[stat]};display:flex;align-items:center;justify-content:space-between;">
        <span class="icon-text stat-name target-stat-name">${icon(stat)}<span>${STAT_LABELS[stat]}</span></span>
        ${prefix === 'target' ? `<label class="lock-control">
          <input type="checkbox" id="targetLock_${stat}" aria-label="${STAT_LABELS[stat]} ${t('lock')}" style="accent-color:var(--accent);width:13px;height:13px;">${icon('lock', { size: 'sm' })}<span>${t('lock')}</span>
        </label>` : ''}
      </div>
      <input type="number" id="${prefix}_${stat}" value="${val||0}"${prefix === 'target' ? ` aria-describedby="rangeHint_${stat}"` : ''}
        inputmode="numeric" min="0" max="100" aria-label="${STAT_LABELS[stat]}"
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
  }
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

function updateBudget() {
  const n5 = getVal('numPlus5');
  const n10 = getVal('numPlus10');
  const n3 = document.getElementById('usePlus3')?.checked ? (getPlus3Count() || 0) : 0;
  const budget = 450 + n3 * 3 + n5 * 5 + n10 * 10;
  const modBudget = n3 * 3 + n5 * 5 + n10 * 10;
  document.getElementById('budgetInfo').innerHTML = l(
    `<span>属性总预算</span><strong>${budget}</strong><small>基础 450 + 模组 ${modBudget}</small>`,
    `<span>數值總預算</span><strong>${budget}</strong><small>基礎 450 + 模組 ${modBudget}</small>`,
    `<span>Total stat budget</span><strong>${budget}</strong><small>450 base + ${modBudget} from mods</small>`
  );

  // Compute armor needed vs budget (with fragments factored in)
  let targetSum = 0, armorNeeded = 0;
  for (const s of STATS) {
    const t = getVal('target_' + s);
    const f = getFragVal(s);
    targetSum += t;
    let adj = t - f;
    if (t === 0 || adj < 0) adj = 0;
    armorNeeded += adj;
  }
  const diff = armorNeeded - budget;
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
}

// The solver only accepts targets whose armor requirement equals the budget.
// Spread the surplus/deficit across unlocked stats so the user does not have to
// do the arithmetic by hand. Locked stats and the 0-200 range are respected.
function balanceTargetsToBudget() {
  const n5 = getVal('numPlus5');
  const n10 = getVal('numPlus10');
  const n3 = document.getElementById('usePlus3')?.checked ? (getPlus3Count() || 0) : 0;
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
  const checked = document.getElementById('usePlus3')?.checked;
  document.getElementById('plus3CountRow').style.display = checked ? 'flex' : 'none';
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

function toggleExoticMode() {
  const enabled = document.getElementById('useExoticMode')?.checked;
  const showSettings = enabled && calculatorMode !== 'upgrade';
  document.getElementById('exoticSettingsBody').style.display = showSettings ? 'block' : 'none';
  if (showSettings) updateExoticFramework();
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
  renderUpgradeInferInputs();
  renderUpgradeBuildEditor();
  if (lastUpgradeAnalysis) renderUpgradeAnalysis(lastUpgradeAnalysis);
  saveCurrentDraft();
  saveUpgradeDraft();
  if (allSolutions.length > 0 && lastTargets && lastFragments) {
    displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments);
  }
}

function updateExoticPerkOptions() {
  const data = getExoticClassData();
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
  const data = getExoticClassData();
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
  return {
    language: getPageLanguage(),
    targets: Object.fromEntries(STATS.map(s => [s, getVal('target_' + s)])),
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
    targetLocksExplicit: true,
    fragments: Object.fromEntries(STATS.map(s => [s, getFragVal(s)])),
    numPlus5: getVal('numPlus5'),
    numPlus10: getVal('numPlus10'),
    n3Enabled: document.getElementById('usePlus3')?.checked || false,
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
  document.getElementById('usePlus3').checked = !!draft.n3Enabled;
  document.getElementById('plus3CountRow').style.display = draft.n3Enabled ? 'block' : 'none';
  if (draft.numPlus3 !== undefined) document.getElementById('plus3CountVal').textContent = draft.numPlus3;

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
  const numPlus3 = document.getElementById('usePlus3')?.checked ? getPlus3Count() : 0;
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
  ownedGearState = {};
  results.classList.remove('show');
  document.getElementById('refineCard').style.display = 'none';
  document.getElementById('floatJump').style.display = 'none';

  const targets = {};
  for (const s of STATS) targets[s] = getVal('target_' + s);
  const fragments = getFragments();
  let numPlus5 = getVal('numPlus5');
  let numPlus10 = getVal('numPlus10');
  const numPlus3 = document.getElementById('usePlus3')?.checked ? (getPlus3Count() || 0) : 0;
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

    const bestResult = allSolutions[0];
    if (!bestResult) {
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

    // Count +3 pieces in best result
    const plus3Count = bestResult.tuningAssignments.filter(t => t.mode === '+3').length;

    // Post-solve analysis
    if (bestResult.score === 0) {
      msgs.innerHTML += `<div class="msg info">${icon('check')}${l(`找到完美配装！${plus3Count}件使用+3模式。`,`找到完美配裝！${plus3Count}件使用+3模式。`,`Perfect loadout found. ${plus3Count} piece(s) use +3 mode.`)}</div>`;
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
  let html = '<div class="constraint-matrix" role="table"><div class="constraint-grid" role="rowgroup">';
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
    const armorBase = (document.getElementById('usePlus3')?.checked ? (parseInt(document.getElementById('plus3CountVal')?.textContent) || 0) : 0) * 6;
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

function requirementCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function requirementsCanCoverPieces(candidates, property, requirements) {
  if (candidates.length > requirements.length) return false;
  const available = requirementCounts(requirements);
  for (const candidate of candidates) {
    const value = candidate.piece[property];
    if (!value) continue;
    if (!available[value]) return false;
    available[value]--;
  }
  return true;
}

function getValidTertiaryAssignments(armorSlots, requiredTerts) {
  const remaining = requirementCounts(requiredTerts);
  const values = Object.keys(remaining);
  const assignments = [];

  function visit(slotIndex, current) {
    if (slotIndex === armorSlots.length) {
      assignments.push([...current]);
      return;
    }
    const slot = armorSlots[slotIndex];
    for (const value of values) {
      if (!remaining[value] || value === slot.primary || value === slot.secondary) continue;
      remaining[value]--;
      current.push(value);
      visit(slotIndex + 1, current);
      current.pop();
      remaining[value]++;
    }
  }

  visit(0, []);
  return assignments;
}

function tertiaryAssignmentCanCoverPieces(candidates, armorSlots, assignment) {
  const availableByArchetype = {};
  for (let index = 0; index < armorSlots.length; index++) {
    const name = armorSlots[index].name;
    if (!availableByArchetype[name]) availableByArchetype[name] = {};
    const value = assignment[index];
    availableByArchetype[name][value] = (availableByArchetype[name][value] || 0) + 1;
  }
  for (const candidate of candidates) {
    const value = candidate.piece.tertiary;
    if (!value) continue;
    const available = availableByArchetype[candidate.name];
    if (!available?.[value]) return false;
    available[value]--;
  }
  return true;
}

function assignTertiaries(candidates, armorSlots, assignment) {
  const remainingByArchetype = {};
  for (let index = 0; index < armorSlots.length; index++) {
    const name = armorSlots[index].name;
    if (!remainingByArchetype[name]) remainingByArchetype[name] = [];
    remainingByArchetype[name].push(assignment[index]);
  }

  const assignments = new Map();
  const specified = candidates.filter(candidate => candidate.piece.tertiary);
  const unspecified = candidates.filter(candidate => !candidate.piece.tertiary);
  for (const candidate of specified) {
    const remaining = remainingByArchetype[candidate.name];
    const index = remaining.indexOf(candidate.piece.tertiary);
    assignments.set(candidate, remaining[index]);
    remaining.splice(index, 1);
  }
  for (const candidate of unspecified) {
    assignments.set(candidate, remainingByArchetype[candidate.name].shift());
  }

  return {
    assignments,
    remaining: Object.values(remainingByArchetype).flat()
  };
}

function assignGlobalRequirements(candidates, property, requirements) {
  const remaining = [...requirements];
  const assignments = new Map();
  const specified = candidates.filter(candidate => candidate.piece[property]);
  const unspecified = candidates.filter(candidate => !candidate.piece[property]);
  for (const candidate of specified) {
    const index = remaining.indexOf(candidate.piece[property]);
    assignments.set(candidate, remaining[index]);
    remaining.splice(index, 1);
  }
  for (const candidate of unspecified) assignments.set(candidate, remaining.shift());
  return { assignments, remaining };
}

function getTertiaryOptionsByArchetype(armorSlots, requiredTerts) {
  const options = {};
  for (const assignment of getValidTertiaryAssignments(armorSlots, requiredTerts)) {
    for (let index = 0; index < armorSlots.length; index++) {
      const name = armorSlots[index].name;
      if (!options[name]) options[name] = new Set();
      options[name].add(assignment[index]);
    }
  }
  return Object.fromEntries(
    Object.entries(options).map(([name, values]) => [name, [...values]])
  );
}

function selectOwnedArmorMatches(armorSlots, ownedState, requiredTerts, requiredTunes, requireSpecifiedTertiary = false) {
  const archCount = {};
  for (const slot of armorSlots) archCount[slot.name] = (archCount[slot.name] || 0) + 1;
  const candidates = [];
  for (const [name, needed] of Object.entries(archCount)) {
    const state = ownedState[name] || { count: 0, pieces: [] };
    const owned = Math.min(state.count || 0, needed);
    for (let index = 0; index < owned; index++) {
      const piece = state.pieces[index] || {};
      if (requireSpecifiedTertiary && !piece.tertiary) continue;
      candidates.push({ name, index, piece });
    }
  }

  let best = [];
  let bestTertiaryAssignment = null;
  let bestSpecificity = -1;
  for (const tertiaryAssignment of getValidTertiaryAssignments(armorSlots, requiredTerts)) {
    for (let mask = 0; mask < (1 << candidates.length); mask++) {
      const selected = candidates.filter((_, index) => mask & (1 << index));
      if (selected.length < best.length) continue;
      if (!tertiaryAssignmentCanCoverPieces(selected, armorSlots, tertiaryAssignment) ||
          !requirementsCanCoverPieces(selected, 'tuneTo', requiredTunes)) continue;
      const specificity = selected.reduce(
        (score, candidate) => score + (candidate.piece.tertiary ? 1 : 0) + (candidate.piece.tuneTo ? 1 : 0),
        0
      );
      if (selected.length > best.length || specificity > bestSpecificity) {
        best = selected;
        bestTertiaryAssignment = tertiaryAssignment;
        bestSpecificity = specificity;
      }
    }
  }

  const fallbackAssignment = getValidTertiaryAssignments(armorSlots, requiredTerts)[0] || [];
  const tertiaryResult = assignTertiaries(best, armorSlots, bestTertiaryAssignment || fallbackAssignment);
  const tuningResult = assignGlobalRequirements(best, 'tuneTo', requiredTunes);
  const selectedSet = new Set(best);
  const remainingArchCount = { ...archCount };
  const matches = best.map(candidate => {
    remainingArchCount[candidate.name]--;
    return {
      ...candidate,
      tertiary: tertiaryResult.assignments.get(candidate),
      tuning: tuningResult.assignments.get(candidate)
    };
  });
  const remainingSlots = [...armorSlots];
  for (const match of matches) {
    const slotIndex = remainingSlots.findIndex(slot => slot.name === match.name);
    remainingSlots.splice(slotIndex, 1);
  }

  return {
    matches,
    mismatches: candidates.filter(candidate => !selectedSet.has(candidate)),
    remainingArchCount,
    remainingTerts: tertiaryResult.remaining,
    remainingTunes: tuningResult.remaining,
    tertiaryOptions: getTertiaryOptionsByArchetype(remainingSlots, tertiaryResult.remaining)
  };
}

function formatRequirementCounts(values, formatValue) {
  return Object.entries(requirementCounts(values))
    .map(([value, count]) => `${formatValue(value)} ×${count}`)
    .join(l('，','，',', '));
}

function formatTuningRequirement(value) {
  return value === '+3'
    ? l('+3模式','+3模式','+3 mode')
    : `+5 ${STAT_LABELS[value]}`;
}

function displayPieceResults(result, _fragments) {
  const piecesOutput = document.getElementById('piecesOutput');
  let piecesHTML = '';

  // === Section 1: Archetype requirements (per piece matters) ===
  piecesHTML += `<h3 style="color:var(--text);margin-bottom:8px;">${l('护甲框架需求（需按件刷取）','防具原型需求（需逐件取得）','Armor archetype requirements (farm per piece)')}</h3>`;
  const archCount = {};
  for (let i = 0; i < 5; i++) {
    if (i === result.exoticIndex) continue;
    const name = result.config[i].archetype;
    archCount[name] = (archCount[name] || 0) + 1;
  }
  if (result.exoticIndex !== null && result.exoticIndex !== undefined) {
    const exotic = result.config[result.exoticIndex];
    const exoticFixedLabel = getPageLanguage() === 'en'
      ? `${t('exoticClassItem')} ${l('固定框架','固定原型','archetype')}:`
      : `${t('exoticClassItem')} ${l('固定框架','固定原型','archetype')}：`;
    const statSpace = getPageLanguage() === 'en' ? ' ' : '';
    piecesHTML += `<div style="padding:8px 12px;border-radius:6px;border:1px solid rgba(244,181,61,0.35);background:rgba(244,181,61,0.06);font-size:13px;margin-bottom:10px;">
      <strong style="color:var(--accent);">${exoticFixedLabel}</strong>${getArchetypeLabel(exotic.archetype)}${getPageLanguage() === 'en' ? ' · ' : '，'}
      ${t('primaryStat')}${statSpace}${STAT_LABELS[exotic.primary]} / ${t('secondaryStat')}${statSpace}${STAT_LABELS[exotic.secondary]} / ${t('tertiaryStat')}${statSpace}${STAT_LABELS[exotic.tertiary]}
    </div>`;
  }
  piecesHTML += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">';
  for (const [name, count] of Object.entries(archCount)) {
    piecesHTML += '<div style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);font-size:13px;">' +
      '<span style="color:#d4956b;font-weight:600;">' + getArchetypeLabel(name) + '</span> ×<strong>' + count + '</strong> ' + l('件','件','pieces') + '</div>';
  }
  piecesHTML += '</div>';

  // === Section 2: Flexible counts (tertiary stats must remain compatible with each archetype) ===
  piecesHTML += `<h3 style="color:var(--text);margin-bottom:8px;">${l('灵活分配（第三属性须兼容框架）','彈性分配（第三屬性須相容原型）','Flexible assignments (tertiary stats must fit the archetype)')}</h3>`;
  piecesHTML += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:13px;">';

  // Tertiary stats
  piecesHTML += '<div style="padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);">' +
    `<div style="font-weight:600;margin-bottom:4px;">${t('tertiaryStat')}(20)</div>`;
  const tertCount = {};
  for (let i = 0; i < 5; i++) {
    if (i === result.exoticIndex) continue;
    const t = result.config[i].tertiary;
    tertCount[t] = (tertCount[t] || 0) + 1;
  }
  for (const [s, c] of Object.entries(tertCount)) {
    piecesHTML += '<div style="color:' + STAT_COLORS[s] + ';">' + STAT_LABELS[s] + ' ×' + c + '</div>';
  }
  piecesHTML += '</div>';

  // Tuning
  piecesHTML += '<div style="padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);">' +
    `<div style="font-weight:600;margin-bottom:4px;">${t('tuningMod')}</div>`;
  const tuneFromCount = {}, tuneToCount = {}, plus3Count = result.tuningAssignments.filter(t => t.mode === '+3').length;
  for (let i = 0; i < 5; i++) {
    const t = result.tuningAssignments[i];
    if (t.mode === '+3') continue;
    tuneFromCount[t.from] = (tuneFromCount[t.from] || 0) + 1;
    tuneToCount[t.to] = (tuneToCount[t.to] || 0) + 1;
  }
  if (plus3Count > 0) {
    piecesHTML += '<div style="color:var(--accent);">+3模式 ×' + plus3Count + '</div>';
  }
  for (const [s, c] of Object.entries(tuneFromCount)) {
    piecesHTML += '<div style="color:' + STAT_COLORS[s] + ';">-5 ' + STAT_LABELS[s] + ' ×' + c + '</div>';
  }
  for (const [s, c] of Object.entries(tuneToCount)) {
    piecesHTML += '<div style="color:' + STAT_COLORS[s] + ';">+5 ' + STAT_LABELS[s] + ' ×' + c + '</div>';
  }
  piecesHTML += '</div>';

  // Mods
  piecesHTML += '<div style="padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);">' +
    `<div style="font-weight:600;margin-bottom:4px;">${t('armorMod')}</div>`;
  const modCount = {};
  for (let i = 0; i < 5; i++) {
    const ma = result.modAssignments[i];
    if (!ma) continue;
    const key = ma.stat + '|' + ma.size;
    modCount[key] = (modCount[key] || 0) + 1;
  }
  for (const [key, c] of Object.entries(modCount)) {
    const [stat, size] = key.split('|');
    piecesHTML += '<div style="color:' + STAT_COLORS[stat] + ';">+' + size + ' ' + STAT_LABELS[stat] + ' ×' + c + '</div>';
  }
  if (Object.keys(modCount).length === 0) piecesHTML += `<div style="color:var(--text-dim);">${l('无','無','None')}</div>`;
  piecesHTML += '</div>';

  piecesHTML += '</div>';

  // === Section 3: What still needs farming (dynamic based on owned gear) ===
  const farmLines = [], mismatchLines = [], correctLines = [];
  const armorSlots = [];
  const requiredTerts = [];
  const requiredTunes = [];
  for (let i = 0; i < 5; i++) {
    if (i === result.exoticIndex) continue;
    const tune = result.tuningAssignments[i];
    armorSlots.push({
      name: result.config[i].archetype,
      primary: result.config[i].primary,
      secondary: result.config[i].secondary
    });
    requiredTerts.push(result.config[i].tertiary);
    requiredTunes.push(tune.mode === '+5-5' ? tune.to : '+3');
  }
  const ownedMatch = selectOwnedArmorMatches(armorSlots, ownedGearState, requiredTerts, requiredTunes);

  for (const match of ownedMatch.matches) {
    const desc = t('tertiaryStat') + STAT_LABELS[match.tertiary] +
      l('，调整','，調整',', Tuning ') + formatTuningRequirement(match.tuning);
    correctLines.push(
      getArchetypeLabel(match.name) + l('第','第',' piece ') + (match.index + 1) + l('件：','件：',': ') + desc
    );
  }
  for (const mismatch of ownedMatch.mismatches) {
    const tertOptions = (ownedMatch.tertiaryOptions[mismatch.name] || [])
      .map(stat => STAT_LABELS[stat]).join(l('、','、',', '));
    const tuneOptions = [...new Set(ownedMatch.remainingTunes)].map(formatTuningRequirement).join(l('、','、',', '));
    mismatchLines.push(
      getArchetypeLabel(mismatch.name) + l('第','第',' piece ') + (mismatch.index + 1) +
      l('件可接受：','件可接受：',' accepts: ') +
      t('tertiaryStat') + tertOptions +
      l('；调整','；調整','; Tuning ') + tuneOptions
    );
  }
  for (const [name, remaining] of Object.entries(ownedMatch.remainingArchCount)) {
    if (remaining <= 0) continue;
    const tertiaryOptions = (ownedMatch.tertiaryOptions[name] || [])
      .map(stat => STAT_LABELS[stat]).join(l('、','、',', '));
    farmLines.push(
      `<div><strong>${getArchetypeLabel(name)} ×${remaining}${l('件','件',' piece(s)')}</strong>` +
      `<span style="color:var(--text-dim);">${l('，第三属性可选：','，第三屬性可選：',', tertiary: ')}${tertiaryOptions}</span></div>`
    );
  }

  if (correctLines.length > 0) {
    piecesHTML += '<div style="margin-top:14px;padding:10px 14px;border-radius:8px;background:rgba(74,217,139,0.08);border:2px solid rgba(74,217,139,0.3);font-size:13px;line-height:1.8;">' +
      `<div style="font-weight:700;font-size:14px;color:#4ad98b;margin-bottom:4px;">${l('已正确匹配','已正確匹配','Correctly matched')}</div>` + correctLines.join('<br>') + '</div>';
  }
  if (mismatchLines.length > 0) {
    piecesHTML += '<div style="margin-top:14px;padding:10px 14px;border-radius:8px;background:rgba(255,107,107,0.1);border:2px solid rgba(255,107,107,0.4);font-size:13px;line-height:1.8;">' +
      `<div style="font-weight:700;font-size:14px;color:#ff8888;margin-bottom:4px;">${l('已有护甲不匹配','已有防具不匹配','Owned armor mismatch')}</div>` + mismatchLines.join('<br>') + '</div>';
  }
  if (farmLines.length > 0) {
    const tertiaryRequirements = formatRequirementCounts(ownedMatch.remainingTerts, stat => STAT_LABELS[stat]);
    const tuningRequirements = formatRequirementCounts(ownedMatch.remainingTunes, formatTuningRequirement);
    piecesHTML += '<div style="margin-top:14px;padding:12px 16px;border-radius:8px;background:rgba(244,181,61,0.1);border:2px solid rgba(244,181,61,0.35);font-size:13px;line-height:2;">' +
      `<div style="font-weight:700;font-size:14px;color:#ffd866;margin-bottom:6px;">${l('还需刷取','還需取得','Still to farm')}</div>
      <div style="margin-bottom:6px;">${farmLines.join('')}</div>
      <div>${t('tertiaryStat')}：${tertiaryRequirements}</div>
      <div>${t('tuningMod')}：${tuningRequirements}</div>
      <div style="color:var(--text-dim);line-height:1.6;margin-top:4px;">${l(
        '第三属性须从对应框架行内的可选项中选择，不能与该框架的主属性或副属性重复；调整属性不绑定框架。两项无需逐件对应，最终总数符合即可。',
        '第三屬性須從對應原型行內的可選項中選擇，不能與該原型的主要屬性或次要屬性重複；調整屬性不綁定原型。兩項無需逐件對應，最終總數符合即可。',
        'Choose a tertiary stat from the options shown for that archetype; it cannot duplicate the archetype primary or secondary stat. Tuning is not tied to an archetype. The two fields do not need to be paired per piece; only the final totals matter.'
      )}</div></div>`;
  }

  piecesOutput.innerHTML = piecesHTML;

  // Show exotic recommendation
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

// Global owned gear state (persists across solution switches)
let ownedGearState = {}; // { 'archetypeName': { count: N, pieces: [{tertiary: 'stat', tuneTo: 'stat'}, ...] } }

function ownedGearControlId(name) {
  return name.replace(/[^a-zA-Z一-鿿]/g, '_');
}

function buildOwnedGearSection(_finalTotals, _targets) {
  const section = document.getElementById('ownedGearSection');
  // Get all archetypes across ALL solutions
  const allArchs = new Set();
  const archMax = {}; // max needed across all solutions
  for (const sol of allSolutions) {
    const cnt = {};
    for (let i = 0; i < 5; i++) {
      if (i === sol.exoticIndex) continue;
      const name = sol.config[i].archetype;
      allArchs.add(name);
      cnt[name] = (cnt[name] || 0) + 1;
    }
    for (const [n, c] of Object.entries(cnt)) {
      archMax[n] = Math.max(archMax[n] || 0, c);
    }
  }
  if (allArchs.size <= 1) { section.style.display = 'none'; return; }

  const totalOwned = [...allArchs].reduce(
    (sum, name) => sum + (ownedGearState[name]?.count || 0), 0
  );
  let html2 = `<div class="owned-gear-header">
    <div>
      <h3 class="owned-gear-title">${l('匹配已有护甲','匹配已有防具','Match owned armor')}</h3>
      <p class="owned-gear-copy">${l(
        '录入已有框架与属性，再按匹配度重新排序方案。切换方案时会保留这些内容。',
        '輸入已有原型與屬性，再依匹配度重新排序方案。切換方案時會保留這些內容。',
        'Enter the archetypes and stats you own, then re-sort solutions by fit. Your entries persist when switching solutions.'
      )}</p>
    </div>
    <div class="owned-gear-summary">${l('已录入','已輸入','Entered')} <strong>${totalOwned}</strong> ${l('件','件','piece(s)')}</div>
  </div><div class="owned-gear-list">`;

  for (const name of [...allArchs].sort()) {
    const needed = archMax[name] || 1;
    // Init state if needed
    if (!ownedGearState[name]) ownedGearState[name] = { count: 0, pieces: [] };
    const st = ownedGearState[name];
    const controlId = ownedGearControlId(name);
    const archetypeLabel = getArchetypeLabel(name);
    const decreaseLabel = l(`减少${archetypeLabel}已有数量`,`減少${archetypeLabel}已有數量`,`Decrease owned ${archetypeLabel}`);
    const increaseLabel = l(`增加${archetypeLabel}已有数量`,`增加${archetypeLabel}已有數量`,`Increase owned ${archetypeLabel}`);
    const countLabel = l(`${archetypeLabel}已有数量`,`${archetypeLabel}已有數量`,`Owned ${archetypeLabel} count`);

    html2 += `<div class="owned-gear-row${st.count > 0 ? ' is-active' : ''}">
      <div class="owned-gear-row-head">
        <div class="owned-gear-identity">
          <span class="owned-gear-archetype">${archetypeLabel}</span>
          <span class="owned-gear-needed">${l('方案最多需要','方案最多需要','Solution needs up to')} <strong>${needed}</strong> ${l('件','件','piece(s)')}</span>
        </div>
        <div class="owned-count-control">
          <span>${l('已有','已有','Owned')}</span>
          <div class="owned-count-stepper">
            <button type="button" aria-label="${decreaseLabel}" onclick="changeOwnedCount('${name}',-1,${needed})" ${st.count <= 0 ? 'disabled' : ''}>−</button>
            <input type="number" id="ownedCnt_${controlId}" value="${st.count}" min="0" max="${needed}"
              inputmode="numeric" aria-label="${countLabel}" onchange="updateOwnedCount('${name}',this.value,${needed})">
            <button type="button" aria-label="${increaseLabel}" onclick="changeOwnedCount('${name}',1,${needed})" ${st.count >= needed ? 'disabled' : ''}>+</button>
          </div>
          <span>${l('件','件','piece(s)')}</span>
        </div>
      </div>`;

    // Show owned piece details if count > 0
    if (st.count > 0) {
      html2 += '<div class="owned-piece-list">';
      for (let p = 0; p < Math.min(st.count, needed); p++) {
        if (!st.pieces[p]) st.pieces[p] = { tertiary: '', tuneTo: '' };
        const pieceLabel = l(`${archetypeLabel}第${p + 1}件`,`${archetypeLabel}第${p + 1}件`,`${archetypeLabel} piece ${p + 1}`);
        html2 += `<div class="owned-piece-row" role="group" aria-label="${pieceLabel}">
          <span class="owned-piece-index" aria-hidden="true">${String(p + 1).padStart(2, '0')}</span>
          <label class="owned-piece-field"><span>${t('tertiaryStat')}</span>
          <select id="ownedTert_${controlId}_${p}" onchange="updateOwnedPiece('${name}',${p})">`;
        html2 += `<option value="">${l('未填写','未填寫','Not set')}</option>`;
        for (const s of STATS) {
          html2 += '<option value="' + s + '" ' + (st.pieces[p].tertiary === s ? 'selected' : '') + '>' + STAT_LABELS[s] + '</option>';
        }
        html2 += `</select></label>
          <label class="owned-piece-field"><span>${l('+5调整属性','+5調整屬性','+5 Tuning stat')}</span>
          <select id="ownedTune_${controlId}_${p}" onchange="updateOwnedPiece2('${name}',${p})">`;
        html2 += `<option value="">${l('未填写','未填寫','Not set')}</option>`;
        for (const s of STATS) {
          html2 += '<option value="' + s + '" ' + (st.pieces[p].tuneTo === s ? 'selected' : '') + '>' + STAT_LABELS[s] + '</option>';
        }
        html2 += '</select></label></div>';
      }
      html2 += '</div>';
    }
    html2 += '</div>';
  }

  html2 += `</div><div class="owned-gear-actions">
    <button class="btn" type="button" onclick="clearOwnedGear()" ${totalOwned === 0 ? 'disabled' : ''}>
      ${icon('trash')}${l('清空录入','清除輸入','Clear entries')}
    </button>
    <button class="btn owned-gear-apply" type="button" onclick="resortByOwned()" ${totalOwned === 0 ? 'disabled' : ''}>
      ${icon('refresh')}${l('按已有护甲排序方案','按已有防具排序方案','Sort solutions by owned armor')}
    </button>
  </div>`;
  section.innerHTML = html2;
  section.style.display = 'block';
}

function updateOwnedCount(name, val, max = 5) {
  const n = Math.max(0, Math.min(max, parseInt(val) || 0));
  if (!ownedGearState[name]) ownedGearState[name] = { count: 0, pieces: [] };
  ownedGearState[name].count = n;
  while (ownedGearState[name].pieces.length < n) ownedGearState[name].pieces.push({ tertiary: '', tuneTo: '' });
  // Rebuild the form to show/hide piece detail dropdowns, but don't refresh the solution
  buildOwnedGearSection(null, null);
}
function changeOwnedCount(name, delta, max) {
  const current = ownedGearState[name]?.count || 0;
  updateOwnedCount(name, current + delta, max);
}
function updateOwnedPiece(name, idx) {
  const el = document.getElementById('ownedTert_' + ownedGearControlId(name) + '_' + idx);
  if (el && ownedGearState[name] && ownedGearState[name].pieces[idx]) {
    ownedGearState[name].pieces[idx].tertiary = el.value;
  }
}
function updateOwnedPiece2(name, idx) {
  const el = document.getElementById('ownedTune_' + ownedGearControlId(name) + '_' + idx);
  if (el && ownedGearState[name] && ownedGearState[name].pieces[idx]) {
    ownedGearState[name].pieces[idx].tuneTo = el.value;
  }
}
function clearOwnedGear() {
  ownedGearState = {};
  buildOwnedGearSection(null, null);
}

function resortByOwned() {
  if (allSolutions.length <= 1) return;
  const activeSolution = allSolutions[currentSolutionIdx];

  // Build owned count map per archetype
  const ownedCount = {};
  let totalOwned = 0;
  for (const [name, st] of Object.entries(ownedGearState)) {
    ownedCount[name] = st.count || 0;
    totalOwned += st.count || 0;
  }
  if (totalOwned === 0) { alert(l('请先输入至少一件已有护甲。','請先輸入至少一件已有防具。','Enter at least one owned armor piece first.')); return; }

  // Count how many owned pieces match a solution (archetype + tertiary + tuning)
  function countOwnedMatches(sol, requireSpecifiedTertiary = false) {
    const armorSlots = [];
    const requiredTerts = [];
    const requiredTunes = [];
    for (let i = 0; i < 5; i++) {
      if (i === sol.exoticIndex) continue;
      const name = sol.config[i].archetype;
      armorSlots.push({
        name,
        primary: sol.config[i].primary,
        secondary: sol.config[i].secondary
      });
      const tune = sol.tuningAssignments[i];
      requiredTerts.push(sol.config[i].tertiary);
      requiredTunes.push(tune.mode === '+5-5' ? tune.to : '+3');
    }
    return selectOwnedArmorMatches(
      armorSlots, ownedGearState, requiredTerts, requiredTunes, requireSpecifiedTertiary
    ).matches.length;
  }

  const activeFullyMatches = countOwnedMatches(activeSolution, true) === totalOwned;

  // Sort: solutions with more owned pieces (including properties) rank higher
  allSolutions.sort((a, b) => {
    const aOwned = countOwnedMatches(a);
    const bOwned = countOwnedMatches(b);
    if (aOwned !== bOwned) return bOwned - aOwned;
    return farmabilityScore(a.config, a.exoticIndex) - farmabilityScore(b.config, b.exoticIndex);
  });

  const preservedIndex = allSolutions.indexOf(activeSolution);
  currentSolutionIdx = activeFullyMatches && preservedIndex >= 0 ? preservedIndex : 0;
  displayAllResults(allSolutions[currentSolutionIdx], lastTargets, lastFragments);
  const notice = document.getElementById('messages');
  notice.innerHTML += activeFullyMatches
    ? `<div class="msg info">${icon('check')}${l('已有护甲全部准确符合当前方案。方案列表已重新排序，当前方案保持不变。','已有防具全部準確符合目前方案。方案列表已重新排序，目前方案保持不變。','All owned armor matches the current solution. The list was re-sorted and the current solution was kept.')}</div>`
    : `<div class="msg info">${icon('check')}${l('已有护甲不完全符合原方案，已切换到匹配数最多且更好刷的方案。','已有防具不完全符合原方案，已切換到匹配數最多且較容易取得的方案。','Owned armor does not fully match the original solution; switched to the solution with the most matches and better farmability.')}</div>`;
}

// ============================================================
// EXISTING LOADOUT OPTIMIZER
// ============================================================
let calculatorMode = 'solve';
let upgradeBuildState = [];
let lastUpgradeAnalysis = null;

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

function renderUpgradeInferInputs() {
  const grid = document.getElementById('upgradeInferGrid');
  if (!grid) return;
  const totals = upgradeBuildState.length === UPGRADE_SLOTS.length
    ? finalizeUpgradeTotals(getManualUpgradeArmorTotals(upgradeBuildState), getUpgradeFragments())
    : Object.fromEntries(STATS.map(stat => [stat, 0]));
  grid.innerHTML = STATS.map(stat => `<label>${STAT_LABELS[stat]}<input id="upgradeInfer_${stat}" type="number" min="0" max="200" step="1" value="${totals[stat]}"></label>`).join('');
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
    const tuning = piece.tuningMode === 'plus3' ? '+3' : `+5 ${STAT_LABELS[piece.tuningTo]}`;
    const identity = `${getArchetypeLabel(archetype.id)} · ${t('tertiaryStat')} ${STAT_LABELS[piece.tertiary]} · ${t('tuning')} ${tuning}`;
    const status = piece.exotic
      ? l('异域固定件','異域固定件','Fixed Exotic')
      : (piece.locked ? l('固定不替换','固定不替換','Fixed') : l('可替换','可替換','Replaceable'));
    const isOpen = currentlyOpen.includes(index) || (currentlyOpen.length === 0 && index === 0);
    return `<details class="upgrade-piece-row" data-index="${index}" ondragover="event.preventDefault()" ondrop="handleUpgradeDrop(event,${index})" ${isOpen ? 'open' : ''}>
      <summary>
        <span class="upgrade-piece-slot"><span class="upgrade-drag-handle" draggable="true" ondragstart="handleUpgradeDragStart(event,${index})" ondragend="handleUpgradeDragEnd(event)" title="${l('拖动交换框架','拖曳交換原型','Drag to swap archetypes')}" aria-hidden="true">⋮⋮</span><small>${String(index + 1).padStart(2, '0')}</small>${getUpgradeSlotLabel(index)}</span>
        <span class="upgrade-piece-identity">${identity}</span>
        <span class="upgrade-piece-status ${piece.locked ? 'is-locked' : ''}">${piece.locked ? icon('lock', { size:'sm' }) : ''}${status}</span>
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
          <select ${piece.armorModSize === 0 ? 'disabled' : ''} onchange="updateUpgradePiece(${index},'armorModStat',this.value)">
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

function getUpgradeInferenceBudgets(armorTotal) {
  const current = getUpgradeModifierBudget(upgradeBuildState);
  const candidates = [];
  for (let numPlus3 = 0; numPlus3 <= 5; numPlus3++) {
    for (let numPlus10 = 0; numPlus10 <= 5; numPlus10++) {
      for (let numPlus5 = 0; numPlus5 + numPlus10 <= 5; numPlus5++) {
        const total = 450 + numPlus3 * 3 + numPlus5 * 5 + numPlus10 * 10;
        const budgetChange = Math.abs(numPlus3 - current.numPlus3) +
          Math.abs(numPlus5 - current.numPlus5) + Math.abs(numPlus10 - current.numPlus10);
        candidates.push({ numPlus3, numPlus5, numPlus10, total, budgetChange });
      }
    }
  }
  candidates.sort((left, right) =>
    Math.abs(left.total - armorTotal) - Math.abs(right.total - armorTotal) ||
    left.budgetChange - right.budgetChange
  );
  return candidates.slice(0, 4);
}

async function inferUpgradeArmor() {
  const fragments = getUpgradeFragments();
  const observed = Object.fromEntries(STATS.map(stat => [
    stat, Math.max(0, Math.min(200, Number(document.getElementById(`upgradeInfer_${stat}`)?.value) || 0))
  ]));
  const armorTarget = Object.fromEntries(STATS.map(stat => [
    stat, Math.max(0, observed[stat] - (fragments[stat] || 0))
  ]));
  const armorTotal = STATS.reduce((sum, stat) => sum + armorTarget[stat], 0);
  const button = document.querySelector('.upgrade-infer-panel .btn');
  const originalText = button?.textContent;
  if (button) { button.disabled = true; button.textContent = l('反推中…','反推中…','Inferring…'); }

  try {
    let best = null;
    for (const budget of getUpgradeInferenceBudgets(armorTotal)) {
      const result = (await solveLoadoutAsync({
        target: armorTarget,
        numPlus5: budget.numPlus5,
        numPlus10: budget.numPlus10,
        numPlus3: budget.numPlus3,
        constraints: {},
        runtimeOptions: { fastMode: true },
      }))[0];
      if (!result) continue;
      const finalTotals = finalizeUpgradeTotals(result.totals, fragments);
      const distance = STATS.reduce((sum, stat) => sum + Math.abs(finalTotals[stat] - observed[stat]), 0);
      if (!best || distance < best.distance || (distance === best.distance && result.score < best.result.score)) {
        best = { result, distance };
      }
    }
    if (best) {
      upgradeBuildState = best.result.config.map((config, index) => {
        const tuning = best.result.tuningAssignments[index];
        const mod = best.result.modAssignments[index];
        return normalizeUpgradePiece({
          ...upgradeBuildState[index], archetypeId: getArchetypeIdForConfig(config), tertiary: config.tertiary,
          tuningMode: tuning.mode === '+3' ? 'plus3' : 'shift',
          tuningFrom: tuning.from || upgradeBuildState[index].tuningFrom,
          tuningTo: tuning.to || upgradeBuildState[index].tuningTo,
          armorModSize: mod?.size || 0, armorModStat: mod?.stat || upgradeBuildState[index].armorModStat,
        }, index);
      });
      saveUpgradeDraft();
      renderUpgradeBuildEditor();
      document.getElementById('messages').innerHTML = `<div class="msg info">${icon('check')}${best.distance === 0
        ? l('已按六维反推出一套完全匹配的护甲，可继续微调或拖动交换框架。','已依六維反推出一套完全符合的防具，可繼續微調或拖曳交換原型。','Found an exact armor match. Fine-tune it or drag rows to swap archetypes.')
        : l(`已生成最接近的护甲，六维合计偏差 ${best.distance} 点；请按实际装备微调。`,`已產生最接近的防具，六維合計偏差 ${best.distance} 點；請依實際裝備微調。`,`Generated the closest armor match (${best.distance} total stat difference). Fine-tune it to your actual gear.`)}</div>`;
    }
  } catch (error) {
    console.error('Armor inference failed', error);
    document.getElementById('messages').innerHTML = '<div class="msg error">' +
      icon('block') + l(
        '护甲反推失败，请重试。',
        '防具反推失敗，請重試。',
        'Armor inference failed. Please try again.'
      ) + '</div>';
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

function updateUpgradePiece(index, field, value, rerender = false) {
  if (!upgradeBuildState[index]) return;
  upgradeBuildState[index][field] = value;
  upgradeBuildState[index] = normalizeUpgradePiece(upgradeBuildState[index], index);
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

function updateUpgradeBudgetSummary() {
  const summary = document.getElementById('upgradeBudgetSummary');
  if (!summary || upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  const budget = getUpgradeModifierBudget(upgradeBuildState);
  updateUpgradeLiveSummary();
  summary.innerHTML = l(
    `现在用了：<strong>${budget.numPlus3}</strong> 件 +3 · <strong>${budget.numPlus5}</strong> 个 +5 · <strong>${budget.numPlus10}</strong> 个 +10`,
    `目前用了：<strong>${budget.numPlus3}</strong> 件 +3 · <strong>${budget.numPlus5}</strong> 個 +5 · <strong>${budget.numPlus10}</strong> 個 +10`,
    `In use: <strong>${budget.numPlus3}</strong> × +3 · <strong>${budget.numPlus5}</strong> × +5 · <strong>${budget.numPlus10}</strong> × +10`
  );
}

function saveUpgradeDraft() {
  if (upgradeBuildState.length !== UPGRADE_SLOTS.length) return;
  buildRepository.writeUpgradeDraft({
    pieces: upgradeBuildState,
    reassignModifiers: document.getElementById('upgradeReassignModifiers')?.checked ?? true,
  });
}

function loadUpgradeDraft() {
  const draft = buildRepository.readUpgradeDraft();
  upgradeBuildState = UPGRADE_SLOTS.map((_, index) => normalizeUpgradePiece(draft?.pieces?.[index], index));
  const reassign = document.getElementById('upgradeReassignModifiers');
  if (reassign) reassign.checked = draft?.reassignModifiers !== false;
  renderUpgradeBuildEditor();
}

function setCalculatorMode(mode, persist = true) {
  calculatorMode = mode === 'upgrade' ? 'upgrade' : 'solve';
  const isUpgrade = calculatorMode === 'upgrade';
  document.body.classList.toggle('is-upgrade-mode', isUpgrade);
  document.getElementById('modeSolveButton')?.setAttribute('aria-pressed', String(!isUpgrade));
  document.getElementById('modeUpgradeButton')?.setAttribute('aria-pressed', String(isUpgrade));
  document.getElementById('upgradeBuildCard').hidden = !isUpgrade;
  document.getElementById('btnSolve').hidden = isUpgrade;
  document.getElementById('btnUpgradeAnalyze').hidden = !isUpgrade;
  document.getElementById('saveBuildButton').hidden = isUpgrade;
  document.getElementById('upgradeResults').hidden = !isUpgrade || !lastUpgradeAnalysis;
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
  if (persist) {
    buildRepository.writeCalculatorMode(calculatorMode);
  }
}

function initializeUpgradeOptimizer() {
  loadUpgradeDraft();
  renderUpgradeInferInputs();
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
    const targetReached = after >= target;
    const deltaClass = targetReached ? 'is-target-met' : 'is-shortfall';
    const targetStatus = targetReached
      ? l('达标','達標','met')
      : l(`差 ${target - after}`, `差 ${target - after}`, `${target - after} short`);
    return `<div class="upgrade-stat">
      <div class="upgrade-stat-label" style="color:${STAT_COLORS[stat]}">${icon(stat)}${STAT_LABELS[stat]}</div>
      <div class="upgrade-stat-values">${before} <small>→</small> ${after}</div>
      <span class="upgrade-stat-delta ${deltaClass}">${delta > 0 ? '+' : ''}${delta} · ${l('目标','目標','target')} ${target} · ${targetStatus}</span>
    </div>`;
  }).join('')}</div>`;
}

function buildUpgradeBaselineNote(analysis) {
  if (!analysis.reassignModifiers || !analysis.enteredBaseline) return '';
  const changedStats = STATS.filter(stat =>
    analysis.enteredBaseline.finalTotals[stat] !== analysis.baseline.finalTotals[stat]
  );
  if (changedStats.length === 0) return '';
  return `<div class="upgrade-baseline-note">
    ${icon('refresh', { size:'sm' })}
    <span><strong>${l('数值说明：','數值說明：','Stats:')}</strong>${l('', '', ' ')}${l(
      '左侧为当前六维，右侧为替换并重配模组后的六维。',
      '左側為目前六維，右側為替換並重配模組後的六維。',
      'Left shows current stats; right shows the result after swaps and mod changes.'
    )}</span>
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

function buildUpgradeRanking(analysis) {
  if (analysis.rankings.length === 0) return '';
  return `<div class="upgrade-ranking">
    <h3>${l('如果只想先换一件','如果只想先換一件','If you only want to replace one piece first')}</h3>
    ${analysis.rankings.map((candidate, index) => `
      <div class="upgrade-ranking-row ${index === 0 ? 'is-best' : ''}">
        <strong>#${index + 1} ${getUpgradeSlotLabel(candidate.slotIndex)}${candidate.tuningOnly
          ? ` · ${l('只差 +5 属性','只差 +5 數值','+5 stat only')}`
          : ''}</strong>
        <span>${formatUpgradePieceSummary(candidate.afterPiece)}</span>
        <span>${candidate.metrics.allReached
          ? l('换这一件就够了','換這一件就夠了','This one replacement is enough')
          : l(`换完还差 ${candidate.metrics.shortfall} 点 · 少 ${candidate.effectiveGain} 点`, `換完還差 ${candidate.metrics.shortfall} 點 · 少 ${candidate.effectiveGain} 點`, `${candidate.metrics.shortfall} short · improves by ${candidate.effectiveGain}`)}</span>
      </div>`).join('')}
  </div>`;
}

function renderUpgradeAnalysis(analysis, scroll = false) {
  if (!analysis) return;
  lastUpgradeAnalysis = analysis;
  const section = document.getElementById('upgradeResults');
  const body = document.getElementById('upgradeResultsBody');
  section.hidden = calculatorMode !== 'upgrade';

  if (analysis.baseline.metrics.allReached) {
    const enteredAlreadyReached = analysis.enteredBaseline.metrics.allReached;
    body.innerHTML = `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${l('当前配装','目前配裝','Current loadout')}</div>
        <div class="upgrade-recommendation">${enteredAlreadyReached
          ? l('不用换护甲','不用換防具','Keep all five pieces')
          : l('只要重配模组','只要重配模組','Just rearrange the mods')}</div>
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
    body.innerHTML = `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${l('没有合适的替换','沒有合適的替換','No useful replacement found')}</div>
        <div class="upgrade-recommendation">${l('暂时没有更好的换法','暫時沒有更好的換法','There is no better swap right now')}</div>
        <p class="upgrade-recommendation-copy">${l(
          '能换的框架都试过了。固定护甲和模组数量不变的话，缺口已经降不下去了。可以先降低一项目标，或放开一件固定护甲。',
          '能換的原型都試過了。固定防具和模組數量不變的話，缺口已經降不下去了。可以先降低一項目標，或放開一件固定防具。',
          'We tried every available archetype swap. With the same fixed pieces and mod count, the gap will not get any smaller. Lower one target or unlock a piece and try again.'
        )}</p>
      </div>
      <div class="upgrade-outcome"><strong>${l(`还差 ${analysis.baseline.metrics.shortfall} 点`, `還差 ${analysis.baseline.metrics.shortfall} 點`, `${analysis.baseline.metrics.shortfall} points short`)}</strong><span>${l('先调整目标或固定护甲','先調整目標或固定防具','Change a target or fixed piece first')}</span></div>
    </div>
    ${buildUpgradeStatComparison(analysis, analysis.baseline.finalTotals)}
    ${buildUpgradeBaselineNote(analysis)}
    ${buildUpgradeRanking(analysis)}`;
  } else {
    const plan = analysis.plan;
    const reached = plan.metrics.allReached;
    body.innerHTML = `<div class="upgrade-hero">
      <div>
        <div class="upgrade-eyebrow">${reached
          ? l('推荐换法','推薦換法','Recommended swaps')
          : l('最接近目标的换法','最接近目標的換法','Closest match found')}</div>
        <div class="upgrade-recommendation">${reached
          ? l(`换 ${plan.replacementCount} 件就能达标`, `換 ${plan.replacementCount} 件就能達標`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} to meet every target`)
          : l(`换 ${plan.replacementCount} 件后还差 ${plan.metrics.shortfall} 点`, `換 ${plan.replacementCount} 件後還差 ${plan.metrics.shortfall} 點`, `Replace ${plan.replacementCount} piece${plan.replacementCount === 1 ? '' : 's'} and remain ${plan.metrics.shortfall} short`)}</div>
        <p class="upgrade-recommendation-copy">${reached
          ? l(
            '方案已按优先顺序排好，照着下面执行即可。',
            '方案已按優先順序排好，照著下面執行即可。',
            'The swaps are already prioritized. Follow the steps below.'
          )
          : l(
            '目前没有一套能把六项都补齐。下面这套差得最少，可以先参考；想完全达标，还得降低目标或放开一件固定护甲。',
            '目前沒有一套能把六項都補齊。下面這套差得最少，可以先參考；想完全達標，還得降低目標或放開一件固定防具。',
            'Nothing we found fills all six targets. This is the closest setup; to hit everything, lower a target or unlock one fixed piece.'
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
    ${buildUpgradeAssignments(analysis, plan.evaluation, true)}`;
  }
  if (scroll) section.scrollIntoView({ behavior:'smooth', block:'start' });
}

async function analyzeArmorUpgrades() {
  const button = document.getElementById('btnUpgradeAnalyze');
  const loading = document.getElementById('loading');
  const messages = document.getElementById('messages');
  const targets = getUpgradeTargets();
  const fragments = getUpgradeFragments();
  const reassignModifiers = document.getElementById('upgradeReassignModifiers')?.checked !== false;
  const unlockedCount = upgradeBuildState.filter(piece => !piece.locked).length;
  messages.innerHTML = '';
  if (unlockedCount === 0) {
    messages.innerHTML = `<div class="msg error">${icon('block')}${l(
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
      });
      renderUpgradeAnalysis(analysis, true);
      messages.innerHTML = `<div class="msg info">${icon('check')}${analysis.baseline.metrics.allReached
        ? l('算好了：现在这套不用换护甲。','算好了：目前這套不用換防具。','Done: you can keep the current armor.')
        : (analysis.plan
          ? (analysis.plan.metrics.allReached
            ? l(`算好了：换 ${analysis.plan.replacementCount} 件就能达标。`, `算好了：換 ${analysis.plan.replacementCount} 件就能達標。`, `Done: replace ${analysis.plan.replacementCount} piece(s) to meet every target.`)
            : l(`算好了：最接近的方案还差 ${analysis.plan.metrics.shortfall} 点。`, `算好了：最接近的方案還差 ${analysis.plan.metrics.shortfall} 點。`, `Done: the closest setup is still ${analysis.plan.metrics.shortfall} points short.`))
          : l('没有找到能缩小缺口的替换方案。','沒有找到能縮小缺口的替換方案。','No replacement plan reduces the gap.'))}</div>`;
    } catch (error) {
      console.error('Armor upgrade analysis failed', error);
      messages.innerHTML = '<div class="msg error">' + icon('block') + l(
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

  const build = {
    name,
    language: getPageLanguage(),
    targets,
    fragments,
    targetLocks: Object.fromEntries(STATS.map(s => [s, document.getElementById('targetLock_' + s)?.checked || false])),
    numPlus5: getVal('numPlus5'),
    numPlus10: getVal('numPlus10'),
    n3Enabled: document.getElementById('usePlus3')?.checked || false,
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
  document.getElementById('usePlus3').checked = build.n3Enabled;
  document.getElementById('plus3CountRow').style.display = build.n3Enabled ? 'block' : 'none';
  if (build.n3Enabled) {
    document.getElementById('plus3CountVal').textContent = build.numPlus3;
  }
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
    lastNumPlus3 = build.n3Enabled ? build.numPlus3 : 0;
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


Object.assign(window, {
  adjFragment,
  adjPlus3,
  analyzeArmorUpgrades,
  applyNearestTargetSuggestion,
  balanceTargetsToBudget,
  changeOwnedCount,
  changePageLanguage,
  clearAllBuilds,
  clearOwnedGear,
  deleteBuild,
  getSavedBuilds,
  handleUpgradeDragEnd,
  handleUpgradeDragStart,
  handleUpgradeDrop,
  inferUpgradeArmor,
  loadBuild,
  refineWithPriorities,
  resetConstraints,
  resetTargetStats,
  resortByOwned,
  saveBuild,
  setCalculatorMode,
  solve,
  switchSolution,
  sync10to5,
  sync5to10,
  toggleAllSolutions,
  toggleExoticMode,
  togglePlus3,
  updateExoticFramework,
  updateExoticPerkOptions,
  updateOwnedCount,
  updateOwnedPiece,
  updateOwnedPiece2,
  updateRefineActionState,
  updateUpgradeOption,
  updateUpgradePiece,
  updateUpgradeTuningChoice
});

// ============================================================
// INIT
// ============================================================
initializePageLanguage();
renderInputs();
renderExoticInputs();
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
