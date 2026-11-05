#!/usr/bin/env node
// The Tauri update feed for one release (PLAN-UPDATER.md): the installer under a space-free name, and latest.json. The same code
// serves the release workflow and the loopback test feed; only --base-url differs.
//   node scripts/make-update-feed.mjs --installer <setup.exe> --notes release-notes/<v>.md --version <v> --base-url <url> --pubkey-conf <tauri.conf.json> --out <dir>
// The signature is <installer>.sig, written by `cargo tauri signer sign --app-version <v>`. It covers the bytes and the version, not the name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) throw new Error(`--base-url must be https (or http on 127.0.0.1), got ${baseUrl}`);
}

const edKey = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });

/** The check an installed app will make (minisign, prehashed, signed version). Since the build no longer signs, nothing else compares
 *  the signing key with the key baked into the app, and a mismatch would strand every user. Throws on any doubt. */
export function verifySignature({ pubkey, signature, data, version }) {
  if (!pubkey) throw new Error('no public key to verify against');
  const keyLine = Buffer.from(pubkey, 'base64').toString('utf8').trim().split(/\r?\n/)[1] || '';
  const keyBytes = Buffer.from(keyLine, 'base64');
  const sigLines = Buffer.from(signature, 'base64').toString('utf8').trim().split(/\r?\n/);
  const sigBytes = Buffer.from(sigLines[1] || '', 'base64');
  const trusted = (sigLines[2] || '').replace(/^trusted comment: /, '');
  const globalSig = Buffer.from(sigLines[3] || '', 'base64');
  if (keyBytes.length !== 42 || sigBytes.length !== 74 || globalSig.length !== 64) throw new Error('malformed key or signature');
  if (sigBytes.subarray(0, 2).toString() !== 'ED') throw new Error('not a prehashed signature');
  if (!sigBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) throw new Error('signed by another key');
  const key = edKey(keyBytes.subarray(10));
  const raw = sigBytes.subarray(10);
  if (!crypto.verify(null, crypto.createHash('blake2b512').update(data).digest(), key, raw)) throw new Error('the signature does not match the bytes');
  if (!crypto.verify(null, Buffer.concat([raw, Buffer.from(trusted)]), key, globalSig)) throw new Error('the trusted comment is not signed');
  if (!trusted.split('\t').includes(`version:${version}`)) throw new Error(`the signature is not for version ${version}`);
}

/** @returns {{ assetName: string, url: string, feedFile: string }} */
export function makeFeed({ installer, notes, version, baseUrl, out, pubkey = null, date = new Date().toISOString() }) {
  if (!SEMVER.test(version)) throw new Error(`--version is not semver: ${version}`);
  assertBaseUrl(baseUrl);
  const signature = fs.readFileSync(`${installer}.sig`, 'utf8').trim();
  if (!signature) throw new Error(`${installer}.sig is empty`);
  if (pubkey !== null) verifySignature({ pubkey, signature, data: fs.readFileSync(installer), version });
  const notesText = fs.readFileSync(notes, 'utf8');
  fs.mkdirSync(out, { recursive: true });
  const assetName = path.basename(installer).replace(/ /g, '-');
  fs.copyFileSync(installer, path.join(out, assetName));
  const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(assetName)}`;
  const feedFile = path.join(out, 'latest.json');
  fs.writeFileSync(feedFile, `${JSON.stringify({ version, notes: notesText, pub_date: date, platforms: { 'windows-x86_64': { signature, url } } }, null, 2)}\n`);
  return { assetName, url, feedFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const [installer, notes, version, baseUrl, out, pubkeyConf] = ['--installer', '--notes', '--version', '--base-url', '--out', '--pubkey-conf'].map(opt);
  if (!installer || !notes || !version || !baseUrl || !out || !pubkeyConf) {
    console.error('usage: node scripts/make-update-feed.mjs --installer <setup.exe> --notes <md> --version <v> --base-url <url> --pubkey-conf <tauri.conf.json> --out <dir>');
    process.exit(2);
  }
  try {
    const pubkey = JSON.parse(fs.readFileSync(pubkeyConf, 'utf8')).plugins.updater.pubkey;
    const made = makeFeed({ installer, notes, version, baseUrl, out, pubkey });
    console.log(`feed: ${made.feedFile} -> ${made.url}`);
  } catch (e) {
    console.error(`make-update-feed: ${e.message}`);
    process.exit(1);
  }
}
