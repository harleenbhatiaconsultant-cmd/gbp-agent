/**
 * Append-only compliance tables.
 *
 * ChangeLog, AuditEvent and PolicyViolation are the platform's permanent record
 * of what was changed, who acted, and which guardrails fired. They are only
 * worth anything if they cannot be rewritten — so both enforcement layers are
 * tested here:
 *
 *   1. The Prisma extension, which fails fast during development.
 *   2. The database triggers, which hold even for raw SQL.
 *
 * If either layer is ever removed, one of these tests goes red.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { prisma, APPEND_ONLY_MODELS } from '@/server/db/client';
import { AppendOnlyViolationError } from '@/server/errors';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Prisma extension guard', () => {
  it('lists the three compliance tables', () => {
    expect([...APPEND_ONLY_MODELS].sort()).toEqual([
      'AuditEvent',
      'ChangeLog',
      'PolicyViolation',
    ]);
  });

  // These reject before any SQL is issued, so no fixture rows are needed.
  it('rejects update on AuditEvent', async () => {
    await expect(
      prisma.auditEvent.update({ where: { id: 'nonexistent' }, data: { action: 'tampered' } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('rejects delete on ChangeLog', async () => {
    await expect(
      prisma.changeLog.delete({ where: { id: 'nonexistent' } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('rejects deleteMany on PolicyViolation', async () => {
    await expect(prisma.policyViolation.deleteMany({})).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
  });

  it('rejects updateMany on AuditEvent', async () => {
    await expect(
      prisma.auditEvent.updateMany({ where: {}, data: { action: 'tampered' } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
  });

  it('still permits reads', async () => {
    await expect(prisma.auditEvent.findMany({ take: 1 })).resolves.toBeInstanceOf(Array);
  });
});

describe('database trigger guard', () => {
  /**
   * Raw SQL bypasses the Prisma extension entirely, which is exactly the point:
   * this exercises the trigger. The whole thing runs inside a transaction that
   * is always rolled back, so no rows survive the test.
   */
  it('rejects UPDATE on AuditEvent even through raw SQL', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
          VALUES ('org_append_test', 'Append Test', 'append-test', now(), now())`;
        await tx.$executeRaw`
          INSERT INTO "AuditEvent" (id, "organizationId", action, "subjectType", "createdAt")
          VALUES ('ae_append_test', 'org_append_test', 'test.action', 'Test', now())`;
        // The trigger raises here, aborting and rolling back the transaction.
        await tx.$executeRaw`
          UPDATE "AuditEvent" SET action = 'tampered' WHERE id = 'ae_append_test'`;
      }),
    ).rejects.toThrow(/append-only/i);

    // Rollback means the fixture organization never existed.
    expect(
      await prisma.organization.findUnique({ where: { id: 'org_append_test' } }),
    ).toBeNull();
  });

  it('rejects DELETE on AuditEvent even through raw SQL', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
          VALUES ('org_append_test2', 'Append Test 2', 'append-test-2', now(), now())`;
        await tx.$executeRaw`
          INSERT INTO "AuditEvent" (id, "organizationId", action, "subjectType", "createdAt")
          VALUES ('ae_append_test2', 'org_append_test2', 'test.action', 'Test', now())`;
        await tx.$executeRaw`DELETE FROM "AuditEvent" WHERE id = 'ae_append_test2'`;
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('permits INSERT — appending is the whole point', async () => {
    let insertedCount = 0;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
          VALUES ('org_append_test3', 'Append Test 3', 'append-test-3', now(), now())`;
        insertedCount = await tx.$executeRaw`
          INSERT INTO "AuditEvent" (id, "organizationId", action, "subjectType", "createdAt")
          VALUES ('ae_append_test3', 'org_append_test3', 'test.action', 'Test', now())`;
        throw new Error('__rollback__');
      }),
    ).rejects.toThrow('__rollback__');

    expect(insertedCount).toBe(1);
  });
});
