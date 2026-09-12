import './styles/guide.css';
import { GUIDE_CONTENT } from './guide-content.mjs';

// Shared with the portal and both solver channels, without importing the model.
const storageKey = 'd2_armor_page_language_v1';
const select = document.getElementById('guideLanguage');
const contents = document.getElementById('guideContents');
const mobile = matchMedia('(max-width: 760px)');
function syncContents() { contents.open = !mobile.matches; }
syncContents();
mobile.addEventListener('change', syncContents);

function render(language) {
  const copy = GUIDE_CONTENT[language] || GUIDE_CONTENT['zh-chs'];
  select.value = Object.hasOwn(GUIDE_CONTENT, language) ? language : 'zh-chs';
  document.documentElement.lang = copy.lang;
  document.title = `${copy.title} · Destiny 2 Armor Solver`;
  for (const [id, value] of Object.entries({ guideTitle: copy.title, guideLead: copy.lead,
    backLink: copy.back, contentsLabel: copy.contents, languageLabel: copy.language, skipLink: copy.skip })) {
    document.getElementById(id).textContent = value;
  }
  document.getElementById('guideNav').innerHTML = copy.sections.map(([id, title]) =>
    `<a href="#${id}">${title}</a>`).join('');
  document.getElementById('guideSections').innerHTML = copy.sections.map(([id, title, body]) =>
    `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${body}</section>`).join('');
}
let storedLanguage;
try { storedLanguage = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
render(storedLanguage);
select.addEventListener('change', () => {
  render(select.value);
  try { localStorage.setItem(storageKey, select.value); } catch { /* Reading still works. */ }
});
document.getElementById('guideNav').addEventListener('click', event => {
  if (mobile.matches && event.target.closest('a')) contents.open = false;
});
// Content is inserted synchronously; restore deep links after the sections exist.
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
