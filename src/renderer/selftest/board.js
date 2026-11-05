// Self-test, board part: the local task board (Laneboard core) driven through the real app. Owned by the Laneboard
// re-pin work (the board page's DOM changes with each Laneboard pin); the T-31 gesture work does not edit this file.
// Written against Laneboard 984927c (P1 three-pane shell: rail · task view with Tình hình + stream + composer ·
// context tabs with the steps, the task status and the history).

// Board tab, driven through the real app: the sidebar tab opens the webview, navigation goes through the page's own
// rail, and every change goes through the page's own controls with real input events (mouse on the step-state and
// task-status selects, one key, Enter; a click on "reply" under an open question, typed text, a real clipboard paste of
// an image into the composer, a click on send). A refusal must be listed next to the step, the history card must show
// the accepted changes, the answered question must carry the pasted image. Main logs every HTTP status the board
// answered. Three data situations, decided by what the test put in <selftest dir>\board-data before launch:
//   empty -> 'seeded' (first-run sample) · a v0.2 board -> 'migrated' · a v0.2 board breaking the rules -> 'refused'.
export async function boardCheck(ctx) {
  const { app, api, log, sleep, frames, until, pngName } = ctx;
  const b = { ok: false };
  app.openBoardTab();
  const hint = () => document.getElementById('board-hint');
  const got = await until(() => {
    const w = app.boardWebview();
    if (w && w.dataset.loaded === '1') return 'webview';
    return !hint().hidden && hint().classList.contains('notice') ? 'refused' : null;
  }, 30000);
  const bl0 = await api.boardLog();
  const legacyIntact = JSON.stringify(bl0.legacyBefore && bl0.legacyBefore.files) === JSON.stringify(bl0.legacyAfter.files);
  Object.assign(b, { laneboard: bl0.laneboard, outcome: bl0.outcome, root: bl0.root, dataDir: bl0.dataDir, normalRunDataDir: bl0.normalRunDataDir, legacyTasksBefore: bl0.legacyBefore && bl0.legacyBefore.tasks, legacyFilesIntact: legacyIntact });
  if (!got) { b.error = 'board did not load'; return b; }

  if (got === 'refused') {
    await sleep(400);
    // each refusal line carries its rule id: as data-rule (owner-facing words only) or, in older app builds, in its text
    const items = [...hint().querySelectorAll('li')].map((li) => (li.dataset.rule ? `${li.textContent} [${li.dataset.rule}]` : li.textContent));
    if (ctx.audit) ctx.audit('board refused (legacy data)');
    const shot = await api.capture('board-refused', { save: pngName('board-legacy-refused') });
    b.refused = { uiText: hint().innerText, items, laneboardDirCreated: bl0.laneboardDirExists, png: shot.png };
    b.screenshots = [shot.png];
    b.ok = bl0.outcome === 'refused' && items.some((t) => t.includes('waiting_before_done')) && legacyIntact && !bl0.laneboardDirExists && !shot.blank;
    log(`board ok=${b.ok} outcome=refused items=${JSON.stringify(items)} legacyIntact=${legacyIntact}`);
    app.openZumiTab();
    await frames(10);
    return b;
  }

  if (ctx.audit) ctx.audit('board tab toolbar');
  // Guest-view attach readiness (J-05 coordinator QC 03-10): dataset.loaded (did-finish-load, above) proved
  // insufficient on its own -- the FIRST executeJavaScript() call below occasionally hit
  // "GUEST_VIEW_MANAGER_CALL ... Script failed to execute", always right here, never reproducible outside this
  // selftest (a 20x open/reload/inject stress run outside the selftest: 0/40 errors -- see board-stress.js). The
  // extra wait for dom-ready (app.js) settles the guest's internal attach handshake before the first inject.
  await until(() => { const w = app.boardWebview(); return w && w.dataset.domReady === '1'; }, 10000);
  const wv = app.boardWebview();
  const js = (code) => wv.executeJavaScript(code);
  // The board routes with a #/... fragment, so wv.getURL() moves with the page; the host's guestUrl is the loaded document.
  const stripHash = (x) => String(x).split('#')[0];
  const u = new URL(wv.getURL());
  b.url = wv.getURL(); // the #token= fragment is consumed by the page on load
  b.servedFromLoopback = u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === bl0.port && Boolean(bl0.guestUrl) && stripHash(bl0.guestUrl) === stripHash(b.url);
  b.tokenLeftUrl = !/token=/.test(b.url);
  const authed = (p) => `fetch(${JSON.stringify(p)},{cache:'no-store',headers:{Authorization:'Bearer '+localStorage.getItem('laneboard.token')}}).then(r=>r.json())`;
  const serverState = () => js(authed('api/v1/state'));
  const serverTasks = async () => (await serverState()).tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, rev: t.rev, steps: t.steps.map((x) => ({ id: x.id, label: x.label, state: x.state, rev: x.rev })), current: t.current_step }));
  b.signedInAsOwner = Boolean(await until(() => js(`!!(S.data&&S.data.me&&S.data.me.role==='owner')`)));
  // the board inside the app reports the pinned commit like the live board does (vendor RELEASE, scripts/check-parity.mjs)
  b.healthz = await js(`fetch('healthz',{cache:'no-store'}).then(r=>r.json())`);
  b.releaseOk = Boolean(b.healthz && typeof b.healthz.release === 'string' && b.healthz.release.length >= 7 && String(bl0.laneboard || '').startsWith(b.healthz.release));
  b.uiLang = await js('S.lang');
  const tasks0 = await serverTasks();
  b.serverTasks = tasks0.map((t) => ({ id: t.id, title: t.title, steps: t.steps.map((s) => s.state), current: t.current && t.current.id }));
  if (bl0.outcome === 'seeded') {
    b.dataOk = tasks0.length === 1 && tasks0[0].id === 'VM-01';
  } else {
    const legacy = (bl0.legacyBefore && bl0.legacyBefore.tasks) || [];
    b.dataOk = bl0.outcome === 'migrated' && legacyIntact && bl0.migrationReport && legacy.length > 0 && tasks0.length === legacy.length
      && legacy.every((l) => { const t = tasks0.find((x) => x.id === l.code); return t && t.title === l.title && JSON.stringify(t.steps.map((s) => s.state)) === JSON.stringify(l.steps); });
  }
  const task = tasks0[0];
  const tid = JSON.stringify(task.id);
  // open the task through the rail (the page's own link)
  const navSel = JSON.stringify(`.lrow a.lmain[href="#/task/${encodeURIComponent(task.id)}"]`);
  await until(() => js(`!!document.querySelector(${navSel})`));
  await js(`document.querySelector(${navSel}).click()`);
  b.sampleRendered = Boolean(await until(() => js(`(()=>{const h=document.querySelector('.tv-head');return !!h&&(h.querySelector('h1')||{}).textContent===${JSON.stringify(task.title)}&&(h.querySelector('.code')||{}).textContent===${tid}})()`)));
  // Tình hình: the "Bước" line shows the server's current step (number + label)
  const currentShown = () => js(`(()=>{const dt=[...document.querySelectorAll('.situation dl.kv dt')].find(d=>d.textContent===t('situation.step'));return dt?dt.nextElementSibling.textContent:''})()`);
  const shows = (t, text) => { const i = t.steps.findIndex((s) => s.id === t.current.id); return Boolean(t.current) && text.includes(String(i + 1)) && text.includes(t.current.label); };
  b.currentStep = { server: task.current, shown: await currentShown() };
  b.currentStep.ok = shows(task, b.currentStep.shown);
  await sleep(400);
  const shotA = await api.capture('board-task', { save: pngName(`board-${bl0.outcome}-task`) });

  // Every change below goes through the page's own controls with real input events sent to the webview (a mouse move
  // onto the row — the step select only shows on a hovered row —, a click on the <select>, one key to reach the
  // option, Enter): no write() call from the test. The key is chosen so the select changes exactly once whether or not
  // its option list opened (it only opens while Zumi's window is the foreground window; a closed select commits on
  // every key): End/Home, a single arrow, or the option's unique first letter. A capturing listener records each change
  // event the page saw, so the report shows one trusted change.
  await js(`window.__zumiChanges=[];document.addEventListener('change',e=>{const d=e.target.dataset||{};if(d.stepState||d.taskStatus)window.__zumiChanges.push({target:d.stepState||d.taskStatus,value:e.target.value,trusted:e.isTrusted})},true);true`);
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),value:e.value,options:e.options?[...e.options].map(o=>o.value):null,labels:e.options?[...e.options].map(o=>o.textContent.trim()):null}})()`);
  const press = (keyCode) => { wv.sendInputEvent({ type: 'keyDown', keyCode }); wv.sendInputEvent({ type: 'keyUp', keyCode }); };
  const click = async (sel, hoverSel) => {
    if (hoverSel) { const h = await center(hoverSel); if (h) { wv.focus(); wv.sendInputEvent({ type: 'mouseMove', x: h.x, y: h.y }); await sleep(150); } }
    const c = await center(sel);
    if (!c) return null;
    await sleep(250);
    wv.focus();
    wv.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    wv.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wv.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    return c;
  };
  const writesSince = async (n, p = '/api/v1/write') => (await api.boardLog()).requests.slice(n).filter((r) => r.method === 'POST' && r.path === p).map((r) => r.status);
  const choose = async (sel, value, hoverSel) => {
    const n = (await api.boardLog()).requests.length;
    const changes0 = await js('window.__zumiChanges.length');
    const c = await click(sel, hoverSel);
    if (!c) return { error: `no control ${sel}`, http: [], changes: [], toast: '' };
    await sleep(400); // the option list is open
    const from = c.options.indexOf(c.value), to = c.options.indexOf(value);
    const first = (i) => c.labels[i].charAt(0).toLocaleLowerCase();
    let keys;
    if (to === c.options.length - 1) keys = 'End';
    else if (to === 0) keys = 'Home';
    else if (Math.abs(to - from) === 1) keys = to > from ? 'Down' : 'Up';
    else if (c.labels.filter((_, i) => first(i) === first(to)).length === 1) keys = `char ${c.labels[to].charAt(0)}`;
    else return { error: `no single key reaches ${value} in ${sel}`, http: [], changes: [], toast: '' };
    if (keys.startsWith('char ')) { const ch = keys.slice(5); wv.sendInputEvent({ type: 'keyDown', keyCode: ch }); wv.sendInputEvent({ type: 'char', keyCode: ch }); wv.sendInputEvent({ type: 'keyUp', keyCode: ch }); } else press(keys);
    await sleep(80);
    press('Enter');
    await until(async () => (await writesSince(n)).length > 0, 8000);
    await sleep(700); // the page's refresh after the answer
    const http = await writesSince(n);
    const changes = (await js('window.__zumiChanges')).slice(changes0);
    const toast = await js(`(()=>{const el=document.querySelector('#toast');return el&&!el.hidden?el.textContent:''})()`);
    return { from: c.value, to: value, keys: `${hoverSel ? 'hover row, ' : ''}click, ${keys}, Enter`, http, changes, toast };
  };
  const sid = (id) => id.split('/')[1];
  const stepSel = (id) => `#step-${sid(id)} select[data-step-state=${JSON.stringify(id)}]`;
  const rowSel = (id) => `#step-${sid(id)} .srow-main`;
  const statusSel = `.tv-head select[data-task-status=${tid}]`;
  const oneTrusted = (r, target, value) => r.changes.length === 1 && r.changes[0].trusted && r.changes[0].target === target && r.changes[0].value === value;

  // (a) one valid step change through the step's state select: the first active step -> done, else the last todo -> active
  const active = task.steps.find((s) => s.state === 'active');
  const todo = [...task.steps].reverse().find((s) => s.state === 'todo');
  const validStep = active ? [active.id, 'done'] : [todo.id, 'active'];
  const v = await choose(stepSel(validStep[0]), validStep[1], rowSel(validStep[0]));
  const t1 = (await serverTasks()).find((t) => t.id === task.id);
  const shownAfter = await until(async () => { const s = await currentShown(); return shows(t1, s) ? s : null; });
  const selectShows = await js(`(document.querySelector(${JSON.stringify(stepSel(validStep[0]))})||{}).value`);
  await center(stepSel(validStep[0]));
  await sleep(300);
  const shotB = await api.capture('board-step-select', { save: pngName('board-a-step-select-200') });
  b.stepSelect = { change: `${validStep[0]} ${v.from} -> ${validStep[1]}`, via: `step-state select: ${v.keys}`, http: v.http, changeEvents: v.changes, toast: v.toast, stored: t1.steps.find((s) => s.id === validStep[0]).state, selectShows, currentStepBefore: task.current, currentStepAfter: t1.current, currentStepShown: shownAfter, png: shotB.png, error: v.error };
  b.stepSelect.ok = oneTrusted(v, validStep[0], validStep[1]) && v.http.length === 1 && v.http[0] === 200 && b.stepSelect.stored === validStep[1] && selectShows === validStep[1] && t1.current.id !== task.current.id && Boolean(shownAfter);

  // (b) one task status change through the status select in the task header (blocked: needs no open ask, unlike waiting)
  const statusBefore = t1.status;
  const newStatus = statusBefore === 'blocked' ? 'doing' : 'blocked';
  const st = await choose(statusSel, newStatus);
  const statusStored = (await serverTasks()).find((t) => t.id === task.id).status;
  const statusShown = await js(`(document.querySelector(${JSON.stringify(statusSel)})||{}).value`);
  await center('.tv-head');
  await sleep(300);
  const shotS = await api.capture('board-status-select', { save: pngName('board-b-status-select-200') });
  b.statusSelect = { change: `${task.id} ${statusBefore} -> ${newStatus}`, via: `task-status select: ${st.keys}`, http: st.http, changeEvents: st.changes, toast: st.toast, stored: statusStored, selectShows: statusShown, png: shotS.png, error: st.error };
  b.statusSelect.ok = oneTrusted(st, task.id, newStatus) && st.http.length === 1 && st.http[0] === 200 && statusStored === newStatus && statusShown === newStatus;

  // (c) one invalid change: a step after the waiting one -> done (waiting before done) -> 400, the violations are
  // listed right under that step (not only a toast), nothing stored, the select falls back to the stored state
  const wIdx = t1.steps.findIndex((s) => s.state === 'waiting');
  const later = t1.steps.slice(wIdx + 1).find((s) => s.state !== 'done');
  const x = await choose(stepSel(later.id), 'done', rowSel(later.id));
  const t2 = (await serverTasks()).find((t) => t.id === task.id);
  const box = await js(`(()=>{const sel=document.querySelector(${JSON.stringify(stepSel(later.id))});const row=sel&&sel.closest('.srow');const v=row&&row.nextElementSibling;if(!v||!v.classList.contains('violations'))return null;v.scrollIntoView({block:'center'});return {title:(v.querySelector('b')||{}).textContent||'',items:[...v.querySelectorAll('li')].map(li=>li.textContent.trim()),role:v.getAttribute('role'),selectShows:sel.value}})()`);
  await sleep(300);
  const shotC = await api.capture('board-violations', { save: pngName('board-c-refused-violations-400') });
  const waitingShort = sid(t1.steps[wIdx].id);
  b.refusedChange = { change: `${later.id} ${x.from} -> done (waiting ${t1.steps[wIdx].id} before it)`, via: `step-state select: ${x.keys}`, http: x.http, changeEvents: x.changes, toast: x.toast, violationsShown: box, storedAfter: t2.steps.find((s) => s.id === later.id).state, png: shotC.png, error: x.error };
  b.refusedChange.ok = oneTrusted(x, later.id, 'done') && x.http.length === 1 && x.http[0] === 400 && Boolean(box) && box.role === 'alert'
    && box.items.some((it) => it.includes('waiting_before_done') && it.includes(waitingShort))
    && b.refusedChange.storedAfter === x.from && box.selectShows === x.from;

  // (d) the task's history card (opened with a real click on its summary) lists the two accepted changes, newest
  // first, and not the refused one
  const hist = await click('details[data-open="hist"] > summary');
  await until(() => js(`!!(document.querySelector('details[data-open="hist"]')||{}).open`), 4000);
  await center('details[data-open="hist"]');
  await sleep(300);
  const histRows = await js(`[...document.querySelectorAll('details[data-open="hist"] ul.history li')].map(li=>li.textContent.trim())`);
  const expectRows = await js(`({step:t('history.step',{step:${JSON.stringify(sid(validStep[0]))},to:t('state.'+${JSON.stringify(validStep[1])})}),status:t('history.status',{to:t('status.'+${JSON.stringify(newStatus)})}),refused:t('history.step',{step:${JSON.stringify(sid(later.id))},to:t('state.done')})})`);
  const shotD = await api.capture('board-history', { save: pngName('board-d-history') });
  b.history = { opened: Boolean(hist), rows: histRows.slice(0, 6), expect: expectRows, png: shotD.png };
  b.history.ok = Boolean(hist) && histRows.length > 0 && histRows[0].endsWith(expectRows.status) && histRows.some((r) => r.endsWith(expectRows.step))
    && !histRows.some((r) => r.endsWith(expectRows.refused));

  // (e) answer an open question with a pasted image: a real click on "reply" under the question in the stream (the
  // composer scopes itself to it), typed text, a real clipboard paste of an image into the composer box, a real click
  // on send. The upload, the message (feedback.add with ask_id + attachments) and the owner ping must all be accepted;
  // the server then marks the question answered and the stream shows the image.
  {
    const e = { askSource: null };
    let s0 = await serverState();
    let ask = (s0.asks || []).find((a) => a.task_id === task.id && a.status === 'open');
    if (ask) e.askSource = 'board data';
    else if (bl0.outcome !== 'seeded') { // a migrated v0.2 board has no question: set one up through the page's own write()
      await js(`write('ask.raise',${tid},{text:'Câu hỏi kiểm thử: dán ảnh để trả lời.'})`);
      s0 = await serverState();
      ask = (s0.asks || []).find((a) => a.task_id === task.id && a.status === 'open');
      e.askSource = ask ? 'raised by the test (migrated board has none)' : null;
    }
    e.askId = ask ? ask.id : null;
    if (ask) {
      await js('typeof refresh==="function"?refresh():null');
      await until(() => js(`!!document.querySelector('#ev-${ask.id} [data-action="reply-ask"]')`), 6000);
      const n0 = (await api.boardLog()).requests.length;
      e.replyClicked = Boolean(await click(`#ev-${ask.id} [data-action="reply-ask"]`));
      e.scopeShows = await until(() => js(`(()=>{const s=document.querySelector('select[data-compose-scope=${JSON.stringify(task.id).replace(/"/g, '\\"')}]');return s&&s.value===${JSON.stringify('ask:' + ask.id)}?s.value:null})()`), 4000);
      const boxSel = `textarea[data-compose-text=${tid}]`;
      await click(boxSel);
      await sleep(200);
      const text = 'Em làm bước 4 trước nhé. Ảnh chụp màn hình kèm theo.';
      wv.insertText(text);
      await sleep(200);
      // the image goes on the OS clipboard from main (Electron clipboard.write); if this Electron build does not hold an
      // image written that way, the page itself writes it (navigator.clipboard.write, the board page is focused) — either
      // way the composer then gets a REAL paste (webview.paste(), a trusted paste event from the OS clipboard)
      e.clipboard = await api.clipboardImage();
      e.clipboardPath = e.clipboard.hasPng ? 'main clipboard.write' : null;
      if (!e.clipboard.hasPng) {
        e.pageClipboard = await js(`(async()=>{try{const bin=atob('${e.clipboard.pngBase64}');const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);const b=new Blob([u8],{type:'image/png'});await navigator.clipboard.write([new ClipboardItem({'image/png':b})]);const items=await navigator.clipboard.read();return {ok:true,types:items.map(i=>i.types)}}catch(err){return {ok:false,error:String(err)}}})()`);
        if (e.pageClipboard && e.pageClipboard.ok) e.clipboardPath = 'page navigator.clipboard.write';
      }
      await click(boxSel);
      await sleep(150);
      wv.paste();
      const thumbSel = `[data-thumbs=${JSON.stringify(task.id).replace(/"/g, '\\"')}] .thumb img`;
      const thumbOk = () => js(`(()=>{const i=document.querySelector('${thumbSel}');return !!i&&i.complete&&i.naturalWidth>0})()`);
      e.thumbShown = Boolean(await until(thumbOk, 4000));
      e.pastePath = e.thumbShown ? `OS clipboard (${e.clipboardPath}) + webview.paste()` : null;
      if (!e.thumbShown) {
        // No image reached the OS clipboard in this session (reported in e.clipboard / e.pageClipboard). Same page code
        // path, untrusted event: a paste event on the composer box carrying the image as a File.
        await js(`(()=>{const bin=atob('${e.clipboard.pngBase64 || ''}');const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);const dt=new DataTransfer();dt.items.add(new File([u8],'screenshot.png',{type:'image/png'}));const box=document.querySelector(${JSON.stringify(boxSel)});box.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true})()`);
        e.thumbShown = Boolean(await until(thumbOk, 4000));
        e.pastePath = e.thumbShown ? 'synthetic paste event (DataTransfer with the image file) — OS clipboard image unavailable' : 'none';
      }
      if (e.clipboard) delete e.clipboard.pngBase64;
      e.typed = await js(`(document.querySelector(${JSON.stringify(boxSel)})||{}).value`);
      const shotE1 = await api.capture('board-compose', { save: pngName('board-e1-reply-pasted-image') });
      await click('#composer .composer-foot button.primary');
      await until(async () => (await writesSince(n0)).length >= 2, 10000);
      await sleep(800);
      e.http = { upload: await writesSince(n0, '/api/v1/upload'), write: await writesSince(n0) };
      const s1 = await serverState();
      const a1 = (s1.asks || []).find((a) => a.id === ask.id);
      const fb = (s1.messages || []).filter((m) => m.task_id === task.id && m.scope && m.scope.ask_id === ask.id).pop();
      e.askStatus = a1 && a1.status;
      e.message = fb ? { id: fb.id, kind: fb.kind, text: fb.body, answersAsk: fb.answers_ask_id, attachments: (fb.attachments || []).map((x) => x.id) } : null;
      const attId = e.message && e.message.attachments[0];
      e.imageInStream = Boolean(attId) && Boolean(await until(() => js(`(()=>{const i=document.querySelector('.ev-imgs img[data-att=${JSON.stringify(String(attId)).replace(/"/g, '\\"')}]');if(!i)return false;i.scrollIntoView({block:'center'});return i.complete&&i.naturalWidth>0})()`), 8000));
      await sleep(300);
      const shotE2 = await api.capture('board-answered', { save: pngName('board-e2-answered-with-image') });
      e.png = [shotE1.png, shotE2.png];
      e.ok = e.replyClicked && Boolean(e.scopeShows) && e.thumbShown && e.typed === text && e.http.upload.length === 1 && [200, 201].includes(e.http.upload[0])
        && e.http.write.length >= 1 && e.http.write.every((s) => s === 200) && e.askStatus === 'answered'
        && Boolean(e.message) && e.message.text === text && e.message.attachments.length === 1 && e.imageInStream && !shotE1.blank && !shotE2.blank;
    }
    if (bl0.outcome === 'seeded' && e.askSource !== 'board data') e.ok = false; // the first-run sample must carry a question
    b.answerAsk = e;
  }

  // Embedded board: the host provides identity and sign in/out, so the board's own rail sign-out is hidden by design
  // (vendor/laneboard app.js railFoot). Assert that contract; the host-side Lock (Settings) is covered by settings-page.js.
  b.signOutHiddenInEmbed = Boolean(await js(`document.documentElement.classList.contains('embed') && !document.querySelector('[data-action=signout]')`).catch(() => false));
  // then the toolbar's Tải lại: the board comes back signed in as the owner
  wv.dataset.loaded = '0';
  document.getElementById('board-reload').click();
  b.reloadSignsIn = Boolean(await until(() => wv.dataset.loaded === '1')) && Boolean(await until(() => js(`!!(S.data&&S.data.me&&S.data.me.role==='owner')`)));

  b.screenshots = [shotA.png, shotB.png, shotS.png, shotC.png, shotD.png, ...((b.answerAsk && b.answerAsk.png) || [])];
  b.ok = Boolean(b.signOutHiddenInEmbed && b.reloadSignsIn && b.servedFromLoopback && b.tokenLeftUrl && b.signedInAsOwner && b.releaseOk && b.dataOk && b.sampleRendered && b.currentStep.ok
    && b.stepSelect.ok && b.statusSelect.ok && b.refusedChange.ok && b.history.ok && b.answerAsk.ok && ![shotA, shotB, shotS, shotC, shotD].some((s) => s.blank));
  log(`board ok=${b.ok} outcome=${bl0.outcome} laneboard=${bl0.laneboard} release=${b.healthz && b.healthz.release} lang=${b.uiLang} origin=${u.origin} task=${task.id} current=${b.currentStep.shown} a.step=${v.http}/${b.stepSelect.ok} b.status=${st.http}/${b.statusSelect.ok} c.refused=${x.http}/${b.refusedChange.ok} items=${JSON.stringify(box && box.items)} d.history=${b.history.ok} rows=${JSON.stringify(b.history.rows.slice(0, 3))} e.ask=${b.answerAsk.askId}/${b.answerAsk.askSource} upload=${b.answerAsk.http && b.answerAsk.http.upload} write=${b.answerAsk.http && b.answerAsk.http.write} status=${b.answerAsk.askStatus} image=${b.answerAsk.imageInStream}/${b.answerAsk.ok} signoutHidden+reload=${b.signOutHiddenInEmbed}/${b.reloadSignsIn}`);
  app.openZumiTab();
  await frames(10);
  return b;
}
