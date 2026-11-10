export type SessionRow = { day: string; minutes: number; surah_id: number | null; kind: string };
export type MistakeRow = { surah: number; resolved: boolean };

export function computeStats(sessions: SessionRow[], mistakes: MistakeRow[]) {
  const days = new Map<string, number>();
  let minutes = 0;
  for (const session of sessions) {
    const day = String(session.day).slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
    minutes += Number(session.minutes) || 0;
  }
  const unique = [...days.keys()].sort();
  const streakEnding = (through: string) => {
    let count = 0;
    const cursor = new Date(`${through}T00:00:00Z`);
    while (days.has(cursor.toISOString().slice(0, 10))) {
      count += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return count;
  };
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streak = days.has(today) ? streakEnding(today) : streakEnding(yesterday);
  let best = 0;
  let run = 0;
  let prev = '';
  for (const day of unique) {
    const expected = prev ? new Date(new Date(`${prev}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10) : '';
    run = day === expected ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  const heatmap: number[] = [];
  for (let index = 27; index >= 0; index -= 1) {
    const day = new Date(Date.now() - index * 86400000).toISOString().slice(0, 10);
    heatmap.push(Math.min(4, days.get(day) ?? 0));
  }
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const week = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const day = new Date(weekStart.getTime() + offset * 86400000).toISOString().slice(0, 10);
    return days.has(day);
  });
  const bySurah = new Map<number, { sessions: number; mistakes: number }>();
  for (const session of sessions) {
    if (!session.surah_id) continue;
    const row = bySurah.get(session.surah_id) ?? { sessions: 0, mistakes: 0 };
    row.sessions += 1;
    bySurah.set(session.surah_id, row);
  }
  for (const mistake of mistakes) {
    if (mistake.resolved) continue;
    const row = bySurah.get(mistake.surah) ?? { sessions: 0, mistakes: 0 };
    row.mistakes += 1;
    bySurah.set(mistake.surah, row);
  }
  const surahStrength = [...bySurah.entries()]
    .map(([surahId, row]) => {
      const ratio = row.sessions ? Math.max(0.08, 1 - row.mistakes / (row.sessions * 4)) : 0.2;
      const tone = ratio >= 0.75 ? 'strong' : ratio >= 0.45 ? 'review' : 'weak';
      const label = tone === 'strong' ? 'Strong' : tone === 'review' ? 'Review' : 'Weak';
      return { surahId, ratio, tone, label };
    })
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 6);
  const badges = [
    { id: 'streak7', title: '7-day streak', earned: best >= 7 || streak >= 7, icon: 'flame' },
    { id: 'first', title: 'First session', earned: sessions.length > 0, icon: 'book' },
    { id: 'juz30', title: 'Juz 30', earned: sessions.some((session) => (session.surah_id ?? 0) >= 78), icon: 'moon' },
    { id: 'goal', title: 'Goal setter', earned: false, icon: 'flag' },
    { id: 'sessions', title: '100 sessions', earned: sessions.length >= 100, icon: 'ribbon' },
    { id: 'clear', title: 'Clean review', earned: mistakes.some((mistake) => mistake.resolved), icon: 'school' },
  ];
  const todayMinutes = sessions.filter((session) => String(session.day).slice(0, 10) === today).reduce((sum, session) => sum + (Number(session.minutes) || 0), 0);
  return { streak, bestStreak: best, todayMinutes, minutes, sessions: sessions.length, heatmap, week, surahStrength, badges };
}
