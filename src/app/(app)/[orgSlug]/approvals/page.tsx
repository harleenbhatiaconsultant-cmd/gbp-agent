import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChangeRequestStatus } from "@/generated/prisma/enums";
import { resolveTenantContext } from "@/server/auth/session";
import { listChangeRequests, approveChange, rejectChange, executeChange } from "@/server/services/changes";
import { getWriteModeSummary } from "@/server/services/write-mode";
import { enqueueChangeExecution } from "@/server/jobs/handlers";
import { isQueueingAvailable } from "@/server/jobs/redis";
import { can, requireCapability } from "@/server/auth/rbac";
import { canApprove as passesSeparationOfDuties } from "@/server/policy/separation-of-duties";
import { isAppError } from "@/server/errors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

const RISK_STYLES: Record<string, string> = {
  LOW: "bg-sky-500/10 text-sky-700 dark:text-sky-400 ring-sky-500/20",
  MEDIUM: "bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-amber-500/20",
  HIGH: "bg-red-500/10 text-red-700 dark:text-red-400 ring-red-500/20",
};

function RiskPill({ risk }: { risk: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${
        RISK_STYLES[risk] ?? RISK_STYLES.MEDIUM
      }`}
    >
      {risk} RISK
    </span>
  );
}

async function withRedirect(
  orgSlug: string,
  run: () => Promise<string | void>,
): Promise<never> {
  const path = `/${orgSlug}/approvals`;
  let query = "";
  try {
    const message = await run();
    if (message) query = `?done=${encodeURIComponent(message)}`;
  } catch (error) {
    if (isAppError(error)) {
      query = `?error=${encodeURIComponent(error.expose ? error.message : "Action failed.")}`;
    } else if (error instanceof Error && !("digest" in error)) {
      query = `?error=${encodeURIComponent(error.message.slice(0, 200))}`;
    } else {
      throw error;
    }
  }
  revalidatePath(path);
  redirect(`${path}${query}`);
}

async function approveAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const id = String(formData.get("changeRequestId"));
  await withRedirect(orgSlug, async () => {
    const ctx = await resolveTenantContext(orgSlug);
    await approveChange(ctx, id);
    return "Change approved. It has not been applied yet.";
  });
}

async function rejectAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const id = String(formData.get("changeRequestId"));
  const reason = String(formData.get("reason") ?? "Rejected by reviewer");
  await withRedirect(orgSlug, async () => {
    const ctx = await resolveTenantContext(orgSlug);
    await rejectChange(ctx, id, reason);
    return "Change rejected.";
  });
}

async function executeAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const id = String(formData.get("changeRequestId"));
  await withRedirect(orgSlug, async () => {
    const ctx = await resolveTenantContext(orgSlug);
    const result = await executeChange(ctx, id);
    return result.message;
  });
}

/**
 * Hands the change to the worker instead of running it inline.
 *
 * Useful once the queue exists: execution is rate-limited per profile and can
 * take a while, so it does not belong on a request thread.
 */
async function queueAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const id = String(formData.get("changeRequestId"));
  await withRedirect(orgSlug, async () => {
    const ctx = await resolveTenantContext(orgSlug);
    requireCapability(ctx, "change:execute");
    const result = await enqueueChangeExecution(ctx.organizationId, id);
    return result.enqueued
      ? "Queued for background execution."
      : `Not queued: ${result.reason ?? "unknown reason"}`;
  });
}

export default async function ApprovalsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/approvals">) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await resolveTenantContext(orgSlug);

  const [pending, approved, recent] = await Promise.all([
    listChangeRequests(ctx, { status: ChangeRequestStatus.PENDING_APPROVAL }),
    listChangeRequests(ctx, { status: ChangeRequestStatus.APPROVED }),
    listChangeRequests(ctx),
  ]);

  const canApprove = can(ctx, "change:approve");
  const canExecute = can(ctx, "change:execute");
  const writeMode = getWriteModeSummary();
  const queueingAvailable = isQueueingAvailable();

  const error = typeof query.error === "string" ? query.error : null;
  const done = typeof query.done === "string" ? query.done : null;

  const settled = recent.filter(
    (r) =>
      r.status !== ChangeRequestStatus.PENDING_APPROVAL &&
      r.status !== ChangeRequestStatus.APPROVED,
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Nothing reaches a business profile without passing the compliance guardrails and being
          approved by a named person.
        </p>
      </header>

      <Alert>
        <AlertTitle>
          Write mode: <code>{writeMode.mode}</code>
        </AlertTitle>
        <AlertDescription>{writeMode.explanation}</AlertDescription>
      </Alert>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {done ? (
        <Alert>
          <AlertDescription>{done}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Awaiting approval ({pending.length})
        </h2>

        {pending.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              Nothing is waiting for review.
            </CardContent>
          </Card>
        ) : (
          pending.map((request) => (
            <Card key={request.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{request.actionType}</CardTitle>
                    <CardDescription>
                      <Link
                        href={`/${orgSlug}/locations/${request.location.id}`}
                        className="hover:underline"
                      >
                        {request.location.title}
                      </Link>
                      {request.requestedBy
                        ? ` · proposed by ${request.requestedBy.name ?? request.requestedBy.email}`
                        : " · proposed by the system"}
                    </CardDescription>
                  </div>
                  <RiskPill risk={request.riskLevel} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer select-none">
                    Proposed change
                  </summary>
                  <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-[11px]">
                    {JSON.stringify(request.payload, null, 2)}
                  </pre>
                </details>

                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer select-none">
                    Compliance assessment
                  </summary>
                  <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-[11px]">
                    {JSON.stringify(request.policyDecision, null, 2)}
                  </pre>
                </details>

                {canApprove ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Rejecting your own proposal is always allowed — it moves
                          in the safe direction. Approving it never is. */}
                      {passesSeparationOfDuties(request, { userId: ctx.userId ?? "" }) ? (
                        <form action={approveAction}>
                          <input type="hidden" name="orgSlug" value={orgSlug} />
                          <input type="hidden" name="changeRequestId" value={request.id} />
                          <Button type="submit" size="sm">
                            Approve
                          </Button>
                        </form>
                      ) : null}

                      <form action={rejectAction} className="flex items-center gap-2">
                        <input type="hidden" name="orgSlug" value={orgSlug} />
                        <input type="hidden" name="changeRequestId" value={request.id} />
                        <input
                          name="reason"
                          placeholder="Reason (optional)"
                          className="border-input bg-background h-8 w-56 rounded-md border px-2 text-xs"
                        />
                        <Button type="submit" size="sm" variant="ghost">
                          Reject
                        </Button>
                      </form>
                    </div>

                    {!passesSeparationOfDuties(request, { userId: ctx.userId ?? "" }) ? (
                      <p className="text-muted-foreground text-xs">
                        You proposed this change, so someone else has to approve it. If you are
                        the only owner or admin here, invite another one from{" "}
                        <Link href={`/${orgSlug}/settings/members`} className="underline">
                          Members
                        </Link>
                        .
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Your role cannot approve changes. Only owners and admins may.
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Approved, not yet applied ({approved.length})
        </h2>

        {approved.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              Nothing approved is waiting.
            </CardContent>
          </Card>
        ) : (
          approved.map((request) => {
            const lastExecution = request.executions[0];
            return (
              <Card key={request.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{request.actionType}</CardTitle>
                      <CardDescription>
                        {request.location.title}
                        {request.approvedBy
                          ? ` · approved by ${request.approvedBy.name ?? request.approvedBy.email}`
                          : ""}
                      </CardDescription>
                    </div>
                    <RiskPill risk={request.riskLevel} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {lastExecution ? (
                    <p className="text-muted-foreground text-xs">
                      Last attempt: {lastExecution.dryRun ? "validation" : "live write"} —{" "}
                      {lastExecution.status}
                      {lastExecution.errorMessage ? ` (${lastExecution.errorMessage})` : ""}
                    </p>
                  ) : null}

                  {canExecute ? (
                    <form action={executeAction}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="changeRequestId" value={request.id} />
                      <Button type="submit" size="sm" variant="outline">
                        {writeMode.willApply ? "Apply to Google" : "Validate against Google"}
                      </Button>
                    </form>
                  ) : null}

                  {canExecute && queueingAvailable ? (
                    <form action={queueAction}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="changeRequestId" value={request.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Queue for worker
                      </Button>
                    </form>
                  ) : null}
                </CardContent>
              </Card>
            );
          })
        )}
      </section>

      {settled.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Recently settled</h2>
          <Card>
            <CardContent className="p-0">
              <ul className="divide-border divide-y text-sm">
                {settled.slice(0, 15).map((request) => (
                  <li key={request.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="font-medium">{request.actionType}</span>
                      <span className="text-muted-foreground"> · {request.location.title}</span>
                      {request.rejectedReason ? (
                        <span className="text-muted-foreground block text-xs">
                          {request.rejectedReason}
                        </span>
                      ) : null}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {request.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
