const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcRenderer = path.join(root, 'src', 'renderer');
const dstRenderer = path.join(root, 'dist', 'renderer');

fs.mkdirSync(dstRenderer, { recursive: true });
for (const file of fs.readdirSync(srcRenderer)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(srcRenderer, file), path.join(dstRenderer, file));
  }
}
console.log('assets copied');
