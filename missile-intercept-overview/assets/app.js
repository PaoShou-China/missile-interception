// Navigation, language switching and page routing.
(function () {
  var body = document.body;
  var LANG_KEY = 'overview:lang';
  var lang = 'zh';
  try { lang = localStorage.getItem(LANG_KEY) || 'zh'; } catch (e) { lang = 'zh'; }
  if (lang !== 'en') lang = 'zh';

  var toggle = document.getElementById('langToggle');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));

  function applyLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    body.classList.toggle('lang-zh', lang === 'zh');
    body.classList.toggle('lang-en', lang === 'en');
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    if (toggle) toggle.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    window.dispatchEvent(new CustomEvent('overview:lang', { detail: lang }));
  }

  function showPage(id, updateHash) {
    if (!document.getElementById(id)) id = 'overview';
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.page === id); });
    pages.forEach(function (p) { p.classList.toggle('active', p.id === id); });
    if (updateHash) {
      try { history.replaceState(null, '', '#' + id); } catch (e) { location.hash = id; }
    }
    window.scrollTo(0, 0);
    window.dispatchEvent(new CustomEvent('overview:page', { detail: id }));
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { showPage(tab.dataset.page, true); });
  });

  if (toggle) {
    toggle.addEventListener('click', function () { applyLang(lang === 'zh' ? 'en' : 'zh'); });
  }

  window.addEventListener('hashchange', function () {
    showPage((location.hash || '#overview').slice(1), false);
  });

  var initial = (location.hash || '#overview').slice(1);
  showPage(initial, false);
  applyLang(lang);
})();
