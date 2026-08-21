/**
 * Opening-hours conversion.
 *
 * The update mask replaces `regularHours` wholesale, so anything this
 * conversion drops on the way in gets published as CLOSED on the way out. A
 * round-trip that loses a split shift or an overnight close does not fail
 * loudly — it quietly shuts a business. Hence the exhaustive round-trip tests.
 */

import { describe, it, expect } from 'vitest';
import {
  DAY_KEYS,
  emptySchedule,
  isOvernight,
  scheduleFromGooglePeriods,
  googlePeriodsFromSchedule,
  daysBeingClosed,
  type Schedule,
} from '@/lib/hours';

const nineToFive = (day: string) => ({
  openDay: day,
  openTime: { hours: 9, minutes: 0 },
  closeDay: day,
  closeTime: { hours: 17, minutes: 0 },
});

describe('reading Google periods', () => {
  it('maps a simple weekday schedule', () => {
    const schedule = scheduleFromGooglePeriods([
      nineToFive('MONDAY'),
      nineToFive('TUESDAY'),
    ]);

    expect(schedule.MONDAY).toEqual([{ open: '09:00', close: '17:00' }]);
    expect(schedule.TUESDAY).toEqual([{ open: '09:00', close: '17:00' }]);
    expect(schedule.WEDNESDAY).toEqual([]);
  });

  it('treats an omitted hours field as midnight, not as unset', () => {
    // proto3 omits zero values. Reading `undefined` as "no value" would drop
    // every business that opens at midnight.
    const schedule = scheduleFromGooglePeriods([
      { openDay: 'MONDAY', openTime: {}, closeDay: 'MONDAY', closeTime: { hours: 17 } },
    ]);

    expect(schedule.MONDAY).toEqual([{ open: '00:00', close: '17:00' }]);
  });

  it('keeps a split shift as two periods', () => {
    const schedule = scheduleFromGooglePeriods([
      {
        openDay: 'MONDAY',
        openTime: { hours: 9 },
        closeDay: 'MONDAY',
        closeTime: { hours: 13 },
      },
      {
        openDay: 'MONDAY',
        openTime: { hours: 17 },
        closeDay: 'MONDAY',
        closeTime: { hours: 22 },
      },
    ]);

    expect(schedule.MONDAY).toHaveLength(2);
    expect(schedule.MONDAY[0].open).toBe('09:00');
    expect(schedule.MONDAY[1].open).toBe('17:00');
  });

  it('files an overnight shift under the day it opens', () => {
    const schedule = scheduleFromGooglePeriods([
      {
        openDay: 'FRIDAY',
        openTime: { hours: 22 },
        closeDay: 'SATURDAY',
        closeTime: { hours: 2 },
      },
    ]);

    expect(schedule.FRIDAY).toEqual([{ open: '22:00', close: '02:00' }]);
    expect(schedule.SATURDAY).toEqual([]);
  });

  it('reads a 24-hour day', () => {
    const schedule = scheduleFromGooglePeriods([
      {
        openDay: 'MONDAY',
        openTime: {},
        closeDay: 'MONDAY',
        closeTime: { hours: 24 },
      },
    ]);
    expect(schedule.MONDAY).toEqual([{ open: '00:00', close: '24:00' }]);
  });

  it('survives malformed input without throwing', () => {
    expect(scheduleFromGooglePeriods(undefined)).toEqual(emptySchedule());
    expect(scheduleFromGooglePeriods('nonsense')).toEqual(emptySchedule());
    expect(scheduleFromGooglePeriods([null, 42, { openDay: 'NOTADAY' }])).toEqual(
      emptySchedule(),
    );
  });
});

describe('writing Google periods', () => {
  it('omits closed days entirely — that is how Google expresses closed', () => {
    const schedule = emptySchedule();
    schedule.MONDAY = [{ open: '09:00', close: '17:00' }];

    const periods = googlePeriodsFromSchedule(schedule);

    expect(periods).toHaveLength(1);
    expect(periods[0].openDay).toBe('MONDAY');
  });

  it('produces an empty list when every day is closed', () => {
    // The destructive case the editor warns about. It must be expressible —
    // a business really can be closed — but never by accident.
    expect(googlePeriodsFromSchedule(emptySchedule())).toEqual([]);
  });

  it('rolls an overnight close to the following day', () => {
    const schedule = emptySchedule();
    schedule.FRIDAY = [{ open: '22:00', close: '02:00' }];

    const [period] = googlePeriodsFromSchedule(schedule);

    expect(period.openDay).toBe('FRIDAY');
    expect(period.closeDay).toBe('SATURDAY');
  });

  it('wraps Sunday overnight round to Monday', () => {
    const schedule = emptySchedule();
    schedule.SUNDAY = [{ open: '23:00', close: '01:00' }];

    const [period] = googlePeriodsFromSchedule(schedule);
    expect(period.closeDay).toBe('MONDAY');
  });

  it('does not treat a 24-hour day as overnight', () => {
    const schedule = emptySchedule();
    schedule.MONDAY = [{ open: '00:00', close: '24:00' }];

    const [period] = googlePeriodsFromSchedule(schedule);

    expect(period.closeDay).toBe('MONDAY');
    expect(period.closeTime).toEqual({ hours: 24, minutes: 0 });
  });
});

