const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = (message) => {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
};

let pkg;
let tauri;
try {
  pkg = JSON.parse(read('package.json'));
  tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
} catch (error) {
  fail(`Could not read version metadata: ${error.message}`);
}

const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json has an invalid version: ${JSON.stringify(pkg.version)}`);
}
if (String(tauri.version || '').trim() !== version) {
  fail(`src-tauri/tauri.conf.json version ${JSON.stringify(tauri.version)} does not match package.json ${version}`);
}

const cargoMatch = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"\s*$/m);
if (!cargoMatch) fail('src-tauri/Cargo.toml does not contain a package version');
if (cargoMatch[1].trim() !== version) {
  fail(`src-tauri/Cargo.toml version ${cargoMatch[1].trim()} does not match ${version}`);
}

console.log(version);
