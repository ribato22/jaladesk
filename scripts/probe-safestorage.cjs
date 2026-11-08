// Needs the real Electron app object (safeStorage is a main-process API), so it cannot run under ELECTRON_RUN_AS_NODE.
// Run with the owner present: on macOS the Keychain may ask once for permission to use "Electron Safe Storage".
//   node_modules/.bin/electron scripts/probe-safestorage.cjs [output-file]
// On Windows electron.exe is a GUI program whose stdout is not attached to the console, so pass an output file and read it afterwards.
const { app, safeStorage } = require('electron');
const { writeFileSync } = require('node:fs');

app.whenReady().then(() => {
  const available = safeStorage.isEncryptionAvailable();
  let roundTrip = false;
  if (available) roundTrip = safeStorage.decryptString(safeStorage.encryptString('probe')) === 'probe';
  const line = JSON.stringify({ available, roundTrip, backend: safeStorage.getSelectedStorageBackend?.() ?? null, platform: process.platform });
  console.log(line);
  if (process.argv[2]) writeFileSync(process.argv[2], line + '\n');
  app.quit();
});
