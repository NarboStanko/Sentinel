export const HOUR = 3600;
export const DAY  = 86400;

export type TimeUnit = 'seconds' | 'hours' | 'days';

export function toSeconds(value: number, unit: TimeUnit): number {
  if (unit === 'seconds') return value;
  if (unit === 'hours')   return value * HOUR;
  return value * DAY;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  if (seconds < DAY)  return `${Math.round(seconds / HOUR)}h`;
  const d = seconds / DAY;
  return Number.isInteger(d) ? `${d}g` : `${Math.round(seconds / HOUR)}h`;
}

export interface Preset {
  id: 'daily' | 'two_days' | 'weekly' | 'custom';
  label: string;
  seconds: number;
}

export const INTERVAL_PRESETS: Preset[] = [
  { id: 'daily',    label: 'Giornaliero',    seconds: DAY },
  { id: 'two_days', label: 'Ogni 2 giorni',  seconds: 2 * DAY },
  { id: 'weekly',   label: 'Settimanale',    seconds: 7 * DAY },
  { id: 'custom',   label: 'Personalizzato', seconds: 0 },
];

export interface TimeLimits {
  intervalMin: number;
  intervalMax: number;
  graceMin:    number;
  graceMax:    number;
}

export const PROD_LIMITS: TimeLimits = {
  intervalMin: HOUR,
  intervalMax: 31 * DAY,
  graceMin:    HOUR,
  graceMax:    7 * DAY,
};

export const DEV_LIMITS: TimeLimits = {
  intervalMin: 30,
  intervalMax: 31 * DAY,
  graceMin:    10,
  graceMax:    7 * DAY,
};
