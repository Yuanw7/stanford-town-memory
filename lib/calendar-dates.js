const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function calendarDate(value) {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('invalid_calendar_date');
  return value;
}
function calendarDates(text, { referenceDate, allowPartial = false, relativeToday = false } = {}) {
  const dates = new Set((text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).map(calendarDate));
  const pattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi;
  for (const match of text.matchAll(pattern)) {
    const year = match[3] ?? (allowPartial ? referenceDate?.slice(0, 4) : null);
    if (!year) continue;
    dates.add(calendarDate(`${year}-${String(months.indexOf(match[1].toLowerCase()) + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`));
  }
  if (!dates.size && relativeToday && /\btoday\b/i.test(text)) dates.add(calendarDate(referenceDate));
  return dates;
}
module.exports = { calendarDate, calendarDates };
