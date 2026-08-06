// ============================================================
// ICONS
// ============================================================
export const STAT_ICON_ASSETS = Object.freeze({
  health: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAB80lEQVRYw+2XsW7bMBCGPxKGtsBzhi4ZigxxXiCDvGQK0Jdox2bxA0SwkdlLPfYRMhXI7gwdu9gZgg5ZWsDoaGTTcNehqMKTqEJM4bZI9U8iecdPIo/UHfTq9dekXodP9Byq72gqmVzKlYzSITKSK7mUrDnimhAuOAZKpn6dBqEgA1bMfPlLTAUhFVRBiIHMSqoPIJBRdF06A4FjLuweDYz1HoemnTGm+h4548SMfvTX1fMYuyOH7LFtwbitTM1b3bhFMLzPkZnqPvBcaEZeNUumbhua1sLPr5lSVpC5026L5tTNuXmE1Pe0EeUVKAFiQNHAGTQd/FqmjN0iBfIDpHMtWcaicxBz8GuSTswjiHfxka5Xw2+qxzxBLt4tZ+w3Oo84MO17bhs2m+BmCBSNNOCkduJjOqhhAW6JYp7X3vSYfxfTFtCf+Nboe8kL0/7C54bN1/h0LcczJnnDK9Pxwb/v6vu89uY/wMhIzjUhOH5KnZzHE8gIRkYUnOokFaROJ5zGM9UGpkpT8zSQOp2Q05IS1zAmF04AVRDiIHML6FALkwvnWgYp0ab2t9wEnm+D1BYyCn3t2nJoHrgLKgIoWQYffh3/MwKwJDcveMdD66I5YcYqgHSub0zuDStmTszMdYfdVGsx8x3UnlH9kUq6V68d6DuFzLoTywfGBQAAAABJRU5ErkJggg==',
  melee: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAAy0lEQVR42mP8z0APwMQwas2oNcPIGhYc4pvgrPsM+Qw6DG1w/l6GiQx+DClw/hyGTQyRDJFwvt9o3IxaM+ytYcRR34jCWX8Y3jOwMgjA+T8YPjNwMvDA+V8YvjNwMXDD+a9JsWZ4FTbVRJuwi+E0gymDG5zfSoo15kRbc5mBgUGSkPrRfEPFJIAKtjI8xxs3VLLmKMOVYRRoRgxieOXVqGNNyGiCHnnZcy99as/hFWjmZJt4kpRA20S2NaNN9WHS6hwNtFFrRq0ZcGsAKYQgTmfkXjoAAAAASUVORK5CYII=',
  grenade: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAB00lEQVRYw+2Wv0tcQRDHP7sIYpEihW2sNBCsEzjwrhAEG0EwnaZKc+1V4QI2/iAIEUxhYaV/QSApUkgKrbQQQ0wOEkianIgciBbKceCOhUcKczO773JYvW+17+3sfHaGmd2FXLlyZZWzJgUpM5ng5Zuv2gbexLxMgiTIwIQXTPUGYmDCc2Z6BYE+BTLNXHu4z++ol9OYgVIC4UN7sONWnfx/NGYJsNcbiJq0tj7fQmRIHhhWwdXMvohiAJCSVCL9tSORqO2kAeFhDAKUZMI2sDBX1IG+KASg357Wk9Zk3h///fpKA3jEMCfUgAEKnHMAwHh8FxqmxYL/CcBjAD76fQhTDFPzaxAGKVD3awBhHBgRM2gtaYv+CCA8pZKQMihK2aoBBeO/tCGvUmoRgEkpixqQUQJSopoMuQVVNJB+dI5JJV7ud1QSJcW6o2JSIf8D6vxbdRVe86wLDL7jHZU1LV0qx+S6H+l9M8uTbhx2fn+qZ5YbkNEuKA0FrtnLFr8yQ1osZ8T4FstcZMS888rWjL7xDd5wnQHy3u+qvqx1/jsbyZBDt2l4stf6T2wnQU7civVSix42bp0fUUjTLbpLc7tRzLVb4ixi9Nb9SYo5V65cGXQDiK9vesV3DT4AAAAASUVORK5CYII=',
  super: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAEHUlEQVR42u3YS2wVVRjA8V9LeVigCo2UQqQg0pAgGFHBqAuiLDTBxI0bE4IxLARfMYq1IqWU0hJTDNFgo7IwisawrBsJqAgYAkYFBFESgkgUWgGh4SG3yLjo6TD3VW5JcWE4N7kzc+bM95/zne91pijyX7Ri1zHXMX1+4pO+P9V3zM2GKb92mHIPg1GoAPcp7W9MuaYwtgKjwY0aCgUVFwyp1E5AjAIdqjUY1l+YCk0qCZjLSmtHtWZl/YEZbaXKWGxSad3XVVZcGXQlTJnmYFendMWYbqV1+SsGDeorZqxWs+P+Ti32g59AiZEoVwIOgb3elgrjB3jE+2H2yRZl/56M2qLW6P5Ez93Rc9GgSCQaG7VFbVFbNCYSicqiV6I7E+NmRe9GbdET2TKLcuabR81X5KAP/ZBxZ7p6sDTrzj3mGi/S6vNsgSU5VfmZk14y0TJ7feBAmtWlH7vbFPNMRsoq23MJLMmzZt/otFip27XY4SO/5cVMMM90cNbysIIFYQbqwo9q1RuBmWbY7GMdBqoOYyrD/1wPhJ4TloaXKXYpU2T22lRZZq1twRUbjAn9F31lavAY+M5JD8UWeUSdE2CWx+PzvJgeZ1urLfjNUpOu6ML7LXcGPOYpHPVaOmhAfS4I0x31Ky7YbGI8o9xth0bnwRzzwXAzfetsbve8LRE2dtoazlIafdELZKOm2Dm/jK2y0sqEghNKq06E9Z2a/ZMmbF2euPWLRWnXpepNjo2i1rH02YxIQHZkQeQNjjdkXJ/zuj1x+mjuSRPF8e0/EzF5aJa4VB5Mqm9p7YLFDmcZwuV2KM/zBzOuB6kzLaG0M5km0NkLaLxb8mDuTS60Ug1pkGO5/abMClXh/HeLwruM09RL4jqhRgcYbEUcJdIgmfkmOaOfA2S0Zb1mx3LLQ+JLBRxH1SQh2Wmt06sOYIu34mKjpyo77dOEy33do3eVGpUhssrOEAM60sWmR4Hu1LsN77mEEZrjWLxBo+9NDUFzmxYbjTQ+KPsuW3SJbFdudWZEkyetZa7UEWtCiF8YisL11oE7LAzgA+qc63vJUapBFbqs83ycR9ozjrs9a72LqLYkf+GRDzNYg1ux2zPWJ2LCsQxM92u8YD+mqDOgL5hBlqh22puWBMHlcaWZxAx3U1BqjTXOmqY2N6g4Z1+taTZZYHP3+pnjHQsS4iPHQY3WsFZs8LQtZnix8CR9Xq19sbm+bFKcljv9bYjjQY0TDLXQg1b7A6e12GS2IlEhmAveSPPy83Ht3K22cWFOQwwPUfpMPHqXXVdXQ6c02IOS4KbtadU0hy3W2R87gh7QqNjWLmMKghS6v+kGVcS21oMpEFL4bi2lISS+9tisTxUKyV915gLty1ibrYVvcYuu4tNQjqryWmCuf0z5X2H+BZweWOX++PxrAAAAAElFTkSuQmCC',
  class: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAC0ElEQVR42u2XTUhUURTHf840OiguhgZKwqhcVNAqBBcxZJhf+dU45WibNrVuX6v2BS1btPYj/CAdsAgqMAKphGCodKEEgS0KF6aMH2kL/955z5zxvTeTi5o3iznv3vvu7/3Pufecd4s22Y/LRwHzL2GO7wfmCPc4+PcxVwgQdftQUYZ946fEdr/OKgCHeYiPVW6yAEAJftu4FBu7TXcgA76aO7b7B7wAII4PKCbGIwAauWEbd5ukd6fN8wqAMOfV0kA5AONSlZfYDMoVXUZ9UPFZYyRfmO9yWJiLltZWo2cxP5jH/AIgaotkkDYAVhjOB+YHzwEI0bijp41SABJ769kbMyItMYrVsqb/MjqkJ5ErZoFxAMppUssG901vu3bXE5Zywwzp3aNGy0veMGn0tAKwzGgumEWeSUur0TIA9JoRndKTIOUdM8wKAB0E1fKab8Ac73VfziW9UMIrZvvRUlrUskm/rD4z6jIBLZWUN8yY0VJmtHyVNcOUrBDNNge7xCwprEHaLRs1fQ0YK6ZtO6ws7gozyjIALUbLJF8AOA3AJ5OLQ0pCCzx1i0kxpnrSadp6VXHuErLcb6VUv+Kz7g7zgZ+2BAlvmVPFCRIDIMlH9YWpV2L67GVBByxxGdCEF4AmwdOximafKTumWe6BKWbknq3qGVXrtPorqPWKCcg5gPZLuuJsOzO9f+LZ5sqGqTNakvJ5p6V6dkjPrNFzzgvGT9eONRaiwdLfomqT1tPtBVNP2GhJ7qg41mozafRUEnGL8VniMqjMFmHJ9qtTNhsyI69mwmT6TqvlkKxpZa9lrmcYO0E3lQAco8bUIgdqfMSN3efgo6TfWD1unBahQtasycTZrgnmZZ2g2rnT0mtsk1uOPhhXLfvnnTNMRJ4GqKLK5cf/Sc7+6YHdnBbP8WjW7SQ2NRzNEXOKM3tjevJw1Lzm9BhVOLAXMAXM/4L5DdZvnwbdUOcgAAAAAElFTkSuQmCC',
  weapons: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAADnklEQVRYw+2XT2hcdRDHP/NLiGXrbtCiJiqIVXpJUaikil5sRdp6K/QgUtJDQRKKkKS31iRqqwUra8VzoV7yx+MeCiKiom3RogdtUAKJRNJ4sDX6Xkwbk8542Le/ffvvZV8U6yGzh52Z32/mO/N9vzfvPdiQDfkvRNJsNontN7HmI1tTwbzJdm9c4Vjzke7fpmcdMIbu0iHNlGz5qrxW1jWjQ7ormcGEa2ObbYCdwBTDbilK+RIvAjDuRiNPm7xuXcBlycufqbvRDsuzE4BtvOE7+q7yX9sYti4Auu2MdqSE0Q45Rac3tzHYIL6fx7x+n5zS+1PA6J28Zlu8ucq4nG7A+XuMsepp3sKIZpuEMeQo5armZcCNynIDmGU3Rj/z3tHJ0XqHoR7MHnvCG1MMyiyJ4n5mkClv7rB9TcBohh5vXC2fsUSgJYa56s2DtnntbvZTYneFk25Jd2tB+zRT/LEpWttU8mifFnS3W+IEf0VrWdtfnbRq2Fir7fXGqCtVuI9qIoZr6p3XMQ5Fxl6bkJWEbqyb9khdkMLadMVFCvwWqTnrTuyGp7x2PlbPDFcA5JnyMZfrdgGA7WyNPCt6noPR8pNcrCihhrSs5KxdsnwvAYA+yA6m3SSAvhWf0O4YgHbxCN+6OQDLWReBBISEciuhG1llgYUKVueYS6LKTTLpowMuNdiVjv/1SkU3muEwISEhAX8QSsCiaDNpzJG1LFnayZElS5az8TuuAkZa7fmKYEAPu1/XAtF77Gy1Tz643aRVyCIhAWGjoVlR+bJd9mQ1AXODkwSEEhKmeW+RgBNFzSBnRbgbDWFkha//GTkCAUGt//ZcG72XpyOWb7ozaZPpK+QIJLBFLrpfEmDkph2iJQr6wn2TBsQeL94OBiqfJJImARe88bLdkaKTNuv1WS7J74kwwDilM9ZpR1Ictz4eKLXFh9WLNTBujo+88az10JRoD89542P5aU0Y4Bzl8XJAj1hLMoQ57eWAJ+w652r31IFxS5wuv3uxx/IaPbhiXq/bQ/YOL5S99rZbbAoG3I/kKV+Wh+m34om8Ftt0DcBabJBHY9733Q91M9Ynwn0peUqPgFl5VYq1T8e2TAPILRmi9B5n5N2nDfI1Ylw+Z4gQmJXjUhof8VEU6RLIcWaBRRl2n7Ee0bu013Jxj41oQQtasJEKb0579e6kTKm+PUG38i6CMeBm0sSlHJ1uhglgIh3IuiT2SbIhG/I/k78BAZxEA4OCcUoAAAAASUVORK5CYII=',
});

