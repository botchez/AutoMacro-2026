import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Utensils,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Mascot } from "./Mascot";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/log-food", label: "Log Food", icon: Utensils },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings2 },
] as const;

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { logout } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("nutricoach:sidebar-collapsed") === "true",
  );

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("nutricoach:sidebar-collapsed", String(next));
      return next;
    });
  };

  const doLogout = async () => {
    await logout();
    navigate({ to: "/" });
  };

  const NavItems = ({ compact = false }: { compact?: boolean }) => (
    <>
      {nav.map(({ to, label, icon: Icon }) => {
        const active = pathname === to;
        return (
          <Link
            key={to}
            to={to}
            onClick={() => setOpen(false)}
            title={compact ? label : undefined}
            className={cn(
              "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold bounce-tap",
              compact && "justify-center px-3",
              active
                ? "bg-primary text-primary-foreground shadow-md"
                : "text-foreground/70 hover:bg-sidebar-accent",
            )}
          >
            <Icon className="h-5 w-5" />
            <span className={compact ? "sr-only" : undefined}>{label}</span>
          </Link>
        );
      })}
      <button
        onClick={doLogout}
        title={compact ? "Log out" : undefined}
        className={cn(
          "mt-2 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-foreground/70 hover:bg-sidebar-accent bounce-tap",
          compact && "justify-center px-3",
        )}
      >
        <LogOut className="h-5 w-5" />
        <span className={compact ? "sr-only" : undefined}>Log out</span>
      </button>
    </>
  );

  return (
    <div className="min-h-screen flex w-full">
      {/* Sidebar desktop */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar transition-[width,padding] duration-300 md:flex",
          collapsed ? "w-20 p-3" : "w-64 p-4",
        )}
      >
        <div
          className={cn(
            "flex gap-2 py-2",
            collapsed ? "flex-col items-center" : "items-center justify-between px-2",
          )}
        >
          <div className="flex items-center gap-2">
            <Mascot size={collapsed ? 40 : 44} className="animate-float shrink-0" />
            {!collapsed && (
              <div>
                <div className="text-lg font-extrabold tracking-tight">NutriCoach</div>
                <div className="text-[11px] text-muted-foreground">Fuel your day</div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>
        <nav className="flex flex-col gap-1 mt-2">
          <NavItems compact={collapsed} />
        </nav>
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
    </div>
  );
}
