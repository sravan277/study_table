#!/usr/bin/env node
/**
 * Generates a VAPID keypair for Web Push.
 *
 *   npm run vapid
 *
 * The private key is RAW BASE64URL, not PEM. That is not a style choice: `web-push`
 * validates it against /^[A-Za-z0-9\-_]+$/ and decodes it as base64url, so a PEM block
 * throws at boot and no notification is ever sent. The command prints a warning about
 * exactly that.
 */

import { generateVAPIDKeys } from "web-push";

const keys = generateVAPIDKeys();

const PEM_TRAP =
  "Do not wrap these in -----BEGIN/-----END blocks. web-push expects raw base64url and " +
  "throws on a PEM value, which would silently disable every notification.";

console.log(`
VAPID keypair generated.

Add these to .env.local:

VAPID_PUBLIC_KEY=${keys.publicKey}
VAPID_PRIVATE_KEY=${keys.privateKey}
VAPID_SUBJECT=mailto:you@example.com

${PEM_TRAP}

These keys are now in your shell history and this transcript. That is fine for a
publishable key; treat the private key as a secret, and commit .env.local only to
your own machine.
`);