// Stat names resolve to exact embedded copies of the PNG files in
// asset/PNG_51px. Other names continue to use the inline SVG sprite.
export function icon(name, { size = '', label = '', cls = '' } = {}) {
  const isStat = Object.prototype.hasOwnProperty.call(STAT_ICON_ASSETS, name);
  const classes = ['icon', isStat ? 'icon--stat' : '', size ? `icon--${size}` : '', cls].filter(Boolean).join(' ');
  const a11y = label
    ? ` role="img" aria-label="${label}"`
    : ' aria-hidden="true"';
  if (isStat) {
    return `<span class="${classes}" data-stat-icon="${name}" style="--stat-icon-image:url('${STAT_ICON_ASSETS[name]}')"${a11y}></span>`;
  }
  return `<svg class="${classes}"${a11y} focusable="false"><use href="#i-${name}"/></svg>`;
}

// ============================================================
// CONSTANTS
// ============================================================
export const STATS = ['health', 'melee', 'grenade', 'super', 'class', 'weapons'];
export const STAT_LABELS_BY_LANGUAGE = {
  'zh-chs': { health:'生命值', melee:'近战', grenade:'手雷', super:'超能', class:'职业', weapons:'武器' },
  'zh-cht': { health:'生命值', melee:'近戰', grenade:'手榴彈', super:'超能力', class:'職業', weapons:'武器' },
  en: { health:'Health', melee:'Melee', grenade:'Grenade', super:'Super', class:'Class', weapons:'Weapons' },
};
export let STAT_LABELS = STAT_LABELS_BY_LANGUAGE['zh-chs'];

