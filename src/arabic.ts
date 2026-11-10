const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;

export function normalizeArabic(input: string) {
  return input
    .replace(DIACRITICS, '')
    .replace(/\u0640/g, '')
    .replace(/[إأآٱا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0621-\u063A\u0641-\u064A\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeArabic(input: string) {
  const normalized = normalizeArabic(input);
  return normalized ? normalized.split(' ') : [];
}

export type ComparedWord = { expected: string; heard: string; ok: boolean };

/** Greedy word alignment. Close enough for recitation scoring without a forced aligner. */
export function compareRecitation(expectedArabic: string, transcript: string) {
  const expected = tokenizeArabic(expectedArabic);
  const heard = tokenizeArabic(transcript);
  const words: ComparedWord[] = [];
  let cursor = 0;
  for (const word of expected) {
    let found = -1;
    const window = Math.min(heard.length, cursor + 4);
    for (let index = cursor; index < window; index += 1) {
      if (heard[index] === word) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      words.push({ expected: word, heard: heard[found] ?? '', ok: true });
      cursor = found + 1;
    } else {
      words.push({ expected: word, heard: heard[cursor] ?? '', ok: false });
      if (cursor < heard.length) cursor += 1;
    }
  }
  const correct = words.filter((word) => word.ok).length;
  return {
    words,
    correct,
    total: words.length,
    accuracy: words.length ? correct / words.length : 0,
  };
}
