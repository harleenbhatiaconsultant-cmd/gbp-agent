import { redirect } from "next/navigation";
import { getCurrentUser, getDefaultOrganizationSlug } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Entry point. Routes to sign-in, onboarding, or the user's default
 * organization. The platform has no signed-out product surface yet — a
 * marketing page belongs in the (marketing) group when there is one.
 */
export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const slug = await getDefaultOrganizationSlug(user.id);
  redirect(slug ? `/${slug}/dashboard` : "/new");
}
