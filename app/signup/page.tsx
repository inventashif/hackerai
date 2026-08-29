import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HackerAISVG } from "@/components/icons/hackerai-svg";

export const runtime = "nodejs";

type SignupPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const firstValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

const buildAuthHref = (
  searchParams: Record<string, string | string[] | undefined>,
) => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
      continue;
    }
    params.set(key, value);
  }

  const query = params.toString();
  return query ? `/signup/auth?${query}` : "/signup/auth";
};

const getSafeDisplayName = (user: {
  firstName?: string | null;
  lastName?: string | null;
}) => {
  const parts = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : undefined;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;

  // No referral validation - just show the signup page
  const bonusUnits = 0;
  const bonusHeading = "Sign up for HackerAI";
  const referralLine = "Create your account to access AI penetration testing features.";

  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-14 flex justify-start">
          <HackerAISVG theme="dark" scale={0.15} />
        </div>

        <h1 className="text-4xl font-semibold tracking-normal md:text-5xl">
          Create your account
        </h1>

        <div className="border-border bg-muted/25 mt-8 rounded-2xl border p-6">
          <div className="flex gap-4">
            <div className="bg-background border-border flex size-10 shrink-0 items-center justify-center rounded-xl border">
              <Gift className="size-5" />
            </div>
            <div className="space-y-2">
              <p className="text-xl font-semibold">{bonusHeading}</p>
              <p className="text-muted-foreground text-lg leading-relaxed">
                {referralLine}
              </p>
            </div>
          </div>
        </div>

        <Button asChild size="lg" className="mt-6 h-12 w-full text-base">
          <Link href="/login">
            Continue to log in
            <ArrowRight className="size-4" />
          </Link>
        </Button>

        <p className="text-muted-foreground mt-8 text-center text-base">
          Already have an account?{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            href="/login"
          >
            Log in
          </Link>
        </p>

        <p className="text-muted-foreground mx-auto mt-8 max-w-md text-center text-sm leading-relaxed">
          By continuing, you agree to the{" "}
          <Link
            className="underline underline-offset-4"
            href="/terms-of-service"
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link className="underline underline-offset-4" href="/privacy-policy">
            Privacy Policy
          </Link>
          . Learn how we handle your data on our{" "}
          <Link className="underline underline-offset-4" href="/trust">
            Security & Trust
          </Link>
          page.
        </p>
      </div>
    </main>
  );
}