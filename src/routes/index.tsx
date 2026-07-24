import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import cornImage from "@/assets/corn.png";
import skinnyImage from "@/assets/skinny.png";
import bulkyImage from "@/assets/bulky.png";
import buffImage from "@/assets/buff.png";
import { Mascot } from "@/components/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, Pause, Play } from "lucide-react";
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

const CAROUSEL_ITEMS = [
  {
    tag: "Smart food scan",
    title: "Snap. Review. Log.",
    description: "Take a photo and let NutriCoach identify what’s on your plate.",
    image: cornImage,
    alt: "Corn character taking a food photo",
    bgGlow: "bg-sun/30",
  },
  {
    tag: "AI Nutrition Coach",
    title: "Tips & Motivation",
    description: "Get real-time feedback, smart meal advice, and daily encouragement.",
    image: skinnyImage,
    alt: "Skinny fitness coach giving nutrition advice",
    bgGlow: "bg-leaf/30",
  },
  {
    tag: "Food History & Logs",
    title: "Track & Reflect",
    description: "Review your past meal logs, edit foods, and search historical entries.",
    image: bulkyImage,
    alt: "Bulky fitness coach representing nutrition progress",
    bgGlow: "bg-sky/30",
  },
  {
    tag: "Precision Macro Goals",
    title: "Fuel Your Body",
    description:
      "Calories, Protein, Carbs & Fat targets tailored specifically for your fitness journey.",
    image: buffImage,
    alt: "Buff fitness coach representing tailored macro goals",
    bgGlow: "bg-mango/30",
  },
];

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
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);

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

  const handleDemoLogin = async () => {
    try {
      await login("demo@nutricoach.app", "demo1234");
      navigate({ to: "/dashboard" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the demo");
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <div className="hidden md:flex md:w-1/2 items-center justify-center p-10 bg-gradient-to-br from-primary/20 via-sun/20 to-sky/20">
        <div className="max-w-md text-center">
          <Mascot size={180} className="mx-auto animate-float" />
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight">
            Nutrition that works for <span className="text-primary">real life</span>.
          </h1>
          <p className="mt-3 text-muted-foreground">
            Track meals, understand your macros, and receive practical guidance tailored to your
            goals—all in one simple experience.
          </p>

          {/* Floating Scrollable Feature Showcase Carousel */}
          <FeatureCarousel />
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md card-soft p-6 md:p-8 animate-pop">
          <div className="flex md:hidden justify-center mb-4">
            <Mascot size={80} className="animate-float" />
          </div>
          <h2 className="text-2xl font-extrabold text-center">Welcome to NutriCoach</h2>
          <p className="text-center text-sm text-muted-foreground mt-1">
            Your friendly nutrition sidekick
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
                  <div className="relative">
                    <Input
                      id="li-pass"
                      type={showLoginPassword ? "text" : "password"}
                      value={loginPass}
                      onChange={(e) => setLoginPass(e.target.value)}
                      className="pr-10"
                      required
                    />
                    <PasswordToggle
                      visible={showLoginPassword}
                      onToggle={() => setShowLoginPassword((current) => !current)}
                    />
                  </div>
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
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleDemoLogin()}
                  className="w-full rounded-full font-bold"
                >
                  Explore with demo account
                </Button>
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
                  <div className="relative">
                    <Input
                      id="su-pass"
                      type={showSignupPassword ? "text" : "password"}
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                      className="pr-10"
                      minLength={8}
                      required
                    />
                    <PasswordToggle
                      visible={showSignupPassword}
                      onToggle={() => setShowSignupPassword((current) => !current)}
                    />
                  </div>
                  <div
                    className={cn(
                      "mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold",
                      pass.length >= 8 ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Use at least 8 characters
                  </div>
                </div>
                <Button
                  disabled={busy || pass.length < 8}
                  type="submit"
                  size="lg"
                  className="w-full rounded-full font-bold bounce-tap"
                >
                  {busy ? "Creating…" : "Create account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          <div className="mt-6 grid grid-cols-2 gap-2 border-t pt-5 md:hidden">
            {CAROUSEL_ITEMS.map((item) => (
              <div key={item.tag} className="rounded-xl bg-muted/45 p-2.5">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-primary">
                  {item.tag}
                </div>
                <div className="mt-0.5 text-xs font-bold">{item.title}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PasswordToggle({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? "Hide password" : "Show password"}
      className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function FeatureCarousel() {
  const [index, setIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const nextSlide = useCallback(() => {
    setIndex((prev) => (prev + 1) % CAROUSEL_ITEMS.length);
  }, []);

  const prevSlide = useCallback(() => {
    setIndex((prev) => (prev - 1 + CAROUSEL_ITEMS.length) % CAROUSEL_ITEMS.length);
  }, []);

  // Move automatically to the right every 3.5 seconds
  useEffect(() => {
    if (isHovered || isPaused) return;
    const interval = setInterval(nextSlide, 3500);
    return () => clearInterval(interval);
  }, [nextSlide, isHovered, isPaused]);

  // Keyboard navigation support (ArrowLeft / ArrowRight)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") nextSlide();
    if (e.key === "ArrowLeft") prevSlide();
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label="Features carousel"
      className="relative mt-7 px-8 outline-none"
    >
      {/* Floating Feature Card Container */}
      <div className="animate-float overflow-hidden rounded-[1.75rem] bg-white/90 p-1 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.12)] backdrop-blur-md ring-1 ring-black/5 transition-all duration-300 hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.18)]">
        <div
          aria-live="polite"
          className="flex transition-transform duration-500 ease-out"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {CAROUSEL_ITEMS.map((item, i) => (
            <div
              key={i}
              className="w-full shrink-0 flex min-h-36 items-center justify-between overflow-hidden rounded-[1.5rem] bg-gradient-to-br from-white via-white to-muted/20 py-3 pl-5 pr-2 text-left"
            >
              <div className="relative z-10 max-w-[210px]">
                <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-primary">
                  {item.tag}
                </div>
                <div className="mt-1 text-xl font-extrabold leading-tight text-foreground">
                  {item.title}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.description}</p>
              </div>
              <div className="relative flex h-32 w-36 shrink-0 items-center justify-center">
                <div
                  aria-hidden="true"
                  className={cn(
                    "absolute h-24 w-24 rounded-full blur-xl animate-pulse",
                    item.bgGlow,
                  )}
                />
                <img
                  src={item.image}
                  alt={item.alt}
                  className="relative h-28 w-28 object-contain drop-shadow-xl transition-transform duration-300 hover:scale-105"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Arrow Controls OUTSIDE the card box */}
      <button
        onClick={prevSlide}
        aria-label="Previous slide"
        className="absolute left-0 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-white text-foreground shadow-xl hover:bg-primary hover:text-white bounce-tap z-30 border border-black/10 transition-all duration-200"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <button
        onClick={nextSlide}
        aria-label="Next slide"
        className="absolute right-0 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-white text-foreground shadow-xl hover:bg-primary hover:text-white bounce-tap z-30 border border-black/10 transition-all duration-200"
      >
        <ChevronRight className="h-5 w-5" />
      </button>

      {/* Slide Indicators */}
      <div className="mt-4 flex items-center justify-center gap-1.5">
        {CAROUSEL_ITEMS.map((_, i) => (
          <button
            key={i}
            onClick={() => setIndex(i)}
            aria-label={`Go to slide ${i + 1}`}
            className={cn(
              "h-2 rounded-full transition-all duration-300",
              index === i ? "w-6 bg-primary" : "w-2 bg-black/15 hover:bg-black/30",
            )}
          />
        ))}
        <button
          type="button"
          onClick={() => setIsPaused((current) => !current)}
          aria-label={isPaused ? "Resume feature carousel" : "Pause feature carousel"}
          className="ml-2 grid h-7 w-7 place-items-center rounded-full border bg-white/80 text-muted-foreground transition-colors hover:text-primary"
        >
          {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