describe('round trip', () => {
  it('preserves a full week including split and overnight shifts', () => {
    // Annotated so the heterogeneous literals do not widen to a union that
    // hides `minutes` from the assertion below.
    const original: Array<{
      openDay: string;
      openTime: { hours?: number; minutes?: number };
      closeDay: string;
      closeTime: { hours?: number; minutes?: number };
    }> = [
      // Weekday split shift.
      { openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 13 } },
      { openDay: 'MONDAY', openTime: { hours: 14 }, closeDay: 'MONDAY', closeTime: { hours: 18 } },
      // Ordinary day.
      nineToFive('TUESDAY'),
      // Overnight into Saturday.
      { openDay: 'FRIDAY', openTime: { hours: 20 }, closeDay: 'SATURDAY', closeTime: { hours: 2 } },
      // Never closes.
      { openDay: 'SUNDAY', openTime: {}, closeDay: 'SUNDAY', closeTime: { hours: 24 } },
    ];

    const roundTripped = googlePeriodsFromSchedule(scheduleFromGooglePeriods(original));

    expect(roundTripped).toHaveLength(original.length);

    // Every original period survives with its day boundaries intact.
    for (const period of original) {
      expect(roundTripped).toContainEqual({
        openDay: period.openDay,
        openTime: { hours: period.openTime.hours ?? 0, minutes: period.openTime.minutes ?? 0 },
        closeDay: period.closeDay,
        closeTime: { hours: period.closeTime.hours ?? 0, minutes: period.closeTime.minutes ?? 0 },
      });
    }
  });

  it('is stable across repeated round trips', () => {
    const once = scheduleFromGooglePeriods([nineToFive('MONDAY'), nineToFive('WEDNESDAY')]);
    const twice = scheduleFromGooglePeriods(googlePeriodsFromSchedule(once));
    expect(twice).toEqual(once);
  });

  it('never invents a day that was not there', () => {
    const schedule = scheduleFromGooglePeriods([nineToFive('MONDAY')]);
    const periods = googlePeriodsFromSchedule(schedule);
    expect(periods.map((p) => p.openDay)).toEqual(['MONDAY']);
  });
});

describe('daysBeingClosed', () => {
  it('names days that go from open to closed', () => {
    const current: Schedule = emptySchedule();
    current.MONDAY = [{ open: '09:00', close: '17:00' }];
    current.TUESDAY = [{ open: '09:00', close: '17:00' }];

    const proposed: Schedule = emptySchedule();
    proposed.MONDAY = [{ open: '09:00', close: '17:00' }];

    expect(daysBeingClosed(current, proposed)).toEqual(['TUESDAY']);
  });

  it('does not report a day that was already closed', () => {
    expect(daysBeingClosed(emptySchedule(), emptySchedule())).toEqual([]);
  });

  it('does not report a day being opened', () => {
    const proposed = emptySchedule();
    proposed.MONDAY = [{ open: '09:00', close: '17:00' }];
    expect(daysBeingClosed(emptySchedule(), proposed)).toEqual([]);
  });
});

describe('isOvernight', () => {
  it('detects a close before the open', () => {
    expect(isOvernight({ open: '22:00', close: '02:00' })).toBe(true);
  });

  it('does not flag an ordinary day', () => {
    expect(isOvernight({ open: '09:00', close: '17:00' })).toBe(false);
  });

  it('does not flag a 24-hour day', () => {
    expect(isOvernight({ open: '00:00', close: '24:00' })).toBe(false);
  });
});

describe('day keys', () => {
  it('covers the week in order, starting Monday', () => {
    expect(DAY_KEYS).toHaveLength(7);
    expect(DAY_KEYS[0]).toBe('MONDAY');
    expect(DAY_KEYS[6]).toBe('SUNDAY');
  });
});
