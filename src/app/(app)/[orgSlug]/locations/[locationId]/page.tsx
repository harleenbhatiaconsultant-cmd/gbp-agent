import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ActionType, FindingStatus } from "@/generated/prisma/enums";
import { resolveTenantContext } from "@/server/auth/session";
import { getLocation, syncLocation } from "@/server/services/locations";
import { runLocationAudit, getLatestAuditRun, listAuditHistory } from "@/server/services/audits";
import { proposeChange, getChangeLog } from "@/server/services/changes";
import { can } from "@/server/auth/rbac";
import { isAppError } from "@/server/errors";
import { ProposeFix, isProposable } from "@/components/features/propose-fix";
import { CategoryEditor, type CategoryOption } from "@/components/features/category-editor";
import { searchCategories, type CategorySearchResult } from "@/server/services/categories";
import type { HealthScore as HealthScoreShape } from "@/server/audit/scoring";
import { HealthScore } from "@/components/features/health-score";
import { FindingsList } from "@/components/features/findings-list";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/** Projects the stored secondaryCategories JSON onto the editor's shape. */
function toCategoryOptions(value: unknown): CategoryOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const category = entry as { name?: string; displayName?: string };
      if (!category.name) return null;
      return { id: category.name, displayName: category.displayName ?? category.name };
    })
    .filter((option): option is CategoryOption => option !== null);
}

async function runAuditAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const locationId = String(formData.get("locationId"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/locations/${locationId}`;

  try {
    const summary = await runLocationAudit(ctx, locationId);
    revalidatePath(path);
    redirect(`${path}?audited=${summary.findingsOpened}&resolved=${summary.findingsResolved}`);
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Audit failed.")}`);
    }
    throw error;
  }
}

/**
 * Turns a finding into a change proposal.
 *
 * The payload is assembled here from the form, never inferred: the value and
 * its source are both supplied by a person, which is what the fabrication
 * guard requires for factual fields.
 */
async function proposeFixAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const locationId = String(formData.get("locationId"));
  const actionType = String(formData.get("actionType")) as ActionType;
  const value = String(formData.get("value") ?? "").trim();
  const sourceRef = {
    kind: String(formData.get("sourceKind") ?? "USER_INPUT"),
    detail: String(formData.get("sourceDetail") ?? "").trim(),
  };
  const path = `/${orgSlug}/locations/${locationId}`;

  const payloadByAction: Record<string, Record<string, unknown>> = {
    UPDATE_WEBSITE: { websiteUri: value, sourceRef },
    UPDATE_PHONE: { primaryPhone: value, additionalPhones: [], sourceRef },
    UPDATE_DESCRIPTION: { description: value, sourceRef },
    UPDATE_TITLE: { title: value, sourceRef },
  };

  const payload = payloadByAction[actionType];
  if (!payload) redirect(`${path}?error=${encodeURIComponent("Unsupported action.")}`);

  try {
    const ctx = await resolveTenantContext(orgSlug);
    const result = await proposeChange(ctx, { locationId, actionType, payload });
    revalidatePath(path);
    redirect(
      `${path}?proposed=${encodeURIComponent(
        result.deduplicated
          ? "An identical proposal was already queued."
          : "Proposed. It is waiting in the approval queue.",
      )}`,
    );
  } catch (error) {
    if (isAppError(error)) {
      redirect(
        `${path}?error=${encodeURIComponent(
          error.expose ? error.message : "Could not propose this change.",
        )}`,
      );
    }
    throw error;
  }
}

/**
 * Server action backing the category editor's type-ahead.
 *
 * `orgSlug` is bound at render time rather than sent from the client: a server
 * action is its own entry point, so it must resolve and authorize its own
 * tenant context rather than trusting an argument the browser supplies.
 */
async function searchCategoriesAction(
  orgSlug: string,
  locationId: string,
  query: string,
): Promise<CategorySearchResult> {
  "use server";
  const ctx = await resolveTenantContext(orgSlug);
  return searchCategories(ctx, locationId, query);
}

