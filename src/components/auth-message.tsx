import { Clapperboard } from "lucide-react";

export function AuthMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="auth-page">
    <div className="auth-intro">
      <p className="our-names"><Clapperboard size={17} /> Kyle & Rhiann</p>
      <img src="/images/pumpkins-and-candles.png" alt="" width={300} height={200} />
      <h1>Spooktober<span>.</span></h1>
      <h2>{title}</h2>
    </div>
    <div className="auth-content">{children}</div>
  </main>;
}

export function AuthSetupMessage() {
  return <AuthMessage title="Our film nights are almost ready."><p>Sign-in is still being set up. Please try again later.</p></AuthMessage>;
}
