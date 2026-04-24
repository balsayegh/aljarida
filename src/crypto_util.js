/**
 * Crypto helpers — constant-time compare + Meta webhook signature verification.
 */

/**
 * Constant-time string comparison. Returns false for mismatched lengths or
 * non-string inputs. Length check is intentionally non-constant-time — HMAC
 * outputs and tokens have publicly-known lengths.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify an X-Hub-Signature-256 header against the raw request body.
 * Meta signs every webhook POST with HMAC-SHA256 using the App Secret.
 */
export async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;

  const [algo, providedHex] = signatureHeader.split('=');
  if (algo !== 'sha256' || !providedHex) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(providedHex, expectedHex);
}
