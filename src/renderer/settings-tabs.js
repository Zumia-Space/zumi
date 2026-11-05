// T-31 settings P1: the six Settings tabs. One tab bar (role=tablist) sits above one .settings scroll box; each tab
// shows its .stabpanel and hides the rest. Standard tablist behaviour: click or Arrow/Home/End to move (automatic
// activation), with a roving tabindex so Tab lands on the selected tab, and the selection is remembered across
// restarts (localStorage -- a pure UI preference, not a settings.json value). This is separate from the sidebar
// tabs (which use .tab/.panel and are wired in app.js); the inner tabs reuse neither class nor attribute name.
const KEY = 'zumi.settingsTab';

export function initSettingsTabs() {
  const root = document.getElementById('tab-settings');
  const bar = root && root.querySelector('.stabbar');
  if (!bar) return;
  const tabs = [...bar.querySelectorAll('[role="tab"]:not([hidden])')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
  const scroll = root.querySelector('.settings');
  if (tabs.length < 2 || panels.some((p) => !p)) return; // a half-built bar must never throw at boot

  const read = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const save = (id) => { try { localStorage.setItem(KEY, id); } catch { /* storage disabled: just do not remember */ } };

  let at = tabs.findIndex((tab) => tab.id === read());
  if (at < 0) at = 0;

  function show(i) {
    at = i;
    tabs.forEach((tab, k) => {
      const on = k === i;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1; // roving tabindex: only the selected tab is in the tab order
      panels[k].hidden = !on;
    });
    if (scroll) scroll.scrollTop = 0; // each tab opens at its top
    save(tabs[i].id);
  }

  function move(to) {
    const n = tabs.length;
    show(((to % n) + n) % n);
    tabs[at].focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => show(i));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight') { ev.preventDefault(); move(at + 1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(at - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); move(0); }
      else if (ev.key === 'End') { ev.preventDefault(); move(tabs.length - 1); }
    });
  });

  show(at); // open on the remembered tab (or the first one)
}
