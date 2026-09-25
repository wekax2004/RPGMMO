// Backwards-compatible module name. The persistence implementation now
// defaults to local atomic JSON storage and only uses Firebase when configured.
module.exports = require('./persistence');