async function proposeCategoriesAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const locationId = String(formData.get("locationId"));
  const path = `/${orgSlug}/locations/${locationId}`;

  const additional = String(formData.get("additionalCategoryIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const payload = {
    primaryCategoryId: String(formData.get("primaryCategoryId") ?? "").trim(),
    primaryCategoryName: String(formData.get("primaryCategoryName") ?? "").trim() || undefined,
    additionalCategoryIds: additional,
    sourceRef: {
      kind: String(formData.get("sourceKind") ?? "USER_INPUT"),
      detail: String(formData.get("sourceDetail") ?? "").trim(),
    },
  };

  try {
    const ctx = await resolveTenantContext(orgSlug);
    const result = await proposeChange(ctx, {
      locationId,
      actionType: ActionType.UPDATE_CATEGORIES,
      payload,
    });
    revalidatePath(path);
    redirect(
      `${path}?proposed=${encodeURIComponent(
        result.deduplicated
          ? "An identical proposal was already queued."
          : "Proposed. Category changes always need a human approver.",
      )}`,
    );
  } catch (error) {
    if (isAppError(error)) {
      redirect(
        `${path}?error=${encodeURIComponent(
          error.expose ? error.message : "Could not propose this change.",
        )}`,
      );
    }
    throw error;
  }
}

async function syncLocationAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const locationId = String(formData.get("locationId"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/locations/${locationId}`;

  try {
    const result = await syncLocation(ctx, locationId);
    revalidatePath(path);
    redirect(`${path}?synced=${result.snapshotCreated ? "changed" : "unchanged"}`);
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Sync failed.")}`);
    }
    throw error;
  }
}

