const MINUTES_PER_DAY = 24 * 60;

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return { hours: 0, minutes: 0 };

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23
    || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return { hours: 0, minutes: 0 };
  }
  return { hours, minutes };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function stepTime(value, unit, delta) {
  const { hours, minutes } = parseTime(value);
  const unitMinutes = unit === 'hour' ? 60 : 15;
  const current = hours * 60 + minutes;
  const wrapped = ((current + Number(delta || 0) * unitMinutes) % MINUTES_PER_DAY + MINUTES_PER_DAY)
    % MINUTES_PER_DAY;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}
