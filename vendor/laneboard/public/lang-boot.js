// Runs before the page paints (a plain, non-deferred script in <head>): the UI language this browser picked — else
// English, the board's default — goes on <html lang> at once, and its dictionary starts downloading before app.js
// runs, so the first paint is already in the right language. Client side only: nothing is sent to the server.
// Embedded in the Zumi desktop app (?embed=1): the host's own chrome replaces the board's, and ?lang= lets the host
// pick the language. app.js reads the `embed` class to skip rendering that chrome.
(function () {
  var q = new URLSearchParams(location.search);
  var forced = q.get('lang');
  var lang;
  if (forced === 'en' || forced === 'vi' || forced === 'zh') {
    lang = forced;
    try { localStorage.setItem('laneboard.uiLang', lang); } catch (e) { /* storage refused: still show this language */ }
  } else {
    var pick = '';
    try { pick = localStorage.getItem('laneboard.uiLang') || ''; } catch (e) { /* storage refused: English */ }
    lang = pick === 'vi' || pick === 'zh' || pick === 'en' ? pick : 'en';
  }
  if (q.get('embed') === '1') document.documentElement.classList.add('embed');
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  var get = function (l) { return fetch('locales/' + l + '.json').then(function (r) { return r.json(); }); };
  window.LaneLocale = { lang: lang, en: get('en'), dict: lang === 'en' ? null : get(lang) };
})();
