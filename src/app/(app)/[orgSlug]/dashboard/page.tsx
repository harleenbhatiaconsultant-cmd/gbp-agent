import Link from "next/link";
import { resolveTenantContext } from "@/server/auth/session";
import { listConnections } from "@/server/services/connections";
import { listLocations } from "@/server/services/locations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

export default async function DashboardPage({ params }: PageProps<"/[orgSlug]/dashboard">) {
  const { orgSlug } = await params;
  const ctx = await resolveTenantContext(orgSlug);

  const [connections, locations] = await Promise.all([
    listConnections(ctx),
    listLocations(ctx),
  ]);

  const audited = locations.filter((l) => l.healthScore !== null);
  const averageScore =
    audited.length > 0
      ? Math.round(audited.reduce((sum, l) => sum + (l.healthScore ?? 0), 0) / audited.length)
      : null;
  const openIssues = locations.reduce((sum, l) => sum + l.openFindingCount, 0);
  const needsAttention = connections.filter((c) => c.status !== "ACTIVE");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Profile health across every location in this organization.
        </p>
      </header>

      {needsAttention.length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Connection needs attention</CardTitle>
            <CardDescription>
              {needsAttention.length} Google connection(s) are not active. Syncing is paused until
              they are reconnected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" asChild>
              <Link href={`/${orgSlug}/settings/connections`}>Review connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Locations</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{locations.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-xs">
              {audited.length} audited, {locations.length - audited.length} not yet
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Average health score</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{averageScore ?? "—"}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-xs">
              {averageScore === null
                ? "Run an audit to produce a score"
                : `Across ${audited.length} audited location(s)`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Open issues</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{openIssues}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-xs">Across all locations</p>
          </CardContent>
        </Card>
      </div>

      {locations.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Get started</CardTitle>
            <CardDescription>
              Connect the Google account that manages your business profiles, then run a sync to
              import its locations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/${orgSlug}/settings/connections`}>Connect Google</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Locations needing attention</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/${orgSlug}/locations`}>View all</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y">
              {[...locations]
                .sort((a, b) => b.openFindingCount - a.openFindingCount)
                .slice(0, 5)
                .map((location) => (
                  <li key={location.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Link
                      href={`/${orgSlug}/locations/${location.id}`}
                      className="min-w-0 text-sm font-medium hover:underline"
                    >
                      {location.title}
                    </Link>
                    <span className="flex shrink-0 items-center gap-3">
                      <Badge variant="secondary" className="text-[10px]">
                        {location.openFindingCount} open
                      </Badge>
                      <span className="w-8 text-right text-sm font-semibold tabular-nums">
                        {location.healthScore ?? "—"}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
