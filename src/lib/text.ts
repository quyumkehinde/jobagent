// Caps text at `maxWords` words, preserving original formatting. Text at or under
// the cap is returned untouched.
export function limitWords(text: string, maxWords: number): string {
  let count = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    count++;
    if (count === maxWords) return `${text.slice(0, m.index + m[0].length)}\n…[truncated]`;
  }
  return text;
}
