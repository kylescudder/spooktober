import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AuthMessage, AuthSetupMessage } from "../../../components/auth-message";
import { clerkConfiguration } from "../../../server/auth";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (!clerkConfiguration().configured) return <AuthSetupMessage />;
  if ((await auth({ acceptsToken: "session_token" })).userId) redirect("/");
  return <AuthMessage title="Come in. Get cosy.">
    <p>Sign in for our Halloween film nights.</p>
    <SignIn routing="path" path="/sign-in" withSignUp={false} forceRedirectUrl="/" />
  </AuthMessage>;
}