export function setStatLabels(language) {
  STAT_LABELS = STAT_LABELS_BY_LANGUAGE[language] || STAT_LABELS_BY_LANGUAGE['zh-chs'];
  return STAT_LABELS;
}
export const STAT_COLORS = { health:'#ff6b6b', melee:'#5dbaf5', grenade:'#5dfc9e', super:'#ffe566', class:'#c97df5', weapons:'#ff9f5b' };
// Default targets sum to 500 — exactly the budget of 450 base + 5×(+10) mods,
// so the very first click on Solve produces an exact loadout instead of an error.
export const DEFAULT_TARGETS = { health:0, melee:100, grenade:100, super:100, class:100, weapons:100 };
// Only the top solutions are worth showing; the list is already sorted by
// farmability, and nobody picks #400. The rest stay behind "show more".
export const SOLUTION_PREVIEW_COUNT = 10;
export const PAGE_LANGUAGE_STORAGE_KEY = 'd2_armor_page_language_v1';
export const EXOTIC_LANGUAGE_STORAGE_KEY = 'd2_armor_exotic_language_v1';
export const ARCHETYPE_LABELS = {
  Siegebreaker: { 'zh-chs':'突围者', 'zh-cht':'破圍者', en:'Siegebreaker' },
  Bulwark: { 'zh-chs':'堡垒', 'zh-cht':'堡壘', en:'Bulwark' },
  Brawler: { 'zh-chs':'搏击手', 'zh-cht':'赤拳互鬥', en:'Brawler' },
  Skirmisher: { 'zh-chs':'突击手', 'zh-cht':'衝突者', en:'Skirmisher' },
  Grenadier: { 'zh-chs':'掷雷手', 'zh-cht':'榴彈兵', en:'Grenadier' },
  Demolitionist: { 'zh-chs':'爆破专家', 'zh-cht':'爆破專家', en:'Demolitionist' },
  Colossus: { 'zh-chs':'装甲兵', 'zh-cht':'巨神兵', en:'Colossus' },
  Paragon: { 'zh-chs':'楷模典范', 'zh-cht':'至高典範', en:'Paragon' },
  Reaver: { 'zh-chs':'掠夺者', 'zh-cht':'剝奪者', en:'Reaver' },
  Specialist: { 'zh-chs':'专家', 'zh-cht':'戰術家', en:'Specialist' },
  Gunner: { 'zh-chs':'枪手', 'zh-cht':'槍手', en:'Gunner' },
  Powerhouse: { 'zh-chs':'高能者', 'zh-cht':'發電站', en:'Powerhouse' },
};
export const EXOTIC_ARCHETYPE_LABELS = ARCHETYPE_LABELS;
export const UI_TEXT = {
  'zh-chs': {
    documentTitle:'命运2 T5配装求解器',
    pageHeading:'命运2 <span>T5</span> 配装求解器',
    pageSubtitle:'设置目标属性 → 计算 5 件护甲的最佳组合 · 12 种护甲框架 · 自动分配调整',
    pageLanguageLabel:'网页语言',
    skipToTargets:'跳到目标输入',
    freeNotice:'本程序完全免费',
    fraudNotice:'如果你是付费购买的，说明你被骗了！',
    introSummary:'程序介绍',
    introContent:'<p>本程序用于命运2护甲3.0版的T5配装求解。输入目标六维属性、模组和碎片后，程序会枚举五件护甲的实际组合，并结合已有护甲判断还需刷取什么。</p><p>异域职业物品模式会根据职业及左右栏特性锁定30/25/20护甲框架，再计算异域职业物品与四件传说护甲的真实可达范围。调整模组、护甲模组和第三属性均参与逐件计算。</p><p>基础参数：每件T5护甲为主要属性30、次要属性25、第三属性20，其余三项大师杰作各5，共90点；五件共450点。调整模组可选+5/-5或+3；每件可装备一个+5或+10护甲模组；单项属性范围为0–200。</p><p>12种护甲框架：突围者、堡垒、搏击手、突击手、掷雷手、爆破专家、装甲兵、楷模典范、掠夺者、专家、枪手、高能者。</p>',
    calculatorModeLabel:'计算模式', standardModeButton:'从零求解', upgradeModeButton:'优化现有配装',
    upgradeBuildHeading:'优化现有配装',
    upgradeBuildDescription:'设置当前五件护甲，并选择需要保留的固定装备。',
    inventoryImportAriaLabel:'已有护甲',
    upgradeCurrentHeading:'当前五件护甲',
    upgradeCurrentDescription:'异域和不想替换的护甲请勾选“固定”。',
    upgradeReassignModifiers:'计算时自动重排调整和属性模组',
    upgradeTargetHint:'这里填最低目标。勾选“必须达标”后，该属性会优先满足；其余方案再按总缺口从小到大排列。高于目标仍视为达标。',
    upgradeRequiredStat:'必须达标',
    upgradeRequiredStatShort:'必达',
    upgradeAnalyzeButton:'规划替换顺序', upgradeResultsHeading:'护甲替换建议',
    fragmentsHeading:'碎片属性变化',
    targetsHeading:'目标六维属性', resetTargetsButton:'恢复默认值',
    exoticModeLabel:'启用<strong style="color:var(--accent);">异域职业物品模式</strong>',
    exoticModeDescription:'锁定异域职业物品的主要/次要/第三属性框架，再用其余四件传说护甲计算最优解与六维理论极限。调整由求解器自动分配，无需手动指定。',
    exoticModeDetail:'选择职业及左右栏特性后，程序自动锁定对应的30/25/20固定框架；右栏特性与主要/次要属性冲突时按游戏候补顺序取剩余属性。',
    classLabel:'职业', primaryPerkLabel:'主特性（左栏，决定主要/次要属性）', secondaryPerkLabel:'副特性（右栏，决定第三属性）',
    plus5ModCount:'+5模组数量', plus10ModCount:'+10模组数量',
    onlyPlus5TuningLabel:'只使用<strong style="color:var(--accent);">+5/-5</strong>调整（不使用+3）',
    onlyPlus5TuningHint:'选中后，求解方案不会分配+3调整。',
    plus3ModeLabel:'启用调整<strong style="color:var(--accent);">+3</strong>模式（免费+3点/件）',
    selectWord:'选择', plus3PiecesSuffix:'件护甲使用+3模式（其余用+5/-5）',
    solveButton:'求解最佳配装', saveBuildButton:'保存当前配装',
    backToSolutionsTitle:'返回方案列表', jumpToDetailsTitle:'跳转到配装详情',
    savedBuildsHeading:'已保存配装 <span style="font-size:11px;color:var(--text-dim);">（点击名称加载，点 × 删除）</span>',
    clearAllButton:'清空全部', calculating:'正在计算最优配装...',
    targetVsActual:'目标 vs 实际', backToSolutionsButton:'返回方案列表',
    refineHeading:'优先属性与约束调整', refineDescription:'选择优化目标后点击下方按钮重新求解。约束条件对求解器施加硬性限制。',
    refineButton:'重新优化', recommendedBuildHeading:'方案详情',
    exoticRecommendationHeading:'异域护甲推荐',
    exoticRecommendationDescription:'普通模式按方案推荐异域护甲框架；异域职业物品模式严格使用你锁定的属性框架。',
    footerContent:'<div class="footer-title">命运2 T5配装求解器·优化版 Ver 2.0.2</div><div class="footer-credit"><span class="footer-role">优化版作者</span><span>MIGO-OvO</span><span>B站 UID: 23930138</span><a href="https://github.com/MIGO-OvO" target="_blank" rel="noopener noreferrer">GitHub主页</a><a href="https://space.bilibili.com/23930138?spm_id_from=333.1007.0.0" target="_blank" rel="noopener noreferrer">B站主页</a></div><div class="footer-credit"><span class="footer-role">原版作者</span><span>B站 UID: 57597346</span><span>QQ群: 1050912445</span><a href="https://space.bilibili.com/57597346" target="_blank" rel="noopener noreferrer">作者B站主页</a></div>',
    lock:'锁定', none:'不设置', viewLightgg:'查看 light.gg',
    exoticClassItem:'异域职业物品', legendaryArmor:'传说护甲', exoticArmor:'异域护甲', armor:'护甲',
    armorArchetype:'护甲框架', fragments:'碎片', perk:'特性', tuning:'调整', tuningMod:'调整模组', armorMod:'护甲模组',
    primaryStat:'主要属性', secondaryStat:'次要属性', tertiaryStat:'第三属性', masterwork:'大师杰作',
  },
  'zh-cht': {
    documentTitle:'天命2 T5配裝求解器',
    pageHeading:'天命2 <span>T5</span> 配裝求解器',
    pageSubtitle:'設定目標數值 → 計算 5 件防具的最佳組合 · 12 種防具原型 · 自動分配調整',
    pageLanguageLabel:'網頁語言',
    skipToTargets:'跳至目標輸入',
    freeNotice:'本程式完全免費',
    fraudNotice:'如果你是付費購買的，代表你受騙了！',
    introSummary:'程式介紹',
    introContent:'<p>本程式用於天命2防具3.0版的T5配裝求解。輸入目標六維數值、模組和碎片後，程式會列舉五件防具的實際組合，並結合已有防具判斷還需取得什麼。</p><p>異域職業物品模式會根據職業及左右欄特長鎖定30/25/20防具原型，再計算異域職業物品與四件傳說防具的真實可達範圍。調整模組、防具模組和第三數值均參與逐件計算。</p><p>基礎參數：每件T5防具為主要數值30、次要數值25、第三數值20，其餘三項傑作各5，共90點；五件共450點。調整模組可選+5/-5或+3；每件可裝備一個+5或+10防具模組；單項數值範圍為0–200。</p><p>12種防具原型：破圍者、堡壘、赤拳互鬥、衝突者、榴彈兵、爆破專家、巨神兵、至高典範、剝奪者、戰術家、槍手、發電站。</p>',
    calculatorModeLabel:'計算模式', standardModeButton:'從零求解', upgradeModeButton:'最佳化現有配裝',
    upgradeBuildHeading:'最佳化現有配裝',
    upgradeBuildDescription:'設定目前五件防具，並選擇需要保留的固定裝備。',
    inventoryImportAriaLabel:'已有防具',
    upgradeCurrentHeading:'目前五件防具',
    upgradeCurrentDescription:'異域和不想替換的防具請勾選「固定」。',
    upgradeReassignModifiers:'計算時自動重排調整和數值模組',
    upgradeTargetHint:'這裡填最低目標。勾選「必須達標」後，該數值會優先滿足；其餘方案再依總缺口由小到大排列。高於目標仍視為達標。',
    upgradeRequiredStat:'必須達標',
    upgradeRequiredStatShort:'必達',
    upgradeAnalyzeButton:'規劃替換順序', upgradeResultsHeading:'防具替換建議',
    fragmentsHeading:'碎片數值變化',
    targetsHeading:'目標六維數值', resetTargetsButton:'恢復預設值',
    exoticModeLabel:'啟用<strong style="color:var(--accent);">異域職業物品模式</strong>',
    exoticModeDescription:'鎖定異域職業物品的主要/次要/第三數值原型，再用其餘四件傳說防具計算最佳解與六維理論極限。調整由求解器自動分配，無需手動指定。',
    exoticModeDetail:'選擇職業及左右欄特長後，程式自動鎖定對應的30/25/20固定原型；右欄特長與主要/次要數值衝突時，依遊戲候補順序取剩餘數值。',
    classLabel:'職業', primaryPerkLabel:'主要特長（左欄，決定主要/次要數值）', secondaryPerkLabel:'次要特長（右欄，決定第三數值）',
    plus5ModCount:'+5模組數量', plus10ModCount:'+10模組數量',
    onlyPlus5TuningLabel:'只使用<strong style="color:var(--accent);">+5/-5</strong>調整（不使用+3）',
    onlyPlus5TuningHint:'選取後，求解方案不會分配+3調整。',
    plus3ModeLabel:'啟用調整<strong style="color:var(--accent);">+3</strong>模式（免費+3點/件）',
    selectWord:'選擇', plus3PiecesSuffix:'件防具使用+3模式（其餘用+5/-5）',
    solveButton:'求解最佳配裝', saveBuildButton:'儲存目前配裝',
    backToSolutionsTitle:'返回方案列表', jumpToDetailsTitle:'跳至配裝詳情',
    savedBuildsHeading:'已儲存配裝 <span style="font-size:11px;color:var(--text-dim);">（點擊名稱載入，點 × 刪除）</span>',
    clearAllButton:'全部清除', calculating:'正在計算最佳配裝...',
    targetVsActual:'目標 vs 實際', backToSolutionsButton:'返回方案列表',
    refineHeading:'優先數值與限制調整', refineDescription:'選擇最佳化目標後，點擊下方按鈕重新求解。限制條件會對求解器施加硬性限制。',
    refineButton:'重新最佳化', recommendedBuildHeading:'方案詳情',
    exoticRecommendationHeading:'異域防具推薦',
    exoticRecommendationDescription:'一般模式依方案推薦異域防具原型；異域職業物品模式嚴格使用你鎖定的數值原型。',
    footerContent:'<div class="footer-title">天命2 T5配裝求解器·優化版 Ver 2.0.2</div><div class="footer-credit"><span class="footer-role">優化版作者</span><span>MIGO-OvO</span><span>Bilibili UID: 23930138</span><a href="https://github.com/MIGO-OvO" target="_blank" rel="noopener noreferrer">GitHub 主頁</a><a href="https://space.bilibili.com/23930138?spm_id_from=333.1007.0.0" target="_blank" rel="noopener noreferrer">Bilibili 主頁</a></div><div class="footer-credit"><span class="footer-role">原版作者</span><span>Bilibili UID: 57597346</span><span>QQ群: 1050912445</span><a href="https://space.bilibili.com/57597346" target="_blank" rel="noopener noreferrer">作者 Bilibili 主頁</a></div>',
    lock:'鎖定', none:'不設定', viewLightgg:'查看 light.gg',
    exoticClassItem:'異域職業物品', legendaryArmor:'傳說防具', exoticArmor:'異域防具', armor:'防具',
    armorArchetype:'防具原型', fragments:'碎片', perk:'特長', tuning:'調整', tuningMod:'調整模組', armorMod:'防具模組',
    primaryStat:'主要數值', secondaryStat:'次要數值', tertiaryStat:'第三數值', masterwork:'傑作',
  },
  en: {
    documentTitle:'Destiny 2 T5 Armor Solver',
    pageHeading:'Destiny 2 <span>T5</span> Armor Solver',
    pageSubtitle:'Set targets → calculate the best five-piece loadout · 12 armor archetypes · automatic tuning',
    pageLanguageLabel:'Page language',
    skipToTargets:'Skip to target inputs',
    freeNotice:'This tool is completely free',
    fraudNotice:'If you paid for it, you were scammed.',
    introSummary:'About this tool',
    introContent:'<p>This tool solves Destiny 2 Armor 3.0 T5 loadouts. Enter six target stats, mods, and Fragment changes; it enumerates real five-piece armor combinations and uses your owned armor to show what remains to farm.</p><p>Exotic Class Item mode locks its 30/25/20 armor archetype from the selected class and left/right-column perks, then calculates the true reachable range across that item and four Legendary Armor pieces. Tuning Mods, Armor Mods, and tertiary stats are evaluated per piece.</p><p>Base rules: each T5 piece has 30 primary, 25 secondary, 20 tertiary, and 5 Masterwork points in each remaining stat, for 90 total; five pieces provide 450. A Tuning Mod is either +5/-5 or +3; each piece takes one +5 or +10 Armor Mod; each stat ranges from 0–200.</p><p>12 armor archetypes: Siegebreaker, Bulwark, Brawler, Skirmisher, Grenadier, Demolitionist, Colossus, Paragon, Reaver, Specialist, Gunner, and Powerhouse.</p>',
    calculatorModeLabel:'Calculator mode', standardModeButton:'Build from Scratch', upgradeModeButton:'Optimize Current Loadout',
    upgradeBuildHeading:'Optimize Current Loadout',
    upgradeBuildDescription:'Set the current five armor pieces and choose what should stay fixed.',
    inventoryImportAriaLabel:'Owned armor',
    upgradeCurrentHeading:'Current Five Armor Pieces',
    upgradeCurrentDescription:'Mark Exotics and anything you want to keep as fixed.',
    upgradeReassignModifiers:'Rearrange Tuning and stat mods while calculating',
    upgradeTargetHint:'Enter a minimum for each stat. Mark “Must meet” to satisfy that stat first; remaining loadouts are ranked by total shortfall. Going over still counts as met.',
    upgradeRequiredStat:'Must meet',
    upgradeRequiredStatShort:'Required',
    upgradeAnalyzeButton:'Plan Replacement Order', upgradeResultsHeading:'Armor Replacement Advice',
    fragmentsHeading:'Fragment Stat Changes',
    targetsHeading:'Target Stats', resetTargetsButton:'Reset defaults',
    exoticModeLabel:'Enable <strong style="color:var(--accent);">Exotic Class Item mode</strong>',
    exoticModeDescription:'Lock the Exotic Class Item primary, secondary, and tertiary stat archetype, then solve the other four Legendary Armor pieces for the best result and six-stat limits. Tuning is assigned automatically.',
    exoticModeDetail:'Select a class and left/right-column perks to lock the matching 30/25/20 archetype. If the right perk conflicts with a primary or secondary stat, the next eligible stat in the game order is used.',
    classLabel:'Class', primaryPerkLabel:'Primary perk (left column; sets primary/secondary stats)', secondaryPerkLabel:'Secondary perk (right column; sets tertiary stat)',
    plus5ModCount:'+5 Mod count', plus10ModCount:'+10 Mod count',
    onlyPlus5TuningLabel:'Use <strong style="color:var(--accent);">+5/-5</strong> Tuning only (no +3)',
    onlyPlus5TuningHint:'When enabled, solved loadouts will never assign +3 Tuning.',
    plus3ModeLabel:'Enable <strong style="color:var(--accent);">+3</strong> Tuning Mod mode (free +3 per piece)',
    selectWord:'Use', plus3PiecesSuffix:'armor pieces in +3 mode (the rest use +5/-5)',
    solveButton:'Solve Best Loadout', saveBuildButton:'Save Current Loadout',
    backToSolutionsTitle:'Back to solution list', jumpToDetailsTitle:'Jump to loadout details',
    savedBuildsHeading:'Saved Loadouts <span style="font-size:11px;color:var(--text-dim);">(click a name to load, × to delete)</span>',
    clearAllButton:'Clear All', calculating:'Calculating the best loadout...',
    targetVsActual:'Target vs Actual', backToSolutionsButton:'Back to Solutions',
    refineHeading:'Priority Stats and Constraints', refineDescription:'Choose optimization goals, then solve again. Constraints are hard limits.',
    refineButton:'Optimize Again', recommendedBuildHeading:'Solution details',
    exoticRecommendationHeading:'Exotic Armor Recommendation',
    exoticRecommendationDescription:'Standard mode recommends an Exotic Armor archetype; Exotic Class Item mode strictly uses the locked stat archetype.',
    footerContent:'<div class="footer-title">Destiny 2 T5 Armor Solver · Optimized Edition Ver 2.0.2</div><div class="footer-credit"><span class="footer-role">Optimized edition author</span><span>MIGO-OvO</span><span>Bilibili UID: 23930138</span><a href="https://github.com/MIGO-OvO" target="_blank" rel="noopener noreferrer">GitHub profile</a><a href="https://space.bilibili.com/23930138?spm_id_from=333.1007.0.0" target="_blank" rel="noopener noreferrer">Bilibili profile</a></div><div class="footer-credit"><span class="footer-role">Original author</span><span>Bilibili UID: 57597346</span><span>QQ group: 1050912445</span><a href="https://space.bilibili.com/57597346" target="_blank" rel="noopener noreferrer">Bilibili profile</a></div>',
    lock:'Lock', none:'None', viewLightgg:'View on light.gg',
    exoticClassItem:'Exotic Class Item', legendaryArmor:'Legendary Armor', exoticArmor:'Exotic Armor', armor:'Armor',
    armorArchetype:'Armor Archetype', fragments:'Fragments', perk:'Perk', tuning:'Tuning', tuningMod:'Tuning Mod', armorMod:'Armor Mod',
    primaryStat:'Primary Stat', secondaryStat:'Secondary Stat', tertiaryStat:'Tertiary Stat', masterwork:'Masterwork',
  },
};

