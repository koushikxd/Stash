exports.default = async function notarizeIfConfigured(context) {
  if (process.platform !== 'darwin') return;
  const { NOTARIZE_APPLE_ID, NOTARIZE_APPLE_ID_PASSWORD, NOTARIZE_TEAM_ID } = process.env;
  if (!NOTARIZE_APPLE_ID || !NOTARIZE_APPLE_ID_PASSWORD || !NOTARIZE_TEAM_ID) return;
  const { notarize } = require('@electron/notarize');
  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: NOTARIZE_APPLE_ID,
    appleIdPassword: NOTARIZE_APPLE_ID_PASSWORD,
    teamId: NOTARIZE_TEAM_ID,
  });
};
