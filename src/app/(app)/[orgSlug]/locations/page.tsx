import Link from "next/link";
import { resolveTenantContext } from "@/server/auth/session";
import { listLocations } from "@/server/services/locations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
export const metadata = { title: "Locations" };

function scoreClass(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score < 50) return "text-red-600 dark:text-red-400";
  if (score < 70) return "text-amber-600 dark:text-amber-400";
  if (score < 90) return "text-sky-600 dark:text-sky-400";
  return "text-emerald-600 dark:text-emerald-400";
}

export default async function LocationsPage({ params }: PageProps<"/[orgSlug]/locations">) {
  const { orgSlug } = await params;
  const ctx = await resolveTenantContext(orgSlug);
  const locations = await listLocations(ctx);

  if (locations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No locations imported</CardTitle>
          <CardDescription>
            Connect a Google account and run a sync to import the business profiles it manages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href={`/${orgSlug}/settings/connections`}>Go to connections</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Locations</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {locations.length} location{locations.length === 1 ? "" : "s"} imported from Google.
        </p>
      </header>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Open issues</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((location) => (
                <TableRow key={location.id}>
                  <TableCell>
                    <Link
                      href={`/${orgSlug}/locations/${location.id}`}
                      className="font-medium hover:underline"
                    >
                      {location.title}
                    </Link>
                    <div className="text-muted-foreground text-xs">
                      {location.address ?? "No address"}
                    </div>
                    {location.isSuspended ? (
                      <Badge variant="destructive" className="mt-1 text-[10px]">
                        suspended
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {location.primaryCategoryName ?? (
                      <span className="text-red-600 dark:text-red-400">None set</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {location.openFindingCount}
                  </TableCell>
                  <TableCell
                    className={`text-right text-lg font-semibold tabular-nums ${scoreClass(location.healthScore)}`}
                  >
                    {location.healthScore ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
