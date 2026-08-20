-- Append-only enforcement for the compliance tables.
--
-- ChangeLog, AuditEvent and PolicyViolation are the platform's permanent record
-- of what was changed, who acted, and which guardrails fired. They exist to be
-- trusted by a customer, an auditor, or a regulator — which requires that no
-- application bug, no ORM misuse and no future refactor can rewrite history.
--
-- The Prisma extension in src/server/db/client.ts blocks these operations too,
-- but that is a developer-experience guard. THIS is the actual boundary: it
-- holds even for raw SQL, psql sessions and any other client.
--
-- Deliberately NOT blocked: INSERT (that is the point) and TRUNCATE at the
-- superuser level (needed for test-database teardown; see below).

CREATE OR REPLACE FUNCTION gbp_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Table "%" is append-only; % is not permitted. These rows are the platform compliance trail.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ChangeLog — the client-facing "what we did" history.
CREATE TRIGGER "ChangeLog_append_only"
  BEFORE UPDATE OR DELETE ON "ChangeLog"
  FOR EACH ROW EXECUTE FUNCTION gbp_reject_mutation();

-- AuditEvent — the security and authorization trail.
CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION gbp_reject_mutation();

-- PolicyViolation — every guardrail block, kept as proof of refusal.
CREATE TRIGGER "PolicyViolation_append_only"
  BEFORE UPDATE OR DELETE ON "PolicyViolation"
  FOR EACH ROW EXECUTE FUNCTION gbp_reject_mutation();

-- Note on cascades: these tables reference Organization with ON DELETE CASCADE.
-- Deleting an organization would therefore hit the DELETE trigger. That is
-- intentional for now — tenant deletion must be an explicit, audited procedure
-- that archives the compliance trail before removing the tenant, not a silent
-- cascade. The procedure is added in the data-retention phase; until then,
-- organization deletion will correctly fail rather than quietly destroy records.
