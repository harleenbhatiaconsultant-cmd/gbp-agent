import { notFound } from "next/navigation";
import { signOut } from "@/server/auth";
import { requireUser, resolveTenantContext } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/services/organizations";
import { AppHeader } from "@/components/layout/app-header";
import { isAppError } from "@/server/errors";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/sign-in" });
}

/**
 * Every page under this layout runs with a resolved TenantContext. Membership is
 * checked here on each request, so removal from an organization takes effect on
 * the next page load rather than when the session token expires.
 */
export default async function OrganizationLayout({
  children,
  params,
}: LayoutProps<"/[orgSlug]">) {
  const { orgSlug } = await params;
  const user = await requireUser();

  let ctx;
  try {
    ctx = await resolveTenantContext(orgSlug);
  } catch (error) {
    // Non-membership surfaces as not-found, never as forbidden.
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const organizations = await listOrganizationsForUser(user.id);
  const current = organizations.find((o) => o.slug === ctx.organizationSlug);
  if (!current) notFound();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AppHeader
        current={{ name: current.name, slug: current.slug, role: current.role }}
        organizations={organizations.map((o) => ({
          name: o.name,
          slug: o.slug,
          role: o.role,
        }))}
        userEmail={user.email}
        signOutAction={signOutAction}
      />
      <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</div>
    </div>
  );
}
