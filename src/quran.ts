import { tokenizeArabic } from './arabic';

type CloudAyah = { numberInSurah: number; text: string; page?: number; juz?: number };
type CloudSurah = {
  number: number;
  englishName: string;
  englishNameTranslation: string;
  revelationType: string;
  ayahs: CloudAyah[];
};

export type StoredAyah = { surah: number; ayah: number; arabic: string; translation: string; page?: number };

let ayahs: StoredAyah[] = [];
let loading: Promise<void> | null = null;

async function edition(name: string) {
  const response = await fetch(`https://api.alquran.cloud/v1/quran/${name}`);
  if (!response.ok) throw new Error(`alquran.cloud ${name} returned ${response.status}`);
  const json = (await response.json()) as { data?: { surahs?: CloudSurah[] } };
  return json.data?.surahs ?? [];
}

export function quranReady() {
  return ayahs.length > 0;
}

export async function ensureQuran() {
  if (ayahs.length) return;
  if (!loading) {
    loading = (async () => {
      const [arabic, english] = await Promise.all([edition('quran-uthmani'), edition('en.sahih')]);
      const englishByKey = new Map<string, string>();
      for (const surah of english) {
        for (const ayah of surah.ayahs) englishByKey.set(`${surah.number}:${ayah.numberInSurah}`, ayah.text);
      }
      const next: StoredAyah[] = [];
      for (const surah of arabic) {
        for (const ayah of surah.ayahs) {
          next.push({
            surah: surah.number,
            ayah: ayah.numberInSurah,
            arabic: ayah.text,
            translation: englishByKey.get(`${surah.number}:${ayah.numberInSurah}`) ?? '',
            page: ayah.page,
          });
        }
      }
      ayahs = next;
    })().finally(() => {
      loading = null;
    });
  }
  await loading;
}

export function rangeText(surah: number, from: number, to: number) {
  return ayahs
    .filter((ayah) => ayah.surah === surah && ayah.ayah >= from && ayah.ayah <= to)
    .map((ayah) => ayah.arabic)
    .join(' ');
}

export function searchTranscript(transcript: string, limit = 8) {
  const heard = new Set(tokenizeArabic(transcript));
  if (!heard.size) return [];
  const scored = ayahs
    .map((ayah) => {
      const tokens = tokenizeArabic(ayah.arabic);
      const overlap = tokens.filter((token) => heard.has(token)).length;
      const score = tokens.length ? overlap / tokens.length : 0;
      return { ayah, score, overlap };
    })
    .filter((item) => item.overlap >= 2 && item.score >= 0.45)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    .slice(0, limit);
  return scored.map((item) => ({
    surah: item.ayah.surah,
    ayah: item.ayah.ayah,
    arabic: item.ayah.arabic,
    translation: item.ayah.translation,
    score: Number(item.score.toFixed(2)),
  }));
}
