const { execSync } = require('child_process');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const zipPath = path.join(appOutDir, `${appName}.zip`);

  console.log(`Zipping ${appPath} for notarization...`);
  execSync(
    `ditto -c -k --keepParent "${appPath}" "${zipPath}"`,
    { stdio: 'inherit' }
  );

  console.log(`Submitting ${zipPath} for notarization...`);

  try {
    execSync(
      `xcrun notarytool submit "${zipPath}" --keychain-profile "codebot-notarize" --wait --timeout 30m`,
      { stdio: 'inherit', timeout: 1800000 }
    );

    console.log('Notarization succeeded. Stapling ticket...');
    execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
    console.log('Stapling complete.');
  } catch (err) {
    console.error('Notarization failed:', err.message);
    throw err;
  } finally {
    // Clean up zip
    try { require('fs').unlinkSync(zipPath); } catch (_) {}
  }
};
