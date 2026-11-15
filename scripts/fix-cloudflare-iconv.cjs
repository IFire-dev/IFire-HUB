const fs = require('fs');
const path = require('path');

const packagePath = path.join(path.dirname(require.resolve('iconv-lite')), '..', 'package.json');
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// iconv-lite 0.4.24 marks its Node stream adapters as browser-false. Wrangler
// exposes process.versions.node in Workers, so this mapping selects an empty
// module instead of iconv-lite's Node streams adapter.
if (metadata.browser && metadata.browser['./lib/streams'] === false) {
  delete metadata.browser;
  fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
}