export function getPageLanguage() {
  const value = document.getElementById('pageLanguage')?.value;
  return value === 'zh-cht' || value === 'en' ? value : 'zh-chs';
}

export function t(key, vars = {}) {
  const language = getPageLanguage();
  let value = UI_TEXT[language]?.[key] ?? UI_TEXT['zh-chs'][key] ?? key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = String(value).replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function l(chs, cht, en) {
  return getPageLanguage() === 'en' ? en : getPageLanguage() === 'zh-cht' ? cht : chs;
}

export function localeCode() {
  return { 'zh-chs':'zh-CN', 'zh-cht':'zh-TW', en:'en-US' }[getPageLanguage()];
}

export function joinLocalized(items, conjunction = false) {
  if (getPageLanguage() !== 'en') return items.join('、');
  if (!conjunction || items.length < 2) return items.join(', ');
  if (items.length === 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function applyStaticTranslations() {
  document.documentElement.lang = { 'zh-chs':'zh-CN', 'zh-cht':'zh-Hant', en:'en' }[getPageLanguage()];
  document.title = t('documentTitle');
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(element => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(element => {
    element.title = t(element.dataset.i18nTitle);
  });
  // Icon-only buttons carry their whole meaning in aria-label, so it has to
  // follow the language too.
  document.querySelectorAll('[data-i18n-aria]').forEach(element => {
    element.setAttribute('aria-label', t(element.dataset.i18nAria));
  });
}
export const EXOTIC_PERK_NAMES = {
  assassin: { hash:1476923952, 'zh-chs':'刺客之灵', 'zh-cht':'刺客之魂', en:'Spirit of the Assassin' },
  inmost: { hash:1476923953, 'zh-chs':'至纯光能之灵', 'zh-cht':'深光之魂', en:'Spirit of Inmost Light' },
  ophidian: { hash:1476923954, 'zh-chs':'毒蛇之灵', 'zh-cht':'蛇族之魂', en:'Spirit of the Ophidian' },
  'star-eater': { hash:1476923955, 'zh-chs':'噬星者之灵', 'zh-cht':'嗜星者之魂', en:'Spirit of the Star-Eater' },
  synthoceps: { hash:1476923956, 'zh-chs':'合成感受器之灵', 'zh-cht':'合成臂鎧之魂', en:'Spirit of Synthoceps' },
  verity: { hash:1476923957, 'zh-chs':'真理之灵', 'zh-cht':'真相之魂', en:'Spirit of Verity' },
  coyote: { hash:3751917990, 'zh-chs':'郊狼之灵', 'zh-cht':'土狼之魂', en:'Spirit of the Coyote' },
  wormhusk: { hash:3751917991, 'zh-chs':'虫骸之灵', 'zh-cht':'蟲殼之魂', en:'Spirit of the Wormhusk' },
  liar: { hash:3751917992, 'zh-chs':'骗徒之灵', 'zh-cht':'騙徒之魂', en:'Spirit of the Liar' },
  gyrfalcon: { hash:3751917993, 'zh-chs':'矛隼之灵', 'zh-cht':'矛隼之魂', en:'Spirit of the Gyrfalcon' },
  cyrtarachne: { hash:3751917994, 'zh-chs':'曲腹蛛之灵', 'zh-cht':'曲腹蛛之魂', en:'Spirit of the Cyrtarachne' },
  renewal: { hash:3751917995, 'zh-chs':'复兴之灵', 'zh-cht':'革新之魂', en:'Spirit of Renewal' },
  caliban: { hash:3751917996, 'zh-chs':'卡利班之灵', 'zh-cht':'卡利班之魂', en:'Spirit of Caliban' },
  foetracer: { hash:3751917997, 'zh-chs':'觅敌者之灵', 'zh-cht':'追敵者之魂', en:'Spirit of the Foetracer' },
  galanor: { hash:3751917998, 'zh-chs':'加拉诺之灵', 'zh-cht':'加拉諾之魂', en:'Spirit of Galanor' },
  dragon: { hash:3751917999, 'zh-chs':'巨龙之灵', 'zh-cht':'龍之魂', en:'Spirit of the Dragon' },
  swarm: { hash:183430246, 'zh-chs':'虫群之灵', 'zh-cht':'蟲群之魂', en:'Spirit of the Swarm' },
  claw: { hash:183430247, 'zh-chs':'利爪之灵', 'zh-cht':'利爪之魂', en:'Spirit of the Claw' },
  stag: { hash:183430248, 'zh-chs':'雄鹿之灵', 'zh-cht':'雄鹿之魂', en:'Spirit of the Stag' },
  starfire: { hash:183430249, 'zh-chs':'星火之灵', 'zh-cht':'星火之魂', en:'Spirit of Starfire' },
  apotheosis: { hash:183430250, 'zh-chs':'神化之灵', 'zh-cht':'神化之魂', en:'Spirit of Apotheosis' },
  vesper: { hash:183430251, 'zh-chs':'晚星之灵', 'zh-cht':'昏星之魂', en:'Spirit of Vesper' },
  necrotic: { hash:183430252, 'zh-chs':'坏死之灵', 'zh-cht':'壞死之魂', en:'Spirit of the Necrotic' },
  osmiomancy: { hash:183430253, 'zh-chs':'锇素之灵', 'zh-cht':'鋨術之魂', en:'Spirit of Osmiomancy' },
  harmony: { hash:183430254, 'zh-chs':'和谐之灵', 'zh-cht':'和諧之魂', en:'Spirit of Harmony' },
  filaments: { hash:183430255, 'zh-chs':'纤维之灵', 'zh-cht':'長絲之魂', en:'Spirit of the Filaments' },
  armamentarium: { hash:3573490500, 'zh-chs':'医疗设备之灵', 'zh-cht':'治療設備之魂', en:'Spirit of the Armamentarium' },
  'alpha-lupi': { hash:3573490501, 'zh-chs':'阿尔法·鲁皮之灵', 'zh-cht':'狼族首領之魂', en:'Spirit of Alpha Lupi' },
  contact: { hash:3573490504, 'zh-chs':'接触之灵', 'zh-cht':'流電之魂', en:'Spirit of Contact' },
  bear: { hash:3573490505, 'zh-chs':'承负之灵', 'zh-cht':'熊之魂', en:'Spirit of the Bear' },
  horn: { hash:3573490506, 'zh-chs':'号角之灵', 'zh-cht':'角之魂', en:'Spirit of the Horn' },
  scars: { hash:3573490507, 'zh-chs':'伤痕之灵', 'zh-cht':'傷疤之魂', en:'Spirit of Scars' },
  hoarfrost: { hash:3573490508, 'zh-chs':'白霜之灵', 'zh-cht':'白霜之魂', en:'Spirit of Hoarfrost' },
  severance: { hash:3573490509, 'zh-chs':'断舍之灵', 'zh-cht':'切割之魂', en:'Spirit of Severance' },
  abeyant: { hash:3573490510, 'zh-chs':'中止之灵', 'zh-cht':'暫擱之魂', en:'Spirit of the Abeyant' },
  'eternal-warrior': { hash:3573490511, 'zh-chs':'永恒战士之灵', 'zh-cht':'永恆戰士之魂', en:'Spirit of the Eternal Warrior' },
};
export const EXOTIC_CLASS_LABELS = {
  hunter: { 'zh-chs':'猎人 · 相对主义', 'zh-cht':'獵人 · 相對主義', en:'Hunter · Relativism' },
  warlock: { 'zh-chs':'术士 · 唯我主义', 'zh-cht':'術士 · 唯我論', en:'Warlock · Solipsism' },
  titan: { 'zh-chs':'泰坦 · 坚忍克己', 'zh-cht':'泰坦 · 斯多葛主義', en:'Titan · Stoicism' },
};

export function getExoticLanguage() {
  return getPageLanguage();
}

export function getExoticPerkName(id, fallback) {
  const metadata = EXOTIC_PERK_NAMES[id];
  return metadata?.[getExoticLanguage()] || fallback;
}

export function getExoticArchetypeLabel(archetype) {
  return EXOTIC_ARCHETYPE_LABELS[archetype]?.[getExoticLanguage()] || archetype;
}

export const ARCHETYPES = [
  { id:'Siegebreaker', hash:2503381935, name:'突围者', primary:'health', secondary:'grenade' },
  { id:'Bulwark', hash:549468645, name:'壁垒', primary:'health', secondary:'class' },
  { id:'Brawler', hash:3349393475, name:'搏击手', primary:'melee', secondary:'health' },
  { id:'Skirmisher', hash:1687144140, name:'突击手', primary:'melee', secondary:'weapons' },
  { id:'Grenadier', hash:2937665788, name:'掷雷手', primary:'grenade', secondary:'super' },
  { id:'Demolitionist', hash:2222960133, name:'爆破专家', primary:'grenade', secondary:'class' },
  { id:'Colossus', hash:1418248448, name:'装甲兵', primary:'super', secondary:'health' },
  { id:'Paragon', hash:4227065942, name:'楷模典范', primary:'super', secondary:'melee' },
  { id:'Reaver', hash:351770835, name:'掠夺者', primary:'class', secondary:'melee' },
  { id:'Specialist', hash:2230428468, name:'专家', primary:'class', secondary:'weapons' },
  { id:'Gunner', hash:1807652646, name:'枪手', primary:'weapons', secondary:'grenade' },
  { id:'Powerhouse', hash:544009373, name:'高能者', primary:'weapons', secondary:'super' },
];

export function getArchetypeLabel(nameOrId) {
  const archetype = ARCHETYPES.find(item => item.id === nameOrId || item.name === nameOrId);
  return archetype ? ARCHETYPE_LABELS[archetype.id][getPageLanguage()] : getExoticArchetypeLabel(nameOrId);
}

// Exotic class-item data (current Armor 3.0 rules).
// The left-column perk fixes the archetype; the right-column perk supplies
// the tertiary stat, falling back to the next stat when the archetype already
// contains the preferred one.
export const EXOTIC_CLASSES = {
  hunter: {
    label: '猎人 · Relativism', itemHash: 2809120022,
    primary: [
      ['assassin','Spirit of the Assassin','melee','health','Brawler'],
      ['inmost','Spirit of Inmost Light','super','melee','Paragon'],
      ['caliban','Spirit of Caliban','melee','health','Brawler'],
      ['galanor','Spirit of Galanor','super','melee','Paragon'],
      ['foetracer','Spirit of the Foetracer','weapons','grenade','Gunner'],
      ['renewal','Spirit of Renewal','grenade','super','Grenadier'],
      ['dragon','Spirit of the Dragon','class','weapons','Specialist'],
      ['ophidian','Spirit of the Ophidian','weapons','grenade','Gunner'],
    ],
    secondary: [
      ['cyrtarachne','Spirit of the Cyrtarachne',['grenade','health']],
      ['gyrfalcon','Spirit of the Gyrfalcon',['weapons','melee']],
      ['liar','Spirit of the Liar',['melee','health','class']],
      ['star-eater','Spirit of the Star-Eater',['super','weapons']],
      ['synthoceps','Spirit of Synthoceps',['melee','health','class']],
      ['verity','Spirit of Verity',['grenade','super','melee']],
      ['wormhusk','Spirit of the Wormhusk',['class','melee']],
      ['coyote','Spirit of the Coyote',['class','melee']],
    ],
  },
  warlock: {
    label: '术士 · Solipsism', itemHash: 2273643087,
    primary: [
      ['assassin','Spirit of the Assassin','melee','health','Brawler'],
      ['inmost','Spirit of Inmost Light','super','melee','Paragon'],
      ['ophidian','Spirit of the Ophidian','weapons','grenade','Gunner'],
      ['apotheosis','Spirit of Apotheosis','super','melee','Paragon'],
      ['osmiomancy','Spirit of Osmiomancy','grenade','super','Grenadier'],
      ['stag','Spirit of the Stag','health','class','Bulwark'],
      ['filaments','Spirit of the Filaments','class','weapons','Specialist'],
      ['necrotic','Spirit of the Necrotic','melee','health','Brawler'],
    ],
    secondary: [
      ['claw','Spirit of the Claw',['melee','health','class']],
      ['starfire','Spirit of Starfire',['grenade','weapons','health']],
      ['swarm','Spirit of the Swarm',['grenade','weapons','health']],
      ['synthoceps','Spirit of Synthoceps',['melee','health','class']],
      ['star-eater','Spirit of the Star-Eater',['super','weapons']],
      ['verity','Spirit of Verity',['grenade','super','melee']],
      ['harmony','Spirit of Harmony',['super','weapons']],
      ['vesper','Spirit of Vesper',['class','health','weapons']],
    ],
  },
  titan: {
    label: '泰坦 · Stoicism', itemHash: 266021826,
    primary: [
      ['assassin','Spirit of the Assassin','melee','health','Brawler'],
      ['inmost','Spirit of Inmost Light','super','melee','Paragon'],
      ['ophidian','Spirit of the Ophidian','weapons','grenade','Gunner'],
      ['hoarfrost','Spirit of Hoarfrost','class','weapons','Specialist'],
      ['severance','Spirit of Severance','melee','health','Brawler'],
      ['abeyant','Spirit of the Abeyant','class','weapons','Specialist'],
      ['bear','Spirit of the Bear','grenade','super','Grenadier'],
      ['eternal-warrior','Spirit of the Eternal Warrior','super','melee','Paragon'],
    ],
    secondary: [
      ['armamentarium','Spirit of the Armamentarium',['grenade','weapons','health']],
      ['alpha-lupi','Spirit of Alpha Lupi',['class','health','weapons']],
      ['contact','Spirit of Contact',['melee','health','grenade']],
      ['horn','Spirit of the Horn',['class','grenade','health']],
      ['scars','Spirit of Scars',['health','weapons']],
      ['star-eater','Spirit of the Star-Eater',['super','weapons']],
      ['synthoceps','Spirit of Synthoceps',['melee','health','class']],
      ['verity','Spirit of Verity',['grenade','super','melee']],
    ],
  },
};

export function resolveExoticTertiary(primary, secondary) {
  const occupied = new Set([primary.primary, primary.secondary]);
  return secondary.order.find(candidate => !occupied.has(candidate)) ||
    STATS.find(candidate => !occupied.has(candidate)) || 'health';
}

export function createExoticConfig(primary, secondary) {
  const tertiary = resolveExoticTertiary(primary, secondary);
  const stats = Object.fromEntries(STATS.map(stat => [stat, 5]));
  stats[primary.primary] = 30;
  stats[primary.secondary] = 25;
  stats[tertiary] = 20;
  return {
    archetype: primary.archetype,
    primary: primary.primary,
    secondary: primary.secondary,
    tertiary,
    baseStats: stats,
    masterworkStats: STATS.filter(
      stat => stat !== primary.primary &&
        stat !== primary.secondary &&
        stat !== tertiary
    ),
  };
}

// ============================================================
// PRECOMPUTE BASE CONFIGS (archetype + tertiary, NO tuning)
// Tuning is assigned deterministically during evaluation
// ============================================================
export const BASE_CONFIGS = [];

(function precompute() {
  for (const arch of ARCHETYPES) {
    const availTert = STATS.filter(s => s !== arch.primary && s !== arch.secondary);
    for (const tertiary of availTert) {
      const stats = {};
      for (const s of STATS) stats[s] = 0;
      stats[arch.primary] = 30;
      stats[arch.secondary] = 25;
      stats[tertiary] = 20;
      const mwSet = new Set([arch.primary, arch.secondary, tertiary]);
      for (const s of STATS) {
        if (!mwSet.has(s)) stats[s] = 5;
      }
      BASE_CONFIGS.push({
        archetype: arch.name,
        primary: arch.primary,
        secondary: arch.secondary,
        tertiary: tertiary,
        baseStats: stats,
        masterworkStats: STATS.filter(stat => !mwSet.has(stat)),
      });
    }
  }
})();
// 12 archetypes × 4 tertiary = 48 base configs
