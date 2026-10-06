"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { AppNotification } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

const ago = (value: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

/** In-app notifications: assigned to you, ready for retest, reopened, commented, status changed. */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Polled while the page is open; a dropped request simply waits for the next interval.
  const feed = useResource(() => api.get<{ items: AppNotification[]; unreadCount: number }>("/api/v1/notifications"), [], { intervalMs: 30_000, shouldPoll: () => true });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = feed.data?.unreadCount ?? 0;

  const openItem = async (item: AppNotification) => {
    setOpen(false);
    if (!item.readAt) await api.post(`/api/v1/notifications/${item.id}/read`).catch(() => undefined);
    feed.reload();
    if (item.bug) router.push(`/bugs/${item.bug.id}`);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen(value => !value);
          if (!open) feed.reload();
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative grid h-10 w-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <Bell size={19} />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="font-display text-sm font-bold text-slate-900">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={async () => { await api.post("/api/v1/notifications/read-all"); feed.reload(); }} className="flex items-center gap-1 text-xs font-semibold text-violet-700 hover:underline">
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[26rem] overflow-y-auto">
            {feed.data?.items.length ? (
              feed.data.items.map(item => (
                <li key={item.id}>
                  <button type="button" onClick={() => openItem(item)} className={`flex w-full gap-3 border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 ${item.readAt ? "" : "bg-violet-50/50"}`}>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-violet-600"}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{item.title}</span>
                      {item.body && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{item.body}</span>}
                      <span className="mt-0.5 block text-[11px] text-slate-400">{item.actor?.name ?? "Testloop"} · {ago(item.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-4 py-8 text-center text-sm text-slate-500">{feed.loading ? "Loading…" : "You're all caught up."}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
