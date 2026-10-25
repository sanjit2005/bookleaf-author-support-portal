// INR policy: exact multiples of 0.01, inclusive range 0..999999999999.99.
// Only decimal string parsing and BigInt arithmetic; no floating-point conversion.
export function validMoney(value) {
  if (value == null) return false;
  const match = /^\+?(\d+)(?:\.(\d*))?(?:E([+-]?\d+))?$/i.exec(value.toString());
  if (!match) return false;
  const digits = (match[1] + (match[2] ?? '')).replace(/^0+/, '') || '0';
  if (digits === '0') return true;
  const shift = BigInt(match[3] ?? '0') - BigInt((match[2] ?? '').length) + 2n;
  let minor = BigInt(digits);
  if (shift >= 0n) {
    if (shift > 14n) return false;
    minor *= 10n ** shift;
  } else {
    if (-shift > BigInt(digits.length)) return false;
    const divisor = 10n ** -shift;
    if (minor % divisor !== 0n) return false;
    minor /= divisor;
  }
  return minor <= 99999999999999n;
}
