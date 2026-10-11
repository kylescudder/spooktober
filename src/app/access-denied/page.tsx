import { SignOutButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthMessage, AuthSetupMessage } from "../../components/auth-message";
import { accessFailure, clerkConfiguration } from "../../server/auth";

export const dynamic = "force-dynamic";

export default async function AccessDeniedPage() {
  if (!clerkConfiguration().configured) return <AuthSetupMessage />;
  const { userId } = await auth({ acceptsToken: "session_token" });
  if (!userId) redirect("/sign-in");
  const failure = accessFailure(userId);
  if (!failure) redirect("/");
  if (failure.status === 503) return <AuthSetupMessage />;
  return <AuthMessage title="This is our little film club.">
    <p>This watchlist is private to Kyle and Rhiann. Try signing in with your invited account.</p>
    <SignOutButton redirectUrl="/sign-in"><button className="auth-button">Use another account</button></SignOutButton>
  </AuthMessage>;
}
