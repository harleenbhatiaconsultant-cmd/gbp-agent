/**
 * Address comparison helpers.
 *
 * Pure, because the address editor's whole job is showing someone exactly what
 * they are about to change before they change it. A diff that is subtly wrong
 * is worse than no diff — it would give false confidence about the single
 * field most likely to take a listing offline.
 */

export interface EditableAddress {
  regionCode: string;
  addressLines: string[];
  locality: string;
  administrativeArea: string;
  postalCode: string;
  languageCode: string;
}

export function emptyAddress(): EditableAddress {
  return {
    regionCode: '',
    addressLines: [''],
    locality: '',
    administrativeArea: '',
    postalCode: '',
    languageCode: '',
  };
}

/** Reads Google's PostalAddress into the editor's shape. */
export function addressFromGoogle(value: unknown): EditableAddress {
  const empty = emptyAddress();
  if (!value || typeof value !== 'object') return empty;

  const address = value as {
    regionCode?: string;
    addressLines?: unknown;
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    languageCode?: string;
  };

  const lines = Array.isArray(address.addressLines)
    ? address.addressLines.filter((line): line is string => typeof line === 'string')
    : [];

  return {
    regionCode: address.regionCode ?? '',
    // Always at least one line so the form has a field to render.
    addressLines: lines.length > 0 ? lines : [''],
    locality: address.locality ?? '',
    administrativeArea: address.administrativeArea ?? '',
    postalCode: address.postalCode ?? '',
    languageCode: address.languageCode ?? '',
  };
}

export interface AddressFieldChange {
  field: keyof EditableAddress;
  label: string;
  from: string;
  to: string;
}

const FIELD_LABELS: Record<keyof EditableAddress, string> = {
  addressLines: 'Street address',
  locality: 'City',
  administrativeArea: 'State / region',
  postalCode: 'Postal code',
  regionCode: 'Country',
  languageCode: 'Language',
};

function normalizeLines(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

/** Field-by-field diff, for showing what is actually changing. */
export function diffAddress(
  current: EditableAddress,
  proposed: EditableAddress,
): AddressFieldChange[] {
  const changes: AddressFieldChange[] = [];

  const compare = (field: keyof EditableAddress, from: string, to: string) => {
    if (from.trim() !== to.trim()) {
      changes.push({ field, label: FIELD_LABELS[field], from, to });
    }
  };

  compare('addressLines', normalizeLines(current.addressLines), normalizeLines(proposed.addressLines));
  compare('locality', current.locality, proposed.locality);
  compare('administrativeArea', current.administrativeArea, proposed.administrativeArea);
  compare('postalCode', current.postalCode, proposed.postalCode);
  compare('regionCode', current.regionCode, proposed.regionCode);

  return changes;
}

/** True when the profile has no storefront address at all today. */
export function isEmptyAddress(address: EditableAddress): boolean {
  return (
    normalizeLines(address.addressLines) === '' &&
    address.locality.trim() === '' &&
    address.postalCode.trim() === ''
  );
}

/**
 * Blocking problems, as opposed to stylistic ones.
 *
 * Google requires a country and at least one street line; the rest varies by
 * country and is left to Google to reject rather than guessed at here.
 */
export function validateAddress(address: EditableAddress): string[] {
  const problems: string[] = [];

  if (!/^[A-Za-z]{2}$/.test(address.regionCode.trim())) {
    problems.push('Country must be a two-letter code, such as US or GB.');
  }
  if (normalizeLines(address.addressLines) === '') {
    problems.push('At least one street address line is required.');
  }
  if (address.addressLines.filter((line) => line.trim()).length > 5) {
    problems.push('Google accepts at most five address lines.');
  }

  return problems;
}
