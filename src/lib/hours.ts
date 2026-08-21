/**
 * Conversion between Google's opening-hours shape and the editor's.
 *
 * Pure functions, deliberately: this is where a round-trip could quietly lose a
 * day or flatten a split shift, and the only way to be confident it does not is
 * to test it exhaustively without a browser or a network.
 *
 * Two Google conventions that are easy to get wrong:
 *   - proto3 omits zero values, so a missing `hours` means midnight, not
 *     "unspecified". Treating it as unset would drop every day that opens at
 *     00:00.
 *   - an overnight shift is expressed by `closeDay` being the following day,
 *     not by a close time that appears to precede the open time.
 */

import type { GbpTimePeriod } from '@/server/integrations/google/types';

export const DAY_KEYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export interface EditablePeriod {
  /** "HH:MM". "24:00" is Google's end-of-day. */
  open: string;
  close: string;
}

export type Schedule = Record<DayKey, EditablePeriod[]>;

export function emptySchedule(): Schedule {
  return DAY_KEYS.reduce((acc, day) => ({ ...acc, [day]: [] }), {} as Schedule);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Proto3 omits zeros, so an absent field is 0 rather than unknown. */
function formatTime(time: { hours?: number; minutes?: number } | undefined): string {
  return `${pad(time?.hours ?? 0)}:${pad(time?.minutes ?? 0)}`;
}

function parseTime(value: string): { hours: number; minutes: number } {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10));
  return { hours: Number.isFinite(hours) ? hours : 0, minutes: Number.isFinite(minutes) ? minutes : 0 };
}

function isDayKey(value: unknown): value is DayKey {
  return typeof value === 'string' && (DAY_KEYS as readonly string[]).includes(value);
}

function nextDay(day: DayKey): DayKey {
  return DAY_KEYS[(DAY_KEYS.indexOf(day) + 1) % DAY_KEYS.length];
}

/** True when the period runs past midnight into the following day. */
export function isOvernight(period: EditablePeriod): boolean {
  return period.close <= period.open && period.close !== '00:00';
}

/**
 * Builds the editor's schedule from what Google publishes.
 *
 * Periods are keyed by their OPENING day, so an overnight shift belongs to the
 * day it starts. Unrecognised days are dropped rather than guessed at.
 */
export function scheduleFromGooglePeriods(periods: unknown): Schedule {
  const schedule = emptySchedule();
  if (!Array.isArray(periods)) return schedule;

  for (const raw of periods) {
    if (!raw || typeof raw !== 'object') continue;
    const period = raw as GbpTimePeriod;
    if (!isDayKey(period.openDay)) continue;

    schedule[period.openDay].push({
      open: formatTime(period.openTime),
      close: formatTime(period.closeTime),
    });
  }

  // Stable ordering so a round-trip does not reshuffle a split shift.
  for (const day of DAY_KEYS) {
    schedule[day].sort((a, b) => a.open.localeCompare(b.open));
  }

  return schedule;
}

/**
 * Builds Google's period list from the editor's schedule.
 *
 * A day with no periods produces NOTHING, which is how Google expresses closed.
 * That is the destructive property the editor exists to make visible: omission
 * is not "leave alone", it is "closed".
 */
export function googlePeriodsFromSchedule(schedule: Schedule): Array<{
  openDay: DayKey;
  openTime: { hours: number; minutes: number };
  closeDay: DayKey;
  closeTime: { hours: number; minutes: number };
}> {
  const periods = [];

  for (const day of DAY_KEYS) {
    for (const period of schedule[day] ?? []) {
      periods.push({
        openDay: day,
        openTime: parseTime(period.open),
        closeDay: isOvernight(period) ? nextDay(day) : day,
        closeTime: parseTime(period.close),
      });
    }
  }

  return periods;
}

/** Days the change would close that the profile currently shows as open. */
export function daysBeingClosed(current: Schedule, proposed: Schedule): DayKey[] {
  return DAY_KEYS.filter((day) => current[day].length > 0 && proposed[day].length === 0);
}
