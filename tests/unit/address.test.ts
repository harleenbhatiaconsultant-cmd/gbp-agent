/**
 * Address helpers.
 *
 * The diff is the safety feature here: it is what an approver reads before
 * authorizing the single edit most likely to take a listing offline. A diff
 * that is subtly wrong is worse than none, because it gives false confidence.
 */

import { describe, it, expect } from 'vitest';
import {
  addressFromGoogle,
  diffAddress,
  emptyAddress,
  isEmptyAddress,
  validateAddress,
} from '@/lib/address';

const portland = {
  regionCode: 'US',
  postalCode: '97205',
  administrativeArea: 'OR',
  locality: 'Portland',
  addressLines: ['1200 NW 23rd Ave'],
};

describe('reading Google addresses', () => {
  it('maps a complete address', () => {
    const address = addressFromGoogle(portland);

    expect(address.regionCode).toBe('US');
    expect(address.locality).toBe('Portland');
    expect(address.addressLines).toEqual(['1200 NW 23rd Ave']);
  });

  it('always yields at least one address line so the form has a field', () => {
    expect(addressFromGoogle({ regionCode: 'US' }).addressLines).toEqual(['']);
  });

  it('survives malformed input', () => {
    expect(addressFromGoogle(undefined)).toEqual(emptyAddress());
    expect(addressFromGoogle('nonsense')).toEqual(emptyAddress());
    expect(addressFromGoogle({ addressLines: [1, null, 'ok'] }).addressLines).toEqual(['ok']);
  });
});

describe('diffing', () => {
  it('reports nothing when nothing changed', () => {
    const address = addressFromGoogle(portland);
    expect(diffAddress(address, address)).toEqual([]);
  });

  it('ignores whitespace-only differences', () => {
    // Otherwise the editor would show a change for a stray trailing space and
    // train people to ignore the diff.
    const current = addressFromGoogle(portland);
    const proposed = { ...current, locality: '  Portland  ' };
    expect(diffAddress(current, proposed)).toEqual([]);
  });

  it('names the field, the old value and the new one', () => {
    const current = addressFromGoogle(portland);
    const proposed = { ...current, locality: 'Beaverton' };

    const [change] = diffAddress(current, proposed);

    expect(change.field).toBe('locality');
    expect(change.label).toBe('City');
    expect(change.from).toBe('Portland');
    expect(change.to).toBe('Beaverton');
  });

  it('treats a changed street line as one change, not a per-line diff', () => {
    const current = addressFromGoogle(portland);
    const proposed = { ...current, addressLines: ['500 SW 5th Ave'] };

    const changes = diffAddress(current, proposed);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('addressLines');
  });

  it('detects an added second line', () => {
    const current = addressFromGoogle(portland);
    const proposed = { ...current, addressLines: ['1200 NW 23rd Ave', 'Suite 400'] };

    const [change] = diffAddress(current, proposed);
    expect(change.to).toContain('Suite 400');
  });

  it('ignores empty lines added by the form', () => {
    // Clicking "add line" and not filling it must not register as a change.
    const current = addressFromGoogle(portland);
    const proposed = { ...current, addressLines: ['1200 NW 23rd Ave', '', '  '] };
    expect(diffAddress(current, proposed)).toEqual([]);
  });

  it('flags a country change, which is the most consequential edit', () => {
    const current = addressFromGoogle(portland);
    const proposed = { ...current, regionCode: 'GB' };

    const changes = diffAddress(current, proposed);
    expect(changes.some((c) => c.field === 'regionCode')).toBe(true);
  });

  it('reports several changed fields at once', () => {
    const current = addressFromGoogle(portland);
    const proposed = { ...current, locality: 'Beaverton', postalCode: '97005' };

    expect(diffAddress(current, proposed)).toHaveLength(2);
  });
});

describe('isEmptyAddress', () => {
  it('recognises a profile with no storefront', () => {
    expect(isEmptyAddress(emptyAddress())).toBe(true);
  });

  it('does not treat a real address as empty', () => {
    expect(isEmptyAddress(addressFromGoogle(portland))).toBe(false);
  });

  it('ignores a country code on its own', () => {
    // A service-area business often carries a region code and nothing else.
    expect(isEmptyAddress({ ...emptyAddress(), regionCode: 'US' })).toBe(true);
  });
});

describe('validation', () => {
  it('accepts a well-formed address', () => {
    expect(validateAddress(addressFromGoogle(portland))).toEqual([]);
  });

  it('requires a two-letter country code', () => {
    const problems = validateAddress({ ...addressFromGoogle(portland), regionCode: 'USA' });
    expect(problems.some((p) => /two-letter/i.test(p))).toBe(true);
  });

  it('requires at least one street line', () => {
    const problems = validateAddress({ ...addressFromGoogle(portland), addressLines: ['', ' '] });
    expect(problems.some((p) => /street address line/i.test(p))).toBe(true);
  });

  it('rejects more than five lines, which Google refuses', () => {
    const problems = validateAddress({
      ...addressFromGoogle(portland),
      addressLines: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(problems.some((p) => /five address lines/i.test(p))).toBe(true);
  });

  it('does not invent requirements that vary by country', () => {
    // Plenty of countries have no postal code or state. Demanding them here
    // would block legitimate addresses that Google accepts.
    const problems = validateAddress({
      ...addressFromGoogle(portland),
      postalCode: '',
      administrativeArea: '',
    });
    expect(problems).toEqual([]);
  });
});
