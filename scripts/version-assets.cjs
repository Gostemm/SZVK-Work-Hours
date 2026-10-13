const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const assets = ['shared.js', 'shared.css'].map(name => ({
  name,
  // Git may change line endings on checkout; keep cache versions identical on Windows and Linux.
  version: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}));

for (const name of ['index.html', 'trackers.html']) {
  const filename = path.join(root, name);
  let html = fs.readFileSync(filename, 'utf8');
  for (const asset of assets) {
    const reference = new RegExp(`((?:src|href)="${asset.name.replace('.', '\\.')})(?:\\?[^"\\s]*)?"`, 'g');
    html = html.replace(reference, `$1?v=${asset.version}"`);
  }
  fs.writeFileSync(filename, html);
}
console.log('Updated asset versions in both pages.');
