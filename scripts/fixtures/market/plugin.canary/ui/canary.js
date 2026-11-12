// plugin.canary: the open test pack of the web-app pack runtime (ADR 2026-11-11-pack-system).
// Every in-scope bridge call must pass; every way out must be refused by the host. The runner reads window.__canary.
(() => {
  const id = location.pathname.split('/')[1];
  const base = `/${id}`;
  const out = document.getElementById('out');
  const results = [];
  const note = (name, pass, detail) => {
    results.push({ name, pass, detail: String(detail || '') });
    const li = document.createElement('li'); li.className = pass ? 'ok' : 'no'; li.textContent = `${pass ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`; out.appendChild(li);
  };
  const bridge = async (method, args = {}, at = base) => {
    const r = await fetch(`${at}/__zumi/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  };
  const refused = (r) => r.status >= 400 && r.body && r.body.ok === false;
  const blocked = async (fn) => { try { const r = await fn(); return { blocked: !r.ok, how: `status ${r.status}` }; } catch (e) { return { blocked: true, how: e.name }; } };
  const stamp = `${Date.now()}`;

  async function inScope() {
    let r = await bridge('host.info');
    note('host.info answers api 1 and this pack id', r.status === 200 && r.body.ok && r.body.result.api === 1 && r.body.result.pack === id, JSON.stringify(r.body));
    r = await bridge('storage.write', { path: 'notes/a.txt', text: stamp });
    note('storage.write in its own folder', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await bridge('storage.append', { path: 'notes/a.txt', text: '+1' });
    note('storage.append', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await bridge('storage.read', { path: 'notes/a.txt' });
    note('storage.read returns what was written', r.status === 200 && r.body.ok && r.body.result.text === `${stamp}+1`, JSON.stringify(r.body));
    r = await bridge('storage.stat', { path: 'notes/a.txt' });
    note('storage.stat', r.status === 200 && r.body.ok && r.body.result.bytes === stamp.length + 2, JSON.stringify(r.body));
    r = await bridge('storage.list', { path: 'notes' });
    note('storage.list', r.status === 200 && r.body.ok && r.body.result.entries.some((e) => e.name === 'a.txt'), JSON.stringify(r.body));
    r = await bridge('storage.remove', { path: 'notes/a.txt' });
    note('storage.remove', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    r = await bridge('links.open', { key: 'docs' });
    note('links.open a declared link', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    const own = await fetch(`${base}/ui/icon.svg`);
    note('its own file loads', own.status === 200, `status ${own.status}`);
  }

  async function outOfScope() {
    let r = await bridge('storage.read', { path: '../plugin.other/secret.txt' });
    note('refused: storage path escape', refused(r) && r.body.code === 'path_escape', JSON.stringify(r.body));
    r = await bridge('storage.write', { path: 'C:/Windows/evil.txt', text: 'x' });
    note('refused: storage absolute path', refused(r) && r.body.code === 'path_escape', JSON.stringify(r.body));
    const other = await fetch('/plugin.other/zumi-pack.json');
    note("refused: another pack's files", other.status === 404 || other.status === 403, `status ${other.status}`);
    r = await bridge('host.info', {}, '/plugin.other');
    note("refused: another pack's bridge", r.status === 403 || r.status === 404, `status ${r.status}`);
    r = await bridge('links.open', { key: 'evil' });
    note('refused: an unlisted link', refused(r) && r.body.code === 'link_unlisted', JSON.stringify(r.body));
    let b = await blocked(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => ({ ok: true, status: 0 })));
    note('refused: fetch to an https origin', b.blocked, b.how);
    b = await blocked(() => fetch('http://ipc.localhost/rpc', { method: 'POST', body: '{}' }));
    // Tauri may inject its IPC helper into every webview; what matters is that the host refuses this label every command.
    let invokeRefused = true, how = 'no IPC helper';
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      try { await internals.invoke('rpc', { method: 'settings.get', args: [] }); invokeRefused = false; how = 'answered'; } catch (e) { how = `rejected: ${String(e).slice(0, 80)}`; }
    }
    note('refused: the main rpc', b.blocked && invokeRefused, `fetch ${b.how}; invoke ${how}`);
    const av = await fetch(`${base}/__zumi/avatar.vrm`);
    note('refused: the avatar without the avatar permission', av.status === 404, `status ${av.status}`);
    r = await bridge('settings.get', { key: 'aiKey' });
    note('refused: a method outside the bridge', refused(r) && r.body.code === 'method_unknown', JSON.stringify(r.body));
  }

  window.__canary = (async () => {
    await inScope();
    await outOfScope();
    return { pack: id, results, passed: results.filter((x) => x.pass).length, failed: results.filter((x) => !x.pass).length };
  })();
  // Navigation off the pack is tried by the runner after this (location.assign), so a refusal leaves the page in place.
})();
