"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Clapperboard } from "lucide-react";

const items = [
  { href: "/", label: "Crear clips", icon: Clapperboard },
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="mb-6 inline-flex rounded-xl border border-(--line) bg-(--surface) p-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-(--accent) text-(--accent-fg)"
                : "text-(--muted-fg) hover:bg-(--surface-2) hover:text-(--foreground)"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

