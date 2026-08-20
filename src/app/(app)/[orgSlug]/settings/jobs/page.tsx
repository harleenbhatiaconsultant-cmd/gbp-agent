import { resolveTenantContext } from "@/server/auth/session";
import { getJobsView } from "@/server/services/jobs-view";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Background jobs" };

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  COMPLETED: "secondary",
  RUNNING: "default",
  FAILED: "destructive",
  QUEUED: "outline",
  CANCELLED: "outline",
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default async function JobsPage({ params }: PageProps<"/[orgSlug]/settings/jobs">) {
  const { orgSlug } = await params;
  const ctx = await resolveTenantContext(orgSlug);
  const view = await getJobsView(ctx);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Background jobs</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scheduled syncs, audits and change executions, and whether they actually ran.
        </p>
      </header>

      {!view.queueingConfigured ? (
        <Alert>
          <AlertTitle>Queueing is not configured</AlertTitle>
          <AlertDescription>
            <code>REDIS_URL</code> is unset, so nothing runs on a schedule. Syncing and auditing
            still work on demand from the location pages. Paste an Upstash connection string into
            the environment and restart the worker and scheduler to activate it.
          </AlertDescription>
        </Alert>
      ) : null}

      {view.failedLast24h > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            {view.failedLast24h} job{view.failedLast24h === 1 ? "" : "s"} failed in the last 24
            hours.
          </AlertDescription>
        </Alert>
      ) : null}

      {view.queues.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {view.queues.map((queue) => (
            <Card key={queue.queue}>
              <CardHeader className="pb-2">
                <CardDescription>{queue.queue}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{queue.waiting}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">
                  {queue.active} active · {queue.delayed} delayed · {queue.failed} failed
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule</CardTitle>
          <CardDescription>All times UTC. The scheduler must run as a single replica.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Cron</TableHead>
                <TableHead>Next run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.schedules.map((schedule) => (
                <TableRow key={schedule.name}>
                  <TableCell>
                    <div className="font-medium">{schedule.name}</div>
                    <div className="text-muted-foreground text-xs">{schedule.description}</div>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{schedule.pattern}</code>
                  </TableCell>
                  <TableCell className="text-xs">
                    {schedule.registered ? (
                      (schedule.next?.toLocaleString() ?? "scheduled")
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        not registered
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent runs</CardTitle>
          <CardDescription>
            The durable record, kept in the database rather than in Redis.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {view.recentRuns.length === 0 ? (
            <p className="text-muted-foreground px-6 py-8 text-center text-sm">
              No background jobs have run for this organization yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <div className="font-medium">{run.jobName}</div>
                      {run.error ? (
                        <div className="text-muted-foreground max-w-md truncate text-xs">
                          {run.error}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[run.status] ?? "outline"}>{run.status}</Badge>
                      {run.attempts > 1 ? (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          attempt {run.attempts}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {run.startedAt?.toLocaleString() ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
