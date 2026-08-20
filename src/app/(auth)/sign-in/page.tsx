import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/server/auth";
import { getCurrentUser } from "@/server/auth/session";
import { isDevSignInEnabled, isGoogleLoginEnabled } from "@/server/auth/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in" };

async function signInWithGoogle() {
  "use server";
  await signIn("google", { redirectTo: "/" });
}

async function signInForDevelopment(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  try {
    await signIn("dev", { email, name, redirectTo: "/" });
  } catch (error) {
    // next-auth throws a redirect internally on success; only re-map real failures.
    if (error instanceof AuthError) {
      redirect(`/sign-in?error=${encodeURIComponent(error.type)}`);
    }
    throw error;
  }
}

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  const googleEnabled = isGoogleLoginEnabled();
  const devEnabled = isDevSignInEnabled();

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">GBP Growth Agent</h1>
          <p className="text-muted-foreground mt-1 text-sm">Sign in to continue</p>
        </header>

        {error ? (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>
              Sign-in failed. Check the address and try again.
            </AlertDescription>
          </Alert>
        ) : null}

        {googleEnabled ? (
          <form action={signInWithGoogle}>
            <Button type="submit" className="w-full" size="lg">
              Continue with Google
            </Button>
          </form>
        ) : (
          <Alert className="mb-6">
            <AlertDescription>
              Google sign-in is not configured. Set <code>GOOGLE_LOGIN_CLIENT_ID</code> and{" "}
              <code>GOOGLE_LOGIN_CLIENT_SECRET</code> to enable it.
            </AlertDescription>
          </Alert>
        )}

        {devEnabled ? (
          <div className="mt-6">
            {googleEnabled ? (
              <div className="mb-6 flex items-center gap-3">
                <div className="bg-border h-px flex-1" />
                <span className="text-muted-foreground text-xs">or</span>
                <div className="bg-border h-px flex-1" />
              </div>
            ) : null}

            <form action={signInForDevelopment} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name (optional)</Label>
                <Input id="name" name="name" type="text" placeholder="Your name" />
              </div>
              <Button type="submit" variant="outline" className="w-full">
                Development sign-in
              </Button>
            </form>

            <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
              Development sign-in accepts any email and creates the account on first use. It is
              not registered when <code>NODE_ENV=production</code>.
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
