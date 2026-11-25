// Generate VAPID keys for web push. Run: node scripts/gen-vapid.mjs
// Put the output in .dev.vars (local) or `wrangler secret put` (production).
import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const pkcs8 = await exportPKCS8(privateKey);
const privB64 = pkcs8.split('\n').filter((l) => !l.includes('---')).join('');
const jwk = await exportJWK(publicKey);
const d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const pub = Buffer.concat([Buffer.from([4]), d(jwk.x), d(jwk.y)]);
const pubB64url = pub.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log(`VAPID_PUBLIC_KEY=${pubB64url}`);
console.log(`VAPID_PRIVATE_KEY=${privB64}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
