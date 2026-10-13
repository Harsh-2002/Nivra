import Link from "next/link";
import { Mark } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { oauthErrorMessage } from "@/lib/oauth-error";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function OAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  const message = oauthErrorMessage(error);

  return (
    <main className="auth-page">
      <section
        className="auth-panel oauth-card"
        aria-labelledby="oauth-error-title"
      >
        <header className="oauth-heading">
          <Mark />
          <h1 id="oauth-error-title">{message.title}</h1>
          <p>{message.description}</p>
        </header>
        <Button asChild className="min-h-11 w-full">
          <Link href="/">Back to Nivra</Link>
        </Button>
      </section>
    </main>
  );
}
