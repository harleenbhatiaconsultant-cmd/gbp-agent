import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { createOrganization } from "@/server/services/organizations";
import { isAppError } from "@/server/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create organization" };

async function createOrganizationAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();

  let slug: string;
  try {
    const organization = await createOrganization(user.id, { name });
    slug = organization.slug;
  } catch (error) {
    const message = isAppError(error) && error.expose ? error.message : "Could not create organization.";
    redirect(`/new?error=${encodeURIComponent(message)}`);
  }

  redirect(`/${slug}/dashboard`);
}

export default async function NewOrganizationPage({ searchParams }: PageProps<"/new">) {
  await requireUser();
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <main className="mx-auto w-full max-w-md flex-1 px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>
            An organization owns your locations, connections and change history. You can create
            more later — one per client if you are running an agency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <form action={createOrganizationAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Organization name</Label>
              <Input id="name" name="name" required minLength={2} maxLength={120} autoFocus />
              <p className="text-muted-foreground text-xs">
                A URL slug is generated from this name.
              </p>
            </div>
            <Button type="submit" className="w-full">
              Create organization
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
