const fs = require('fs');
const path = require('path');

const packagePath = path.join(path.dirname(require.resolve('iconv-lite')), '..', 'package.json');
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// iconv-lite 0.4.24 marks its Node stream adapters as browser-false. Wrangler
<<<<<<< HEAD
// exposes process.versions.node in Workers, so that browser mapping makes the
// Node-only initialization call an empty module instead of the streams shim.
=======
// exposes process.versions.node in Workers, so this mapping selects an empty
// module instead of iconv-lite's Node streams adapter.
>>>>>>> 1f9346dc334ef7fd63bb3e1ffdf5825c3ae6b07a
if (metadata.browser && metadata.browser['./lib/streams'] === false) {
  delete metadata.browser;
  fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
}
