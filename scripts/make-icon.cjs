// One-off: crop Zumi's face from a self-test frame into buildres/icon.png (256x256).
// Usage: electron scripts/make-icon.cjs <frame.png>
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('make-icon.cjs');
const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.resolve(process.argv[2]));
  const { width } = src.getSize();
  const k = width / 1280;
  const face = src.crop({ x: Math.round(555 * k), y: Math.round(95 * k), width: Math.round(250 * k), height: Math.round(250 * k) }).resize({ width: 256, height: 256, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, '..', 'buildres', 'icon.png'), face.toPNG());
  console.log('icon written', face.getSize());
  app.quit();
});
