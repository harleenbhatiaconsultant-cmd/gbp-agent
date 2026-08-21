/**
 * Shapes returned by the Google Business Profile APIs.
 *
 * Hand-written rather than generated: only the fields this platform reads are
 * modelled, everything is optional because Google omits empty fields, and the
 * raw payload is stored verbatim in LocationSnapshot regardless. Treat these as
 * a typed view over untrusted external data, not a contract.
 */

export interface GbpAccountResource {
  /** e.g. "accounts/123456789" */
  name: string;
  accountName?: string;
  type?: string;
  role?: string;
  verificationState?: string;
  vettedState?: string;
}

export interface GbpPostalAddress {
  regionCode?: string;
  languageCode?: string;
  postalCode?: string;
  administrativeArea?: string;
  locality?: string;
  addressLines?: string[];
}

export interface GbpCategory {
  name?: string;
  displayName?: string;
}

export interface GbpCategories {
  primaryCategory?: GbpCategory;
  additionalCategories?: GbpCategory[];
}

export interface GbpTimePeriod {
  openDay?: string;
  openTime?: { hours?: number; minutes?: number };
  closeDay?: string;
  closeTime?: { hours?: number; minutes?: number };
}

export interface GbpBusinessHours {
  periods?: GbpTimePeriod[];
}

export interface GbpSpecialHourPeriod {
  startDate?: { year?: number; month?: number; day?: number };
  endDate?: { year?: number; month?: number; day?: number };
  openTime?: { hours?: number; minutes?: number };
  closeTime?: { hours?: number; minutes?: number };
  closed?: boolean;
}

export interface GbpSpecialHours {
  specialHourPeriods?: GbpSpecialHourPeriod[];
}

export interface GbpServiceArea {
  businessType?: string;
  places?: { placeInfos?: Array<{ placeName?: string; placeId?: string }> };
  regionCode?: string;
}

export interface GbpLocationMetadata {
  hasGoogleUpdated?: boolean;
  hasPendingEdits?: boolean;
  canDelete?: boolean;
  canOperateLocalPost?: boolean;
  canHaveFoodMenus?: boolean;
  placeId?: string;
  mapsUri?: string;
  newReviewUri?: string;
  duplicateLocation?: string;
}

export interface GbpLocationResource {
  /** e.g. "locations/987654321" */
  name: string;
  languageCode?: string;
  storeCode?: string;
  title?: string;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] };
  categories?: GbpCategories;
  storefrontAddress?: GbpPostalAddress;
  websiteUri?: string;
  regularHours?: GbpBusinessHours;
  specialHours?: GbpSpecialHours;
  moreHours?: unknown[];
  serviceArea?: GbpServiceArea;
  labels?: string[];
  latlng?: { latitude?: number; longitude?: number };
  openInfo?: { status?: string; canReopen?: boolean; openingDate?: unknown };
  metadata?: GbpLocationMetadata;
  profile?: { description?: string };
  serviceItems?: unknown[];
  relationshipData?: unknown;
}

/**
 * Fields requested from the Business Information API.
 *
 * `readMask` is REQUIRED by that API — omitting it is an error, not a default —
 * and only listed fields are returned. Adding an audit rule that inspects a new
 * field means adding it here too, or the rule silently sees `undefined`.
 */
export const LOCATION_READ_MASK = [
  'name',
  'languageCode',
  'storeCode',
  'title',
  'phoneNumbers',
  'categories',
  'storefrontAddress',
  'websiteUri',
  'regularHours',
  'specialHours',
  'moreHours',
  'serviceArea',
  'labels',
  'latlng',
  'openInfo',
  'metadata',
  'profile',
  'serviceItems',
].join(',');

/**
 * A category from Google's own taxonomy.
 *
 * Category IDs (`gcid:dentist`) are not free text — Google rejects anything not
 * in its list, and the list is regional and localized. That is why the editor
 * searches Google rather than letting someone type an id and hope.
 */
export interface GbpCategoryResource {
  /** e.g. "gcid:dentist" */
  name: string;
  displayName?: string;
  serviceTypes?: Array<{ serviceTypeId?: string; displayName?: string }>;
  moreHoursTypes?: unknown[];
}

export interface GbpListCategoriesResponse {
  categories?: GbpCategoryResource[];
  nextPageToken?: string;
  totalCategoryCount?: number;
}

export interface GbpListAccountsResponse {
  accounts?: GbpAccountResource[];
  nextPageToken?: string;
}

export interface GbpListLocationsResponse {
  locations?: GbpLocationResource[];
  nextPageToken?: string;
  totalSize?: number;
}
