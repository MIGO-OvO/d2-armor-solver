// Stateless renderers: no API calls and no optimistic server-state claims.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
export function bungieImage(path) {
  return typeof path === 'string' && /^\/common\/[a-zA-Z0-9_./-]+$/.test(path) ? `https://www.bungie.net${path}` : '';
}

let pickerSequence = 0;
export function renderCharacterCards({characters, selected, classId, busy, l, classLabel}) {
  const group = `bungie-character-${++pickerSequence}`;
  const latest = [...characters].sort((a, b) => String(b.dateLastPlayed || '').localeCompare(String(a.dateLastPlayed || '')))[0];
  return `<fieldset class="bungie-characters"><legend>${l('目标角色', '目標角色', 'Target character')}</legend><div class="bungie-character-list">${characters.map(character => {
    const compatible = !classId || character.classId === classId;
    const background = bungieImage(character.emblemBackgroundPath);
    const emblem = bungieImage(character.emblemPath);
    return `<label class="bungie-character ${compatible ? '' : 'is-incompatible'}">
      <input type="radio" name="${group}" value="${escape(character.characterId)}" ${selected === character.characterId ? 'checked' : ''} ${busy || !compatible ? 'disabled' : ''} onchange="setBungieTargetCharacter(this.value)">
      <span class="bungie-character-art" ${background ? `style="background-image:url('${background}')"` : ''}></span>
      ${emblem ? `<img src="${emblem}" alt="" width="40" height="40" onerror="this.hidden=true">` : ''}
      <span class="bungie-character-copy"><strong>${escape(classLabel(character.classId))}</strong><small>${escape(!compatible ? l('职业不匹配', '職業不符', 'Incompatible class') : [character.title, character.characterId === latest?.characterId ? l('最近使用', '最近使用', 'Most recent') : l('可选择', '可選擇', 'Available')].filter(Boolean).join(' · '))}</small></span>
      <span class="bungie-character-power">${Number(character.light) || '—'}</span></label>`;
  }).join('')}</div></fieldset>`;
}

