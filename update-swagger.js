const fs = require('fs');
const indexJsPath = '/Users/samuelmomoh/sms-gateway-server/index.js';
let content = fs.readFileSync(indexJsPath, 'utf8');

content = content.replace(/updateRequired/g, 'forceUpgrade');
content = content.replace(/updateAvailable/g, 'needsUpdate');

// Update description
content = content.replace(
  "Reads the version currently live on the app's Google Play listing and reports it against the minimum version stored in the database.",
  "Reads the production release from the Google Play Developer API and reports it against the minimum version stored in the database."
);

content = content.replace(
  "Google Play does not publish `versionCode` anywhere on the public listing",
  "Google Play Developer API provides `versionCode`"
);

content = content.replace(
  "since Play does not publish versionCode",
  "from the Play Developer API"
);

fs.writeFileSync(indexJsPath, content, 'utf8');
console.log("Updated swagger docs in index.js");
