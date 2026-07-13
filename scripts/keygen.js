'use strict';

const crypto = require('crypto');

const hmacSecret = crypto.randomBytes(48).toString('hex');
const adminKey   = crypto.randomBytes(32).toString('hex');

console.log('\n=== QR Verify — Key Generator ===\n');
console.log('Add these to your .env and Render environment variables:\n');
console.log(`HMAC_SECRET=${hmacSecret}`);
console.log(`ADMIN_API_KEY=${adminKey}`);
console.log('\nNever share or commit these values.\n');
