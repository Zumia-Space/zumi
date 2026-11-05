// T-31 parity step 6: the AI provider settings (BYOK provider, mode, one-time pin) for the sidecar.
//
// A port of src/main/main.js :267-320 (aiProviderId, pinAiProvider, aiDefaultsLegacy, migrateOpencodeModels, aiMode,
// aiLegacyDefaults) and the `ai:set-mode` / `ai:set-provider` handler bodies (:1015-1050). The pure rules stay in
// src/main/providers.js (imported unchanged); only the settings plumbing is here, so Electron's main.js is untouched
// (freeze). scripts/check-tauri-ai-settings.mjs runs main.js's own text against the same fixtures and compares every
// reply and the settings file after each call, so the two cannot drift.
import fs from 'node:fs';
import path from 'node:path';

import { providers } from './adapters.mjs';
// FL-1: the Tauri build extends the frozen provider table (Cloudflare, Mistral) at module load. The frozen pure rules
// stay unchanged; only the active descriptor is resolved through the layer so Cloudflare's Account ID is validated.
import { registerTauriPresets, resolveTauriProvider, validateCloudflareAccountId } from './free-llm-presets.mjs';

const { PROVIDERS, isProviderId, selectableProvider, resolveProviderId, switchRoleSlots, isMode, resolveMode, effectiveLegacyDefaults, migrateOpencodeRoleModels } = providers;

registerTauriPresets(PROVIDERS);

/**
 * @param {{ dataDir: string, settings: () => object, saveSettings: (patch: object) => object, onChange?: () => void }} o
 * `onChange` is Electron's `rebuildChatBrain`: called after a mode or provider change, so the brain re-reads its key and
 * model on the next turn. It is a no-op until the chat brain exists (talk.turn, behind the host gate).
 */
export function createAiSettings({ dataDir, settings, saveSettings, onChange = () => {}, shotsProvider = null, ownerBuild = false }) {
  // The legacy (pre-BYOK) signal: an OpenRouter key from the Jev flow exists in this data dir.
  const hasOpenRouterKey = () => { try { return fs.existsSync(path.join(dataDir, 'jev-key.bin')); } catch { return false; } };
  const providerId = () => {
    // Step 12-runtime: a --settings-shots run drives the FIXTURE provider (role-models-fixtures.json: OpenRouter).
    // Its fake keys and fake endpoint are OpenRouter-shaped, so the run uses that provider for the key shape/test and
    // the chat path. CLI mode only; a normal launch never has a fixture.
    if (shotsProvider) return shotsProvider;
    const stored = settings().aiProvider;
    return selectableProvider(stored, ownerBuild) ? stored : resolveProviderId(isProviderId(stored) ? null : stored, hasOpenRouterKey());
  };
  const provider = () => resolveTauriProvider(providerId(), settings()) || PROVIDERS[providerId()];
  const defaultsLegacy = () => settings().aiDefaultsLegacy === true;
  // The fixture provider is a BYOK provider, so the picker/labels are the plain BYOK ones in a shots run.
  const mode = () => (shotsProvider ? 'byok' : resolveMode(settings().aiMode, defaultsLegacy()));

  // FL-3: the only settings the free-LLM preset UI may write. A strict allow-list, so a caller can never smuggle a key
  // or an unrelated setting through this rpc. Values are validated before saveSettings writes anything.
  const PRESET_SETTING_FIELDS = new Set(['cloudflareAccountId', 'age18Confirmed']);
  const presetSettings = () => {
    const s = settings();
    return {
      cloudflareAccountId: typeof s.cloudflareAccountId === 'string' ? s.cloudflareAccountId : null,
      age18Confirmed: s.age18Confirmed === true,
    };
  };

  return {
    providerId,
    provider,
    mode,
    presetSettings,

    /**
     * `ai.setPresetSettings`: { cloudflareAccountId?, age18Confirmed? }. Refuses anything that is not one of those two
     * fields, a non-32-hex Account ID (an empty string or null CLEARS it), or a non-boolean age answer, with a typed
     * error and NO write. Writes only through saveSettings and then calls onChange, because the chat brain resolves
     * Cloudflare's base URL at build time: without the rebuild a saved Account ID would not reach the next turn until
     * the app restarted (Opus re-gate N1). The reply carries the two non-secret settings, never a key.
     */
    setPresetSettings(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'bad_settings' };
      const keys = Object.keys(patch);
      if (!keys.length) return { ok: false, error: 'bad_settings' };
      for (const key of keys) if (!PRESET_SETTING_FIELDS.has(key)) return { ok: false, error: 'bad_field', field: key };
      if (Object.prototype.hasOwnProperty.call(patch, 'cloudflareAccountId')) {
        const value = patch.cloudflareAccountId;
        const clears = value === '' || value === null;
        if (!clears && !validateCloudflareAccountId(value)) return { ok: false, error: 'bad_cloudflare_account_id' };
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'age18Confirmed') && typeof patch.age18Confirmed !== 'boolean') {
        return { ok: false, error: 'bad_age18' };
      }
      const next = {};
      for (const key of keys) next[key] = key === 'cloudflareAccountId' && (patch[key] === '' || patch[key] === null) ? null : patch[key];
      saveSettings(next);
      onChange();
      return { ok: true, settings: presetSettings() };
    },
    legacyDefaults: () => effectiveLegacyDefaults(defaultsLegacy(), mode()),
    /** `ai.provider` reply. */
    providerInfo: () => ({ id: providerId(), label: provider().label, mode: mode() }),

    /** Once at start (main.js pinAiProvider): freeze the migration-free provider choice and the legacy flag. */
    pin() {
      const s = settings();
      if (isProviderId(s.aiProvider) && typeof s.aiDefaultsLegacy === 'boolean') return;
      saveSettings({ aiProvider: resolveProviderId(s.aiProvider, hasOpenRouterKey()), aiDefaultsLegacy: typeof s.aiDefaultsLegacy === 'boolean' ? s.aiDefaultsLegacy : hasOpenRouterKey() });
    },

    /** Once at start, after pin() (main.js migrateOpencodeModels): retire saved `*-free` OpenCode role ids. */
    migrateOpencodeModels() {
      const s = settings();
      const patch = {};
      if (s.aiProvider === 'opencode') {
        const live = migrateOpencodeRoleModels(s.roleModels);
        if (live !== s.roleModels) patch.roleModels = live;
      }
      const by = s.roleModelsByProvider;
      if (by && typeof by === 'object' && by.opencode) {
        const slot = migrateOpencodeRoleModels(by.opencode);
        if (slot !== by.opencode) patch.roleModelsByProvider = { ...by, opencode: slot };
      }
      if (Object.keys(patch).length) saveSettings(patch);
    },

    /** `ai.setMode` (main.js ai:set-mode). */
    setMode(next) {
      if (!isMode(next)) return { ok: false, error: 'bad_mode' };
      saveSettings({ aiMode: next });
      onChange();
      return { ok: true, mode: next };
    },

    /** `ai.setProvider` (main.js ai:set-provider): role choices are per provider, so the live slot is swapped. */
    setProvider(id) {
      if (!selectableProvider(id, ownerBuild)) return { ok: false, error: 'bad_provider' };
      const s = settings();
      const from = providerId();
      if (id === from) {
        saveSettings({ aiProvider: id });
      } else {
        const moved = switchRoleSlots(s.roleModelsByProvider, from, s.roleModels, id);
        saveSettings({ aiProvider: id, roleModels: moved.live, roleModelsByProvider: moved.byProvider });
      }
      onChange();
      return { ok: true, id, label: PROVIDERS[id].label };
    },
  };
}
