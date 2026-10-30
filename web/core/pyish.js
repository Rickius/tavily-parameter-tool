// Python-compatible text helpers, so validation messages read the same as the Python backend's
// (they are fed back to the model on a retry, and the parity tests compare them).

export const hasOwn = (object, key) => Object.hasOwn(object, key);

// Python's len() counts code points; JS .length counts UTF-16 units.
export const codePointLength = (text) => [...text].length;

export function truncate(text, maxCodePoints) {
  const points = [...text];
  return points.length > maxCodePoints ? points.slice(0, maxCodePoints).join('') : text;
}

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function reprString(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char !== ' ' && NOT_PRINTABLE.test(char)) {
      if (code < 0x100) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += char;
  }
  return quote + out + quote;
}

// Python's repr() for the JSON-shaped values that show up in messages and in the generated snippet.
export function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${reprString(key)}: ${pyRepr(item)}`).join(', ')}}`;
}

// Python's str() as an f-string applies it: strings as they are, everything else as repr.
export const pyStr = (value) => (typeof value === 'string' ? value : pyRepr(value));

// obj.get(key) in Python: a missing key and a null both read as None (null here).
export const pick = (object, key) => (hasOwn(object, key) && object[key] !== undefined ? object[key] : null);

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// entry.get("planner_choosable", True)
export const isPlannerChoosable = (entry) => !hasOwn(entry, 'planner_choosable') || Boolean(entry.planner_choosable);
