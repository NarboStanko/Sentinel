// Config plugin (opzione b): copia network-security-config.xml nel progetto Android
// e aggiunge android:networkSecurityConfig all'<application> del manifest.
// Usato al posto di expo-build-properties perché SDK 51 usa build-properties 0.11.x
// che non espone ancora la proprietà android.networkSecurityConfig.
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

function withNetworkSecurityConfig(config) {
  // Copia il file XML nella directory res/xml del progetto Android generato da prebuild.
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const src = path.resolve(__dirname, '../network-security-config.xml');
      const destDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/res/xml'
      );
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, 'network_security_config.xml'));
      return config;
    },
  ]);

  // Aggiunge android:networkSecurityConfig="@xml/network_security_config" all'<application>.
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });

  return config;
}

module.exports = withNetworkSecurityConfig;
