/**
 * Development seed.
 *
 * Creates a demo organization with two locations and snapshots, so the audit
 * engine can be exercised end to end before Google API access is approved.
 *
 * This is a DEVELOPMENT AFFORDANCE, not a mock layer inside the application:
 * it writes ordinary rows through the ordinary schema, and the audit that runs
 * against them is the real engine doing real work. Once a Google connection
 * exists, real snapshots replace these and nothing in the app changes.
 *
 * Refuses to run against production.
 */

import 'dotenv/config';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { contentHash } from '../src/lib/hash';
import { MemberRole } from '../src/generated/prisma/enums';
import type { GbpLocationResource } from '../src/server/integrations/google/types';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@example.com';
const ORG_SLUG = 'demo-agency';

/** A well-maintained profile — should score highly. */
const healthyProfile: GbpLocationResource = {
  name: 'locations/seed-healthy-0001',
  title: 'Northside Dental Care',
  storeCode: 'HQ-001',
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
    periods: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((day) => ({
      openDay: day,
      openTime: { hours: 9 },
      closeDay: day,
      closeTime: { hours: 17 },
    })),
  },
  specialHours: {
    specialHourPeriods: [{ startDate: { year: 2030, month: 12, day: 25 }, closed: true }],
  },
  latlng: { latitude: 45.5312, longitude: -122.6987 },
  openInfo: { status: 'OPEN' },
  metadata: { hasGoogleUpdated: false, hasPendingEdits: false, placeId: 'ChIJseedhealthy' },
  profile: {
    description:
      'Northside Dental Care has served the Portland area since 2004, offering general and cosmetic ' +
      'dentistry for families. Our team provides routine cleanings, restorative work, whitening and ' +
      'emergency appointments, with evening availability on request and parking on site.',
  },
  serviceItems: [{ displayName: 'Teeth cleaning' }, { displayName: 'Teeth whitening' }],
};

/** A neglected profile — should trip most rules. */
const neglectedProfile: GbpLocationResource = {
  name: 'locations/seed-neglected-0002',
  title: 'Corner Auto Repair',
  categories: {},
  openInfo: { status: 'OPEN' },
  metadata: { hasGoogleUpdated: true, hasPendingEdits: true, placeId: 'ChIJseedneglected' },
};

async function main() {
  console.log(`Seeding demo data into ${connectionString!.replace(/:[^:@/]*@/, ':***@')}`);

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, name: 'Demo User', emailVerified: new Date() },
  });

  const organization = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: { name: 'Demo Agency', slug: ORG_SLUG },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    update: { role: MemberRole.OWNER },
    create: { userId: user.id, organizationId: organization.id, role: MemberRole.OWNER },
  });

  // A placeholder connection so locations have a parent. It holds no usable
  // credential — the ciphertext is deliberately invalid, so any attempt to
  // actually call Google with it fails loudly rather than pretending to work.
  const connection = await prisma.googleConnection.upsert({
    where: {
      organizationId_googleAccountEmail: {
        organizationId: organization.id,
        googleAccountEmail: 'seed@example.com',
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      googleAccountEmail: 'seed@example.com',
      encryptedRefreshToken: 'v0.seed.seed.not-a-real-token',
      encryptionKeyVersion: 0,
      scopes: ['https://www.googleapis.com/auth/business.manage'],
    },
  });

  const account =
    (await prisma.gbpAccount.findFirst({
      where: { organizationId: organization.id, googleAccountName: 'accounts/seed-0001' },
    })) ??
    (await prisma.gbpAccount.create({
      data: {
        organizationId: organization.id,
        connectionId: connection.id,
        googleAccountName: 'accounts/seed-0001',
        accountName: 'Demo Google Account',
      },
    }));

  for (const profile of [healthyProfile, neglectedProfile]) {
    const existing = await prisma.location.findFirst({
      where: { organizationId: organization.id, googleLocationName: profile.name },
    });

    const location =
      existing ??
      (await prisma.location.create({
        data: {
          organizationId: organization.id,
          gbpAccountId: account.id,
          googleLocationName: profile.name,
          title: profile.title ?? '(untitled)',
          primaryCategoryName: profile.categories?.primaryCategory?.displayName ?? null,
          primaryCategoryId: profile.categories?.primaryCategory?.name ?? null,
          websiteUri: profile.websiteUri ?? null,
          phone: profile.phoneNumbers?.primaryPhone ?? null,
          profileDescription: profile.profile?.description ?? null,
          address: (profile.storefrontAddress ?? {}) as unknown as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
          syncStatus: 'SYNCED',
        },
      }));

    const hash = contentHash(profile);
    const latest = await prisma.locationSnapshot.findFirst({
      where: { locationId: location.id },
      orderBy: { capturedAt: 'desc' },
    });

    if (latest?.contentHash !== hash) {
      await prisma.locationSnapshot.create({
        data: {
          organizationId: organization.id,
          locationId: location.id,
          rawPayload: profile as unknown as Prisma.InputJsonValue,
          contentHash: hash,
          source: 'SEED',
        },
      });
    }

    console.log(`  seeded location: ${profile.title}`);
  }

  console.log(`\nDone. Sign in as ${DEMO_EMAIL} and open /${ORG_SLUG}/locations`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
