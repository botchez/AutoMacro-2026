import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Utensils, History, LogOut, Menu, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Mascot } from "./Mascot";
import { FloatingCoach } from "./FloatingCoach";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/log-food", label: "Log Food", icon: Utensils },
  { to: "/history", label: "History", icon: History },
] as const;

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { logout, user } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const doLogout = async () => {
    await logout();
    navigate({ to: "/" });
  };

  const NavItems = () => (
    <>
      {nav.map(({ to, label, icon: Icon }) => {
        const active = pathname === to;
        return (
          <Link
            key={to}
            to={to}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold bounce-tap",
              active
                ? "bg-primary text-primary-foreground shadow-md"
                : "text-foreground/70 hover:bg-sidebar-accent",
            )}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </Link>
        );
      })}
      <button
        onClick={doLogout}
        className="mt-2 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-foreground/70 hover:bg-sidebar-accent bounce-tap"
      >
        <LogOut className="h-5 w-5" />
        Log out
      </button>
    </>
  );

  return (
    <div className="min-h-screen flex w-full">
      {/* Sidebar desktop */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col gap-3 p-4 bg-sidebar border-r border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <Mascot size={44} className="animate-float" />
          <div>
            <div className="text-lg font-extrabold tracking-tight">NutriCoach</div>
            <div className="text-[11px] text-muted-foreground">Fuel your day 🌱</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1 mt-2">
          <NavItems />
        </nav>
        <div className="mt-auto rounded-2xl bg-sidebar-accent p-3 text-xs text-sidebar-accent-foreground">
          <div className="font-bold">Hey {user?.name ?? "friend"} 👋</div>
          <div className="opacity-80 mt-1">Every log is a win. Let's crush today's goals!</div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between p-3 bg-sidebar/95 backdrop-blur border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <Mascot size={32} />
          <span className="font-extrabold">NutriCoach</span>
        </div>
        <button
          className="rounded-xl p-2 bg-primary text-primary-foreground bounce-tap"
          onClick={() => setOpen((o) => !o)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {open && (
        <div className="md:hidden fixed inset-0 top-14 z-30 bg-sidebar/98 backdrop-blur p-4 flex flex-col gap-1 animate-pop">
          <NavItems />
        </div>
      )}

      <main className="flex-1 min-w-0 pt-16 md:pt-0">
        <div className="mx-auto max-w-6xl p-4 md:p-8">{children}</div>
      </main>
      <FloatingCoach />
    </div>
  );
}
