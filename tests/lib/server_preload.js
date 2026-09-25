/**
 * tests/lib/server_preload.js
 * Test environment preload hook.
 *
 * Intercepts configuration without modifying server source files:
 * dynamically assigns process.env.PORT to config.PORT in require.cache.
 */

try {
  const path = require('path');
  const configPath = path.resolve(__dirname, '../../server/config.js');
  const cfg = require(configPath);
  if (process.env.PORT) {
    cfg.PORT = parseInt(process.env.PORT, 10);
  }
} catch (e) {
  // If config is not resolved, allow execution to proceed
}
