import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { FindingStatus } from "@/generated/prisma/enums";
import { resolveTenantContext } from "@/server/auth/session";
import { getLocation, syncLocation } from "@/server/services/locations";
import { runLocationAudit, getLatestAuditRun, listAuditHistory } from "@/server/services/audits";
import { can } from "@/server/auth/rbac";
import { isAppError } from "@/server/errors";
import type { HealthScore as HealthScoreShape } from "@/server/audit/scoring";
import { HealthScore } from "@/components/features/health-score";
import { FindingsList } from "@/components/features/findings-list";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

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

  const [auditRun, history] = await Promise.all([
    getLatestAuditRun(ctx, locationId),
    listAuditHistory(ctx, locationId, 10),
  ]);

  const canRun = can(ctx, "audit:run");
  const health = auditRun?.scoreBreakdown as unknown as HealthScoreShape | null;
  const openFindings = (auditRun?.findings ?? []).filter(
    (finding) => finding.status === FindingStatus.OPEN,
  );

  const error = typeof query.error === "string" ? query.error : null;
  const audited = typeof query.audited === "string" ? query.audited : null;
  const synced = typeof query.synced === "string" ? query.synced : null;

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
