import { getHealthReport } from "@/server/services/health";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-emerald-500/20",
  degraded: "bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-amber-500/20",
  unconfigured: "bg-muted text-muted-foreground ring-border",
  error: "bg-red-500/10 text-red-700 dark:text-red-400 ring-red-500/20",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        STATUS_STYLES[status] ?? STATUS_STYLES.unconfigured
      }`}
    >
      {status}
    </span>
  );
}

export default async function Home() {
  const health = await getHealthReport();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <header className="mb-10">
        <p className="text-muted-foreground text-sm font-medium">Phase 0 · Foundation</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">GBP Growth Agent</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Google Business Profile management and local SEO optimization. This shell exists to
          prove the foundation boots; product features begin in Phase 1.
        </p>
      </header>

      <section className="border-border rounded-lg border p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">System health</h2>
          <StatusPill status={health.status} />
        </div>

        <dl className="divide-border divide-y text-sm">
          {health.dependencies.map((dep) => (
            <div key={dep.name} className="flex items-start justify-between gap-4 py-2.5">
              <div>
                <dt className="font-medium">{dep.name}</dt>
                {dep.detail ? (
                  <dd className="text-muted-foreground mt-0.5 text-xs">{dep.detail}</dd>
                ) : null}
              </div>
              <dd className="flex shrink-0 items-center gap-2">
                {typeof dep.latencyMs === "number" ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {dep.latencyMs}ms
                  </span>
                ) : null}
                <StatusPill status={dep.status} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-border mt-6 rounded-lg border p-5">
        <h2 className="mb-4 text-sm font-semibold">Write safety</h2>
        <dl className="divide-border divide-y text-sm">
          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium">GBP write mode</dt>
            <dd>
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                {health.gbpWriteMode}
              </code>
            </dd>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <dt className="font-medium">Unattended auto-apply</dt>
            <dd>
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                {health.autoApplyEnabled ? "enabled" : "disabled"}
              </code>
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          In <code>validate_only</code> mode every write is sent to Google with{" "}
          <code>validateOnly=true</code> and mutates nothing. Google provides no sandbox, so this
          is the only safe rehearsal available.
        </p>
      </section>

      <footer className="text-muted-foreground mt-10 text-xs">
        Environment: {health.environment} · Checked {health.checkedAt}
      </footer>
    </main>
  );
}
