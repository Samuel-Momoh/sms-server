const fs = require('fs');

const files = [
  '/Users/samuelmomoh/sms-gateway-server/swagger.json',
  '/Users/samuelmomoh/sms-gateway-server/MOBILE_APP_API_DOCS.md'
];

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let content = fs.readFileSync(f, 'utf8');

  content = content.replace(/updateRequired/g, 'forceUpgrade');
  content = content.replace(/updateAvailable/g, 'needsUpdate');

  content = content.replace(
    /Reads the version currently live on the app's Google Play listing and reports it against the minimum version stored in the database\./g,
    "Reads the production release from the Google Play Developer API and reports it against the minimum version stored in the database."
  );

  content = content.replace(
    /Google Play does not publish `versionCode` anywhere on the public listing/g,
    "Google Play Developer API provides `versionCode`"
  );

  content = content.replace(
    /since Play does not publish versionCode/g,
    "from the Play Developer API"
  );

  content = content.replace(
    /A newer version than the installed one is live on the store/g,
    "A newer version than the installed one is available on the Play Store"
  );

  fs.writeFileSync(f, content, 'utf8');
  console.log("Updated", f);
}
