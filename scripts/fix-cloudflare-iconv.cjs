const fs = require('fs');
const path = require('path');

const packagePath = path.join(path.dirname(require.resolve('iconv-lite')), '..', 'package.json');
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// iconv-lite 0.4.24 marks its Node stream adapters as browser-false. Wrangler
// exposes process.versions.node in Workers, so that browser mapping makes the
// Node-only initialization call an empty module instead of the streams shim.
if (metadata.browser && metadata.browser['./lib/streams'] === false) {
  delete metadata.browser;
  fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
}
