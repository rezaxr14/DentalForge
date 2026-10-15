"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

/** Module links with the current section marked (`aria-current`, not colour alone: it is also bolder). */
export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Modules" className="order-last -mx-2 flex w-full items-center gap-x-1 overflow-x-auto px-2 text-sm whitespace-nowrap md:order-none md:mx-0 md:w-auto md:flex-wrap md:overflow-visible md:px-0">
      {items.map((n) => {
        const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground ${
              active ? "bg-accent font-medium text-foreground" : "text-zinc-600"
            }`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
