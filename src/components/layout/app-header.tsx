import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * Presentational only — receives everything as props. Components never reach
 * into the data or integration layers (enforced by eslint.config.mjs).
 */
export interface AppHeaderOrganization {
  name: string;
  slug: string;
  role: string;
}

export interface AppHeaderProps {
  current: AppHeaderOrganization;
  organizations: AppHeaderOrganization[];
  userEmail: string;
  signOutAction: () => Promise<void>;
}

const NAV_ITEMS = [
  { href: "dashboard", label: "Dashboard" },
  { href: "locations", label: "Locations" },
  { href: "approvals", label: "Approvals" },
  { href: "settings/connections", label: "Connections" },
  { href: "settings/members", label: "Members" },
  { href: "settings/jobs", label: "Jobs" },
] as const;

export function AppHeader({
  current,
  organizations,
  userEmail,
  signOutAction,
}: AppHeaderProps) {
  return (
    <header className="border-border border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={`/${current.slug}/dashboard`} className="shrink-0 text-sm font-semibold">
            GBP Growth Agent
          </Link>

          <span className="text-muted-foreground">/</span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 gap-2">
                <span className="truncate">{current.name}</span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {current.role}
                </Badge>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {organizations.map((org) => (
                <DropdownMenuItem key={org.slug} asChild>
                  <Link href={`/${org.slug}/dashboard`}>
                    <span className="truncate">{org.name}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/new">Create organization</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-1">
          <nav className="mr-2 hidden items-center gap-1 sm:flex">
            {NAV_ITEMS.map((item) => (
              <Button key={item.href} variant="ghost" size="sm" asChild>
                <Link href={`/${current.slug}/${item.href}`}>{item.label}</Link>
              </Button>
            ))}
          </nav>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="max-w-[14rem]">
                <span className="truncate">{userEmail}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="font-normal">
                <span className="text-muted-foreground text-xs">{userEmail}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <form action={signOutAction} className="w-full">
                  <button type="submit" className="w-full cursor-default text-left">
                    Sign out
                  </button>
                </form>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