export function renderBungieTask(task, {l, ownerLabel, itemLabel, imageFor, errorLabel}) {
  if (!task) return '';
  const plan = task.plan;
  const active = ['checking', 'running', 'verifying'].includes(task.status);
  const titles = {checking: l('同步并检查', '同步並檢查', 'Sync and check'), ready: l('确认操作', '確認操作', 'Review actions'),
    blocked: l('需要处理', '需要處理', 'Action needed'), running: l('正在应用', '正在套用', 'Applying'),
    verifying: l('回读核对', '回讀核對', 'Verifying server state'), done: l('操作已确认', '操作已確認', 'Confirmed'),
    partial: l('部分完成', '部分完成', 'Partially complete'), stopped: l('已停止后续操作', '已停止後續操作', 'Remaining actions stopped'),
    unknown: l('状态待确认', '狀態待確認', 'State unconfirmed')};
  const states = {queued: l('等待', '等待', 'Waiting'), running: l('处理中', '處理中', 'In progress'),
    succeeded: l('请求成功 · 待核对', '請求成功 · 待核對', 'Request succeeded · verifying'),
    failed: l('失败', '失敗', 'Failed'), unknown: l('待确认', '待確認', 'Unconfirmed'),
    skipped: l('前置步骤失败', '前置步驟失敗', 'Dependency failed'), verified: l('已确认', '已確認', 'Confirmed')};
  const stages = {space: l('腾出槽位', '騰出欄位', 'Free slot'), prepare: l('调入备用件', '調入備用件', 'Fetch spare'),
    'unequip-source': l('来源角色换装', '來源角色換裝', 'Equip source spare'), transfer: l('转移', '轉移', 'Transfer'),
    equip: l('穿戴', '穿著', 'Equip'), plugs: l('安装模组', '安裝模組', 'Install mod')};
  const rows = (plan?.items || task.items || []).map(item => {
    const id = String(item.id);
    const observed = task.verification?.itemStates?.find(state => state.itemId === id);
    const itemEvents = task.events?.filter(event => event.itemId === id && event.state) || [];
    const event = itemEvents.at(-1);
    const confirmed = observed?.arrived && (task.mode === 'collect' || observed.equipped);
    const failedMod = task.verification?.plugs?.some(plug => plug.itemId === id && !plug.verified);
    const state = confirmed && !failedMod ? 'verified' : failedMod ? 'failed' : event?.state || 'queued';
    const location = observed?.owner || (event?.state === 'succeeded' && event.stage === 'transfer' ? event.to : item.owner);
    const path = String(item.owner) === task.target ? ownerLabel(task.target) + l(' · 无需移动', ' · 無需移動', ' · No transfer needed') : item.owner === 'Vault'
      ? `${ownerLabel('Vault')} → ${ownerLabel(task.target)}` : `${ownerLabel(item.owner)} → ${ownerLabel('Vault')} → ${ownerLabel(task.target)}`;
    const image = bungieImage(imageFor(item));
    return `<li class="bungie-task-item" data-state="${state}">${image ? `<img src="${image}" alt="" width="40" height="40" onerror="this.hidden=true">` : '<span class="bungie-item-placeholder" aria-hidden="true"></span>'}
      <span><strong>${escape(item.name || itemLabel(id))}</strong><small>${escape(path)}</small>
      ${observed ? `<small>${escape(l('当前位置：', '目前位置：', 'Current location: ') + (location ? ownerLabel(location) : l('未知', '未知', 'Unknown')))}</small>` : ''}</span>
      <span class="bungie-task-state">${escape(failedMod ? l('护甲已穿戴 · 模组待处理', '防具已穿著 · 模組待處理', 'Armor equipped · mods pending') : states[state] || state)}${event?.stage && state !== 'verified' ? `<small>${escape(stages[event.stage] || '')}</small>` : ''}${event?.errorCode && state !== 'verified' ? `<small>${escape(errorLabel(event.errorCode))}</small>` : ''}</span></li>`;
  }).join('');
  const actual = task.verification?.itemStates || [];
  const plugs = task.verification?.plugs || [];
  const count = plan?.items?.length || task.items?.length || 0;
  const sent = new Set(plan?.alreadyOnTargetIds || []);
  for (const event of task.events || []) if (event.stage === 'transfer' && event.state === 'succeeded' && event.to === task.target) sent.add(event.itemId);
  const executingSummary = active && plan ? l(`已到位或收到转移成功响应 ${sent.size}/${count}，最终状态将回读核对。`, `已到位或收到轉移成功回應 ${sent.size}/${count}，最終狀態將回讀核對。`, `${sent.size}/${count} already present or transfer acknowledged; final state will be verified.`) : '';
  const summary = task.verification ? l(
    `到位 ${actual.filter(item => item.arrived).length}/${count} · 已穿戴 ${actual.filter(item => item.equipped).length}/${count} · 模组确认 ${plugs.filter(plug => plug.verified).length}/${plugs.length}`,
    `到位 ${actual.filter(item => item.arrived).length}/${count} · 已穿戴 ${actual.filter(item => item.equipped).length}/${count} · 模組確認 ${plugs.filter(plug => plug.verified).length}/${plugs.length}`,
    `Located ${actual.filter(item => item.arrived).length}/${count} · Equipped ${actual.filter(item => item.equipped).length}/${count} · Mods verified ${plugs.filter(plug => plug.verified).length}/${plugs.length}`) : '';
  const extras = [...(plan?.moveAsideTransfers || []), ...(plan?.preparationTransfers || [])];
  return `<header><h3 id="bungieTaskHeading">${titles[task.status] || titles.unknown}</h3><button class="btn" onclick="closeBungieTask()" ${active ? 'disabled' : ''}>${l('关闭', '關閉', 'Close')}</button></header>
    <p>${escape(ownerLabel(task.target))} · ${escape(task.mode === 'collect' ? l('仅收集，不改变穿戴', '僅收集，不變更穿著', 'Collect only; keep equipped gear') : task.mode === 'equip' ? l('仅穿戴护甲，不安装模组', '僅穿著防具，不安裝模組', 'Equip armor only; no mods') : l('穿戴护甲并安装模组', '穿著防具並安裝模組', 'Equip armor and install mods'))}</p>
    <p class="bungie-task-announcement">${escape(task.message || summary || titles[task.status])}</p>
    ${executingSummary ? `<p>${escape(executingSummary)}</p>` : ''}
    ${summary && task.message ? `<p>${escape(summary)}</p>` : ''}
    <ul class="bungie-task-items">${rows}</ul>
    ${plan?.errors?.length ? `<ul class="bungie-task-errors">${plan.errors.map(error => `<li>${escape((error.slot ? error.slot + ': ' : '') + errorLabel(error))}</li>`).join('')}</ul>` : ''}
    ${extras.length ? `<details ${task.status === 'ready' ? 'open' : ''}><summary>${l('额外整理与备用件', '額外整理與備用件', 'Space management and spare armor')} (${extras.length})</summary><ul>${extras.map(request => `<li>${escape(itemLabel(request.itemId))} · ${escape(ownerLabel(request.transferToVault ? request.characterId : 'Vault'))} → ${escape(ownerLabel(request.transferToVault ? 'Vault' : request.characterId))}</li>`).join('')}</ul></details>` : ''}
    ${task.events?.length ? `<details><summary>${l('操作记录', '操作記錄', 'Operation log')}</summary><ol class="bungie-task-log">${task.events.filter(event => event.itemId && event.state).map(event => `<li>${escape(itemLabel(event.itemId))} · ${escape(states[event.state] || event.state)}${event.errorCode ? ` · ${escape(errorLabel(event.errorCode))}` : ''}</li>`).join('')}</ol></details>` : ''}
    ${plan?.skippedMods?.length ? `<p>${l(`${plan.skippedMods.length} 个模组因能量不足暂不安装。`, `${plan.skippedMods.length} 個模組因能量不足暫不安裝。`, `${plan.skippedMods.length} mods deferred for insufficient energy.`)}</p>` : ''}
    <p class="bungie-task-note">${l('不会升级大师或替换碎片。停止仅取消后续步骤，已完成的操作不会撤销。', '不會升級大師或替換碎片。停止僅取消後續步驟，已完成的操作不會撤銷。', 'No masterwork upgrades or Fragment changes. Stopping cancels remaining steps, not completed actions.')}</p>
    <footer>${task.status === 'ready' ? `<button class="btn-solve" onclick="confirmBungieTask()">${l('确认执行', '確認執行', 'Confirm and apply')}</button>` : ''}
    ${task.status === 'running' ? `<button class="btn" onclick="stopBungieTask()" ${task.stopRequested ? 'disabled' : ''}>${l('停止后续操作', '停止後續操作', 'Stop remaining actions')}</button>` : ''}
    ${!active && task.status !== 'ready' ? `<button class="btn" onclick="recheckBungieTask()">${l('重新核对', '重新核對', 'Check again')}</button>${task.status !== 'done' ? `<button class="btn-solve" onclick="retryBungieTask()">${l('检查并继续未完成步骤', '檢查並繼續未完成步驟', 'Review remaining actions')}</button>` : ''}` : ''}</footer>`;
}
