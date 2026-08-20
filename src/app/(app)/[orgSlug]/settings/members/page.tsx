import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { MemberRole } from "@/generated/prisma/enums";
import { resolveTenantContext } from "@/server/auth/session";
import {
  listMembers,
  inviteMember,
  changeMemberRole,
  removeMember,
} from "@/server/services/organizations";
import { can } from "@/server/auth/rbac";
import { isAppError } from "@/server/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
export const metadata = { title: "Members" };

const ASSIGNABLE_ROLES = [MemberRole.ADMIN, MemberRole.EDITOR, MemberRole.VIEWER] as const;

async function inviteAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/settings/members`;

  try {
    const invitation = await inviteMember(ctx, {
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? MemberRole.VIEWER) as (typeof ASSIGNABLE_ROLES)[number],
    });
    revalidatePath(path);
    // No email delivery yet, so the one-time token is surfaced here. Replaced by
    // an emailed link when the notification service lands.
    redirect(`${path}?invited=${encodeURIComponent(invitation.email)}&token=${invitation.token}`);
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Invite failed.")}`);
    }
    throw error;
  }
}

async function changeRoleAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/settings/members`;

  try {
    await changeMemberRole(ctx, {
      userId: String(formData.get("userId")),
      role: String(formData.get("role")) as (typeof ASSIGNABLE_ROLES)[number],
    });
    revalidatePath(path);
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Update failed.")}`);
    }
    throw error;
  }
}

async function removeAction(formData: FormData) {
  "use server";
  const orgSlug = String(formData.get("orgSlug"));
  const ctx = await resolveTenantContext(orgSlug);
  const path = `/${orgSlug}/settings/members`;

  try {
    await removeMember(ctx, String(formData.get("userId")));
    revalidatePath(path);
  } catch (error) {
    if (isAppError(error)) {
      redirect(`${path}?error=${encodeURIComponent(error.expose ? error.message : "Remove failed.")}`);
    }
    throw error;
  }
}

export default async function MembersPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/settings/members">) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await resolveTenantContext(orgSlug);
  const members = await listMembers(ctx);
  const canManage = can(ctx, "members:manage");

  const error = typeof query.error === "string" ? query.error : null;
  const invited = typeof query.invited === "string" ? query.invited : null;
  const token = typeof query.token === "string" ? query.token : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Only owners and admins can approve profile changes. Editors may prepare work; viewers
          are read-only.
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {invited && token ? (
        <Alert>
          <AlertDescription className="space-y-1">
            <p>
              Invitation created for <strong>{invited}</strong>. Email delivery is not built yet,
              so share this one-time link manually:
            </p>
            <code className="bg-muted block overflow-x-auto rounded px-2 py-1 text-xs">
              /invitations/accept?token={token}
            </code>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {members.length} {members.length === 1 ? "member" : "members"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isSelf = member.userId === ctx.userId;
                const isOwner = member.role === MemberRole.OWNER;
                return (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <div className="font-medium">{member.name ?? "—"}</div>
                      <div className="text-muted-foreground text-xs">{member.email}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={isOwner ? "default" : "secondary"}>{member.role}</Badge>
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          {isOwner ? (
                            <span className="text-muted-foreground text-xs">
                              Owner role is changed by transfer
                            </span>
                          ) : (
                            <>
                              <form action={changeRoleAction} className="flex items-center gap-2">
                                <input type="hidden" name="orgSlug" value={orgSlug} />
                                <input type="hidden" name="userId" value={member.userId} />
                                <select
                                  name="role"
                                  defaultValue={member.role}
                                  className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                                  aria-label={`Role for ${member.email}`}
                                >
                                  {ASSIGNABLE_ROLES.map((role) => (
                                    <option key={role} value={role}>
                                      {role}
                                    </option>
                                  ))}
                                </select>
                                <Button type="submit" size="sm" variant="outline">
                                  Save
                                </Button>
                              </form>
                              {!isSelf ? (
                                <form action={removeAction}>
                                  <input type="hidden" name="orgSlug" value={orgSlug} />
                                  <input type="hidden" name="userId" value={member.userId} />
                                  <Button type="submit" size="sm" variant="ghost">
                                    Remove
                                  </Button>
                                </form>
                              ) : null}
                            </>
                          )}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite someone</CardTitle>
            <CardDescription>
              Invitations expire after 7 days and can only be redeemed by the invited address.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={inviteAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <div className="min-w-[16rem] flex-1 space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required placeholder="teammate@example.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <select
                  id="role"
                  name="role"
                  defaultValue={MemberRole.VIEWER}
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                >
                  {ASSIGNABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit">Send invitation</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
