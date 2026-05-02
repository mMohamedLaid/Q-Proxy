// keygen.js - Run with: node keygen.js
// Generates secure random API keys for your proxy users

const crypto = require('crypto');

const args = process.argv.slice(2);
const count = parseInt(args[0]) || 1; // node keygen.js 4 → generates 4 keys

console.log('\n=== Generated API Keys ===\n');

for (let i = 0; i < count; i++) {
  const key = 'proxy-' + crypto.randomBytes(24).toString('base64url');
  console.log(`Key ${i + 1}: ${key}`);
}

console.log('\nPaste these into server.js under SHARED_KEYS or SOLO_KEYS');
console.log('Give each user ONLY their own key, never share others.\n');
