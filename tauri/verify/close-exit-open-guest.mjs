// Open the local board guest in a scratch instance over CDP, the way the renderer does. No OS mouse.
import { waitTarget, connect, sleep } from './cdp.mjs';
const port = process.argv[2];
const t = await waitTarget(port, (x) => /tauri\.localhost/.test(x.url), 20000);
if (!t) { console.log('no target'); process.exit(2); }
const c = await connect(t.webSocketDebuggerUrl);
const r = await c.eval(`(async()=>{
  const out={};
  document.querySelector('[data-tab="board"]').click();
  await new Promise(r=>setTimeout(r,25000));
  out.hint=(document.getElementById('board-hint')||{}).innerText;
  out.where=(document.getElementById('board-where')||{}).innerText;
  out.hosts=[...document.querySelectorAll('#board-host > *')].map(e=>e.tagName+':'+(e.getAttribute('partition')||''));
  if(!out.hosts.length){ const b=await window.zumi.openBoard(); out.open=b&&{error:b.error,origin:b.origin,outcome:b.outcome};
    if(b&&b.url){ const info=window.zumi.info?await window.zumi.info():{}; const res=await window.__TAURI_INTERNALS__.invoke('guest_open',{src:b.url,partition:'preview-board'}).catch(e=>'ERR '+e); out.guest=typeof res==='string'?res:{label:res.label}; } }
  return out; })()`);
console.log(JSON.stringify(r));
await sleep(5000);
c.close();
process.exit(0);