export default async function LocationDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/locations/[locationId]">) {
  const { orgSlug, locationId } = await params;
  const query = await searchParams;
  const ctx = await resolveTenantContext(orgSlug);

  let location;
  try {
    location = await getLocation(ctx, locationId);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const [auditRun, history, changeLog] = await Promise.all([
    getLatestAuditRun(ctx, locationId),
    listAuditHistory(ctx, locationId, 10),
    getChangeLog(ctx, locationId, 20),
  ]);

  const canRun = can(ctx, "audit:run");
  const canDraft = can(ctx, "change:draft");
  const health = auditRun?.scoreBreakdown as unknown as HealthScoreShape | null;
  const openFindings = (auditRun?.findings ?? []).filter(
    (finding) => finding.status === FindingStatus.OPEN,
  );

  const error = typeof query.error === "string" ? query.error : null;
  const audited = typeof query.audited === "string" ? query.audited : null;
  const synced = typeof query.synced === "string" ? query.synced : null;
  const proposed = typeof query.proposed === "string" ? query.proposed : null;

  const fixableFindings = openFindings.filter(
    (finding) => finding.autoFixable && isProposable(finding.suggestedActionType),
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href={`/${orgSlug}/locations`}
            className="text-muted-foreground text-xs hover:underline"
          >
            ← All locations
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{location.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {location.primaryCategoryName ?? "No primary category"}
            {location.lastSyncedAt
              ? ` · synced ${location.lastSyncedAt.toLocaleString()}`
              : " · never synced"}
          </p>
        </div>

        {canRun ? (
          <div className="flex gap-2">
            <form action={syncLocationAction}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="locationId" value={locationId} />
              <Button type="submit" variant="outline" size="sm">
                Re-sync from Google
              </Button>
            </form>
            <form action={runAuditAction}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="locationId" value={locationId} />
              <Button type="submit" size="sm">
                Run audit
              </Button>
            </form>
          </div>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {audited ? (
        <Alert>
          <AlertDescription>
            Audit complete. {audited} new issue(s) opened, {query.resolved ?? 0} resolved since the
            last run.
          </AlertDescription>
        </Alert>
      ) : null}
      {synced ? (
        <Alert>
          <AlertDescription>
            {synced === "changed"
              ? "Profile changed since the last sync — a new snapshot was recorded."
              : "Profile is unchanged since the last sync. No new snapshot was needed."}
          </AlertDescription>
        </Alert>
      ) : null}
      {proposed ? (
        <Alert>
          <AlertDescription>
            {proposed}{" "}
            <Link href={`/${orgSlug}/approvals`} className="underline">
              Go to approvals
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {!auditRun || !health ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No audit yet</CardTitle>
            <CardDescription>
              Run an audit to check this profile against the ruleset and produce a health score.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Health</CardTitle>
                <span className="text-muted-foreground text-xs">
                  Ruleset {auditRun.rulesetVersion} · {auditRun.startedAt.toLocaleString()}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <HealthScore
                score={health.score}
                coverage={health.coverage}
                categories={health.categories}
                skippedReasons={health.skippedReasons}
              />
            </CardContent>
          </Card>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight">
                Issues ({openFindings.length})
              </h2>
            </div>
            <FindingsList
              findings={openFindings.map((finding) => ({
                id: finding.id,
                ruleId: finding.ruleId,
                category: finding.category,
                severity: finding.severity,
                status: finding.status,
                title: finding.title,
                detail: finding.detail,
                evidence: finding.evidence,
                autoFixable: finding.autoFixable,
                suggestedActionType: finding.suggestedActionType,
              }))}
            />
          </section>
        </>
      )}

      {canDraft ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Categories</CardTitle>
            <CardDescription>
              The primary category is the strongest single ranking signal a profile has, and the
              wrong one is the most damaging non-fatal error. Pick from Google&apos;s taxonomy
              rather than guessing an id.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CategoryEditor
              orgSlug={orgSlug}
              locationId={locationId}
              currentPrimary={
                location.primaryCategoryId
                  ? {
                      id: location.primaryCategoryId,
                      displayName: location.primaryCategoryName ?? location.primaryCategoryId,
                    }
                  : null
              }
              currentSecondary={toCategoryOptions(location.secondaryCategories)}
              searchAction={searchCategoriesAction.bind(null, orgSlug)}
              submitAction={proposeCategoriesAction}
            />
          </CardContent>
        </Card>
      ) : null}

      {canDraft && fixableFindings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Propose a fix</CardTitle>
            <CardDescription>
              Proposals go through the compliance guardrails, then wait for approval. Nothing is
              sent to Google until an owner or admin approves it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fixableFindings.map((finding) => (
              <div key={finding.id} className="space-y-2">
                <p className="text-sm font-medium">{finding.title}</p>
                <ProposeFix
                  orgSlug={orgSlug}
                  locationId={locationId}
                  findingId={finding.id}
                  actionType={finding.suggestedActionType as never}
                  action={proposeFixAction}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {changeLog.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change history</CardTitle>
            <CardDescription>
              Every change applied to this profile, permanently recorded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {changeLog.map((entry) => (
                <li key={entry.id} className="py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{entry.summary}</span>
                    <span className="text-muted-foreground text-xs">
                      {entry.createdAt.toLocaleString()}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {entry.actionType} ·{" "}
                    {entry.actorUser
                      ? (entry.actorUser.name ?? entry.actorUser.email)
                      : entry.actor.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {history.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit history</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {history.map((run) => (
                <li key={run.id} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground text-xs">
                    {run.startedAt.toLocaleString()}
                  </span>
                  <span className="flex items-center gap-3">
                    <Badge variant="outline" className="text-[10px]">
                      {run._count.findings} findings
                    </Badge>
                    <span className="w-8 text-right font-semibold tabular-nums">
                      {run.healthScore ?? "—"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-muted-foreground text-xs leading-relaxed">
        This audit describes profile quality against a published ruleset. It does not predict or
        guarantee ranking — local pack position depends on searcher proximity, competitor density
        and Google&apos;s algorithm, none of which any tool controls.
      </p>
    </div>
  );
}
