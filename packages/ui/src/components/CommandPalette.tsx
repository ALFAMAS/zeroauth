"use client";

import {
  Bell,
  Building2,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Monitor,
  Settings,
  ShieldCheck,
  User,
  Webhook,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/commandPalette";
import { safeRelativeRedirect } from "@/lib/safeRedirect";

interface PaletteDestination {
  title: string;
  description?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: "Pages" | "Settings";
}

// Static dashboard destinations the command palette can jump to.
const DESTINATIONS: PaletteDestination[] = [
  {
    title: "Dashboard",
    description: "Overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    group: "Pages",
  },
  {
    title: "Profile",
    description: "Your profile",
    href: "/dashboard/profile",
    icon: User,
    group: "Pages",
  },
  {
    title: "Security",
    description: "Passkeys, MFA, sessions",
    href: "/dashboard/security",
    icon: ShieldCheck,
    group: "Pages",
  },
  {
    title: "Sessions",
    description: "Active sessions",
    href: "/dashboard/sessions",
    icon: Monitor,
    group: "Pages",
  },
  {
    title: "Notifications",
    description: "Notification center",
    href: "/dashboard/notifications",
    icon: Bell,
    group: "Pages",
  },
  {
    title: "Organizations",
    description: "Workspaces & teams",
    href: "/dashboard/organizations",
    icon: Building2,
    group: "Pages",
  },
  {
    title: "API Keys",
    description: "Manage API keys",
    href: "/dashboard/api-keys",
    icon: KeyRound,
    group: "Pages",
  },
  {
    title: "Webhooks",
    description: "Outgoing webhooks",
    href: "/dashboard/webhooks",
    icon: Webhook,
    group: "Pages",
  },
  {
    title: "Billing",
    description: "Plans & invoices",
    href: "/dashboard/billing",
    icon: CreditCard,
    group: "Pages",
  },
  {
    title: "Support",
    description: "Contact support",
    href: "/dashboard/support",
    icon: LifeBuoy,
    group: "Pages",
  },
  {
    title: "Account",
    description: "Account settings",
    href: "/dashboard/account",
    icon: Settings,
    group: "Settings",
  },
];

const GROUPS: PaletteDestination["group"][] = ["Pages", "Settings"];

export function CommandPalette() {
  "use memo";

  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Cmd+K / Ctrl+K to open; topbar search dispatches OPEN_COMMAND_PALETTE_EVENT.
  // Escape-to-close and focus management are handled by the underlying Radix Dialog.
  useEffect(() => {
    function openPalette() {
      setOpen(true);
    }

    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }

    document.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openPalette);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  function navigateTo(href: string) {
    setOpen(false);
    router.push(safeRelativeRedirect(href, "/dashboard"));
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} label="Command palette" inputLabel="Search">
      <CommandInput placeholder="Search pages, settings…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {GROUPS.map((group) => (
          <CommandGroup key={group} heading={group}>
            {DESTINATIONS.filter((d) => d.group === group).map((destination) => (
              <CommandItem
                key={destination.href}
                value={`${destination.title} ${destination.description ?? ""}`}
                onSelect={() => navigateTo(destination.href)}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <destination.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{destination.title}</div>
                  {destination.description && (
                    <div className="truncate text-xs text-muted-foreground">
                      {destination.description}
                    </div>
                  )}
                </div>
                <CommandShortcut>↵</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
