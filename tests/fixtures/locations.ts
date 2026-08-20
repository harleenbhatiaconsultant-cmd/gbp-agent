/**
 * Location fixtures for audit rule tests.
 *
 * These are shaped like real Business Information API responses, including the
 * habit of omitting empty fields entirely rather than returning nulls — which
 * is the case rules most often get wrong.
 */

import type { GbpLocationResource } from '@/server/integrations/google/types';

/** A well-maintained profile that should pass every profile-scoped rule. */
export const healthyLocation: GbpLocationResource = {
  name: 'locations/11111111111111111111',
  languageCode: 'en',
  storeCode: 'HQ-001',
  title: 'Northside Dental Care',
  phoneNumbers: { primaryPhone: '+1 555-0100' },
  categories: {
    primaryCategory: { name: 'gcid:dentist', displayName: 'Dentist' },
    additionalCategories: [
      { name: 'gcid:dental_clinic', displayName: 'Dental clinic' },
      { name: 'gcid:cosmetic_dentist', displayName: 'Cosmetic dentist' },
    ],
  },
  storefrontAddress: {
    regionCode: 'US',
    postalCode: '97205',
    administrativeArea: 'OR',
    locality: 'Portland',
    addressLines: ['1200 NW 23rd Ave'],
  },
  websiteUri: 'https://northsidedental.example/portland',
  regularHours: {
    periods: [
      { openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 17 } },
      { openDay: 'TUESDAY', openTime: { hours: 9 }, closeDay: 'TUESDAY', closeTime: { hours: 17 } },
      {
        openDay: 'WEDNESDAY',
        openTime: { hours: 9 },
        closeDay: 'WEDNESDAY',
        closeTime: { hours: 17 },
      },
      {
        openDay: 'THURSDAY',
        openTime: { hours: 9 },
        closeDay: 'THURSDAY',
        closeTime: { hours: 17 },
      },
      { openDay: 'FRIDAY', openTime: { hours: 9 }, closeDay: 'FRIDAY', closeTime: { hours: 15 } },
    ],
  },
  specialHours: {
    specialHourPeriods: [
      { startDate: { year: 2030, month: 12, day: 25 }, closed: true },
    ],
  },
  latlng: { latitude: 45.5312, longitude: -122.6987 },
  openInfo: { status: 'OPEN', canReopen: true },
  metadata: {
    hasGoogleUpdated: false,
    hasPendingEdits: false,
    placeId: 'ChIJexample',
  },
  profile: {
    description:
      'Northside Dental Care has served the Portland area since 2004, offering general and cosmetic ' +
      'dentistry for families. Our team provides routine cleanings, restorative work, whitening and ' +
      'emergency appointments, with evening availability on request and parking on site.',
  },
  serviceItems: [{ displayName: 'Teeth cleaning' }, { displayName: 'Teeth whitening' }],
};

/** A neglected profile that should trip most rules. */
export const neglectedLocation: GbpLocationResource = {
  name: 'locations/22222222222222222222',
  title: 'Corner Auto Repair',
  categories: {},
  openInfo: { status: 'OPEN' },
  metadata: { hasGoogleUpdated: true, hasPendingEdits: true },
};

/** A profile Google has marked permanently closed. */
export const closedLocation: GbpLocationResource = {
  ...healthyLocation,
  name: 'locations/33333333333333333333',
  title: 'Old Town Bakery',
  openInfo: { status: 'CLOSED_PERMANENTLY' },
};

/** A service-area business: no storefront, but a defined coverage area. */
export const serviceAreaLocation: GbpLocationResource = {
  ...healthyLocation,
  name: 'locations/44444444444444444444',
  title: 'Rapid Response Plumbing',
  storefrontAddress: undefined,
  serviceArea: {
    businessType: 'CUSTOMER_LOCATION_ONLY',
    places: {
      placeInfos: [{ placeName: 'Portland, OR', placeId: 'ChIJportland' }],
    },
  },
};
