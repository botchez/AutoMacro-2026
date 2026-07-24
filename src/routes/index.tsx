import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import cornImage from "@/assets/corn.png";
import { Mascot } from "@/components/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApp } from "@/lib/store";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NutriCoach — Fun nutrition tracking that sticks" },
      {
        name: "description",
        content:
          "Log meals, hit macros, and level up your nutrition with a friendly coach by your side.",
      },
      { property: "og:title", content: "NutriCoach — Fun nutrition tracking" },
      {
        property: "og:description",
        content: "Playful, gamified nutrition tracking with a friendly coach.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { login, signup, user, goals, ready, busy } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (ready && user) {
      navigate({ to: goals ? "/dashboard" : "/onboarding" });
    }
  }, [ready, user, goals, navigate]);

  const [loginEmail, setLoginEmail] = useState("demo@nutricoach.app");
  const [loginPass, setLoginPass] = useState("demo1234");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(loginEmail, loginPass);
      navigate({ to: "/dashboard" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not log in");
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) return;
    try {
      await signup(name, email, pass);
      navigate({ to: "/onboarding" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create account");
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <div className="hidden md:flex md:w-1/2 items-center justify-center p-10 bg-gradient-to-br from-primary/20 via-sun/20 to-sky/20">
        <div className="max-w-md text-center">
          <Mascot size={180} className="mx-auto animate-float" />
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">
            Nutrition, but make it <span className="text-primary">fun</span>.
          </h1>
          <p className="mt-3 text-muted-foreground">
            Snap meals, hit your macros, and get high-fives from your pocket coach. No spreadsheets.
            No guilt.
          </p>
          <div className="mt-7 grid grid-cols-2 gap-2 text-left">
            <div className="col-span-2 flex min-h-36 items-center justify-between overflow-hidden rounded-[1.75rem] bg-white/85 py-2 pl-5 pr-2 shadow-lg shadow-primary/10 ring-1 ring-black/5">
              <div className="relative z-10 max-w-[190px]">
                <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-primary">
                  Smart food scan
                </div>
                <div className="mt-1 text-xl font-extrabold leading-tight">Snap. Review. Log.</div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  Take a photo and let NutriCoach identify what’s on your plate.
                </p>
              </div>
              <div className="relative flex h-32 w-36 shrink-0 items-center justify-center">
                <div
                  aria-hidden="true"
                  className="absolute h-24 w-24 rounded-full bg-sun/25 blur-xl"
                />
                <img
                  src={cornImage}
                  alt="Corn character taking a food photo"
                  className="relative h-32 w-32 object-contain drop-shadow-lg"
                />
              </div>
            </div>
            <div className="rounded-2xl bg-white/65 px-3 py-2.5 text-center text-sm font-semibold">
              🥑 Macro rings
            </div>
            <div className="rounded-2xl bg-white/65 px-3 py-2.5 text-center text-sm font-semibold">
              🔥 Streaks
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md card-soft p-6 md:p-8 animate-pop">
          <div className="flex md:hidden justify-center mb-4">
            <Mascot size={80} className="animate-float" />
          </div>
          <h2 className="text-2xl font-extrabold text-center">Welcome to NutriCoach</h2>
          <p className="text-center text-sm text-muted-foreground mt-1">
            Your friendly nutrition sidekick 🌱
          </p>

          <Tabs defaultValue="login" className="mt-6">
            <TabsList className="grid grid-cols-2 w-full rounded-full h-11 p-1">
              <TabsTrigger value="login" className="rounded-full">
                Log in
              </TabsTrigger>
              <TabsTrigger value="signup" className="rounded-full">
                Sign up
              </TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-3 mt-4">
                <div>
                  <Label htmlFor="li-email">Email</Label>
                  <Input
                    id="li-email"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="li-pass">Password</Label>
                  <Input
                    id="li-pass"
                    type="password"
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                    required
                  />
                </div>
                <Button
                  disabled={busy}
                  type="submit"
                  size="lg"
                  className="w-full rounded-full font-bold bounce-tap"
                >
                  {busy ? "Signing in…" : "Let's go →"}
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  Demo account is ready to use.
                </p>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignup} className="space-y-3 mt-4">
                <div>
                  <Label htmlFor="su-name">Name</Label>
                  <Input
                    id="su-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="su-email">Email</Label>
                  <Input
                    id="su-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="su-pass">Password</Label>
                  <Input
                    id="su-pass"
                    type="password"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    required
                  />
                </div>
                <Button
                  disabled={busy}
                  type="submit"
                  size="lg"
                  className="w-full rounded-full font-bold bounce-tap"
                >
                  {busy ? "Creating…" : "Create account 🎉"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
