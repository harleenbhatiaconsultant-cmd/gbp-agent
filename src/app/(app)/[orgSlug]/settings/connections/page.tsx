import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ConnectionStatus } from "@/generated/prisma/enums";
import { resolveTenantContext } from "@/server/auth/session";
import { listConnections, disconnect } from "@/server/services/connections";
import { syncConnection } from "@/server/services/locations";
import { isGoogleConnectConfigured } from "@/server/services/connect-status";
import { can } from "@/server/auth/rbac";
import { isAppError } from "@/server/errors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connections" };

const STATUS_VARIANT: Record<ConnectionStatus, "default" | "secondary" | "destructive"> = {
  ACTIVE: "default",
  EXPIRED: "secondary",
  REVOKED: "destructive",
  NEEDS_RECONSENT: "destructive",
  ERROR: "destructive",
};

async function syncAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const connectionId = String(formData.get("connectionId"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/settings/connections`;

  try {
    const result = await syncConnection(ctx, connectionId);
    revalidatePath(path);
    redirect(
      `${path}?synced=${result.locationsImported + result.locationsUpdated}&snapshots=${result.snapshotsCreated}`,
    );
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Sync failed.")}`);
    }
    // Google-shaped failures carry a useful message; surface it rather than a generic one.
    if (error instanceof Error && !("digest" in error)) {
      redirect(`${path}?error=${encodeURIComponent(error.message.slice(0, 200))}`);
    }
    throw error;
  }
}

async function disconnectAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const ctx = await resolveTenantContext(orgSlug);
  await disconnect(ctx, String(formData.get("connectionId")));
  revalidatePath(`/${orgSlug}/settings/connections`);
}

export default async function ConnectionsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/settings/connections">) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await resolveTenantContext(orgSlug);
  const connections = await listConnections(ctx);
  const canManage = can(ctx, "connection:manage");
  const configured = isGoogleConnectConfigured();

  const error = typeof query.error === "string" ? query.error : null;
  const connected = typeof query.connected === "string" ? query.connected : null;
  const synced = typeof query.synced === "string" ? query.synced : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Google connections</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connecting a Google account lets this platform read the business profiles it manages.
          This is a separate consent from signing in.
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {connected ? (
        <Alert>
          <AlertDescription>
            Connected <strong>{connected}</strong>. Run a sync to import its locations.
          </AlertDescription>
        </Alert>
      ) : null}
      {synced ? (
        <Alert>
          <AlertDescription>
            Sync complete: {synced} location(s) processed, {query.snapshots ?? 0} new snapshot(s)
            recorded.
          </AlertDescription>
        </Alert>
      ) : null}

      {!configured ? (
        <Alert>
          <AlertTitle>Google OAuth is not configured yet</AlertTitle>
          <AlertDescription>
            Set <code>GOOGLE_OAUTH_CLIENT_ID</code>, <code>GOOGLE_OAUTH_CLIENT_SECRET</code> and{" "}
            <code>TOKEN_ENCRYPTION_KEY</code> in the environment, with redirect URI{" "}
            <code>/api/google/oauth/callback</code>. Connecting a profile also requires an approved
            Google Business Profile API access request — until that is granted, quota is zero and
            reads will be refused.
          </AlertDescription>
        </Alert>
      ) : null}

      {connections.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No Google account connected</CardTitle>
            <CardDescription>
              Connect the Google account that owns or manages the business profiles you want to
              audit.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild disabled={!canManage || !configured}>
              <Link href={`/api/google/oauth/start?org=${orgSlug}`}>
                Connect Google Business Profile
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {connections.map((connection) => (
            <Card key={connection.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{connection.googleAccountEmail}</CardTitle>
                    <CardDescription>
                      {connection.gbpAccountCount} account(s) · {connection.locationCount}{" "}
                      location(s)
                      {connection.lastSyncedAt
                        ? ` · last synced ${connection.lastSyncedAt.toLocaleString()}`
                        : " · never synced"}
                    </CardDescription>
                  </div>
                  <Badge variant={STATUS_VARIANT[connection.status]}>{connection.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {connection.lastError ? (
                  <Alert variant="destructive">
                    <AlertDescription className="text-xs">{connection.lastError}</AlertDescription>
                  </Alert>
                ) : null}

                {connection.status === ConnectionStatus.NEEDS_RECONSENT ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Authorization was revoked at Google. Reconnect this account to resume syncing.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <form action={syncAction}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <Button type="submit" size="sm">
                        Sync locations
                      </Button>
                    </form>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/api/google/oauth/start?org=${orgSlug}`}>Reconnect</Link>
                    </Button>
                    <form action={disconnectAction}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Disconnect
                      </Button>
                    </form>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs leading-relaxed">
        Disconnecting revokes the token at Google and deletes the stored credential along with the
        imported profile data. Refresh tokens are encrypted at rest and are never returned to the
        browser.
      </p>
    </div>
  );
}
