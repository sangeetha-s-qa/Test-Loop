"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Bug, ChevronDown, FileBarChart, FolderKanban, LayoutDashboard, LogOut, Menu, Play, Settings, Sparkles, Stethoscope, TestTube2, Users, Wand2, X } from "lucide-react";
import { Wordmark } from "@/components/logo";
import { NotificationBell } from "@/components/notification-bell";
import { api, type Me } from "@/lib/api";

/**
 * Shared application chrome.
 *
 * Every entry here resolves to a page backed by a real endpoint. Nothing is listed that cannot be
 * opened: an earlier version carried three "pipeline" entries that all pointed at /test-runs, which
 * reads as navigation but is not.
 */
const nav = [
  {
    heading: "MAIN",
    items: [
      { label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
      { label: "Projects", icon: FolderKanban, href: "/projects" },
      { label: "Test Runs", icon: Play, href: "/test-runs" },
      { label: "Test Cases", icon: TestTube2, href: "/test-cases" },
      { label: "Bugs", icon: Bug, href: "/bugs" },
      { label: "Reports", icon: FileBarChart, href: "/reports" },
      { label: "Team", icon: Users, href: "/team" },
    ],
  },
  {
    heading: "AI FEATURES",
    items: [
      { label: "AI Test Generator", icon: Wand2, href: "/ai/generation" },
      { label: "AI Bug Analyzer", icon: Sparkles, href: "/ai/analysis" },
      { label: "Self Healing", icon: Stethoscope, href: "/ai/healing" },
      { label: "Visual Testing", icon: Activity, href: "/visual" },
    ],
  },
];

function initials(name: string | undefined) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** Marks a nav entry active for its own route and anything nested beneath it. */
function isActive(pathname: string, href: string) {
  // "/" is the public landing page now, not a nav destination, so no entry claims a bare match.
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children, title, subtitle, actions }: { children: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<Me>("/api/v1/auth/me")
      .then(setMe)
      .catch(() => setSignedOut(true));
  }, []);

  // Close the account menu on an outside click or Escape, so it never strands the page.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  /** Clears the server session first; the reload then lands on the sign-in screen. */
  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      // Even if the call fails the local view must not keep claiming a session.
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen bg-[#f5f7fb]">
      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-[#111c38] text-white transition-transform lg:static lg:translate-x-0 ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
          {/* The mark links to the dashboard, not to "/", because "/" is the marketing page and a
              signed-in user clicking the logo wants their work, not the pitch. */}
          <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="Testloop dashboard">
            <Wordmark tone="light" size={26} />
          </Link>
          <button onClick={() => setMenuOpen(false)} className="rounded p-1 lg:hidden" aria-label="Close navigation">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-6" aria-label="Main">
          {nav.map(group => (
            <div key={group.heading}>
              <p className="px-3 pb-2 text-[10px] font-bold tracking-[.16em] text-slate-500">{group.heading}</p>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setMenuOpen(false)}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "bg-violet-500/20 font-semibold text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}
                    >
                      <item.icon size={17} className={active ? "text-violet-300" : ""} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          <div>
            <p className="px-3 pb-2 text-[10px] font-bold tracking-[.16em] text-slate-500">SETTINGS</p>
            <Link
              href="/settings"
              aria-current={isActive(pathname, "/settings") ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${isActive(pathname, "/settings") ? "bg-violet-500/20 font-semibold text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}
            >
              <Settings size={17} className={isActive(pathname, "/settings") ? "text-violet-300" : ""} />
              Settings
            </Link>
          </div>
        </nav>

        <div className="border-t border-white/10 p-3" ref={userMenuRef}>
          {me?.user ? (
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(value => !value)}
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
                className="flex w-full items-center gap-3 rounded-lg bg-white/5 p-2.5 text-left hover:bg-white/10"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-400 text-xs font-bold text-slate-900">{initials(me.user.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{me.user.name}</span>
                  <span className="block truncate text-xs capitalize text-slate-400">{me.role.toLowerCase()}</span>
                </span>
                <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {userMenuOpen && (
                <div role="menu" className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-lg">
                  <p className="truncate border-b border-slate-100 px-3 py-2.5 text-xs text-slate-500">{me.user.email}</p>
                  <Link role="menuitem" href="/settings" className="flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium hover:bg-slate-50">
                    <Settings size={15} />
                    Settings
                  </Link>
                  <button role="menuitem" onClick={signOut} disabled={signingOut} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60">
                    <LogOut size={15} />
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              )}
            </div>
          ) : signedOut ? (
            <Link href="/login" className="block rounded-lg bg-violet-500 px-3 py-2.5 text-center text-sm font-bold">
              Sign in
            </Link>
          ) : (
            <div className="h-14 animate-pulse rounded-lg bg-white/5" />
          )}
        </div>
      </aside>

      {menuOpen && <button aria-label="Close navigation" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <button onClick={() => setMenuOpen(true)} aria-controls="app-sidebar" aria-expanded={menuOpen} className="rounded-lg p-2 hover:bg-slate-100 lg:hidden" aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg font-bold text-slate-900">{title}</h1>
            {subtitle && <p className="truncate text-sm text-slate-500">{subtitle}</p>}
          </div>
          {actions}
          {me?.user && <NotificationBell />}
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
