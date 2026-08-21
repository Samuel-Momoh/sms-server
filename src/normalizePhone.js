/**
 * Normalizes a phone number to Infobip-ready format (digits only, no +).
 *
 * Rules (applied in order):
 *  1. Strip all non-digit characters (spaces, dashes, parentheses, etc.)
 *  2. Has leading '+' AND digit count > 11  → drop the '+'
 *  3. 11 digits starting with '0'           → strip leading 0, prepend 234
 *  4. 9 or 10 digits                        → prepend 234
 *  5. Anything else                         → return digits as-is
 *
 * Examples:
 *   +2348012345678  (13 digits) → 2348012345678   rule 2
 *   08012345678     (11 digits) → 2348012345678   rule 3
 *   8012345678      (10 digits) → 2348012345678   rule 4
 *   812345678       (9 digits)  → 234812345678    rule 4
 *   2348012345678   (13 digits) → 2348012345678   rule 5 (unchanged)
 *
 * @param {string|number} raw - Raw phone number input
 * @returns {string} Normalized phone number (digits only, no +)
 */
function normalizePhone(raw) {
  const input   = String(raw).trim();
  const hasPlus = input.startsWith('+');
  const digits  = input.replace(/\D/g, ''); // strip everything except digits

  // Rule 2: has + and more than 11 digits → strip the +
  if (hasPlus && digits.length > 11) {
    return digits;
  }

  // Rule 3: 11 digits starting with 0 → remove leading 0, add 234
  if (digits.length === 11 && digits.startsWith('0')) {
    return '234' + digits.slice(1);
  }

  // Rule 4: 9 or 10 digits → add 234 country code
  if (digits.length === 9 || digits.length === 10) {
    return '234' + digits;
  }

  // Default: return digits as-is
  return digits;
}

module.exports = { normalizePhone };
