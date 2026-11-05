// Settings probe (scripts/check-settings-normal-launch.mjs, T-31 settings-a2): runs only under --settings-probe, a
// normal launch with no fixture of any kind. Opens Settings, lets every card load, and reports what the user would
// see -- the check then asserts it is real or empty, never the --settings-shots sample data.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSettingsProbe({ zumi, $, openSettingsTab }) {
  const text = (id) => ($(id) ? $(id).textContent.trim() : null);
  const shown = (id) => Boolean($(id) && $(id).getClientRects().length);
  let report;
  try {
    openSettingsTab();
    await sleep(2500); // brain key, roles, usage, voice and board status all load asynchronously
    // T-31 settings P1: the cards now sit in six tabpanels and only the selected one is visible. This probe reads
    // every card (and the whole .settings text) by id, so reveal all panels for the measurement. QC-only and
    // in-memory -- nothing is persisted and nothing ships differently.
    for (const p of document.querySelectorAll('#tab-settings .stabpanel')) p.hidden = false;
    $('usage-details-toggle').click();
    await sleep(200);
    const settingsText = document.querySelector('#tab-settings .settings').innerText;
    report = {
      ok: true,
      account: { chip: text('board-chip'), formShown: shown('board-form') },
      brain: {
        chip: text('brain-key-chip'), desc: text('brain-key-desc'), editShown: shown('brain-key-edit'), viewShown: shown('brain-key-view'),
        provider: [...$('brain-provider').options].map((o) => ({ text: o.textContent, disabled: o.disabled, selected: o.selected })),
      },
      roles: { status: text('roles-status'), gridShown: shown('roles-grid') },
      usage: {
        summary: [...$('usage-summary-body').rows].map((r) => [...r.cells].map((c) => c.textContent)),
        detailRows: $('usage-tbody').rows.length, emptyShown: shown('usage-empty'),
      },
      voice: { modelRowShown: shown('voice-kokoro-row'), progress: text('voice-kokoro-progress'), ledaChip: text('voice-leda-chip'), speed: $('voice-speed').value, volume: $('voice-volume').value },
      settingsText,
    };
  } catch (e) {
    report = { ok: false, error: String((e && e.stack) || e).slice(0, 2000) };
  }
  await zumi.probe.finish(report);
}
