import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export interface FindingItem {
  id: string;
  ruleId: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  detail: string;
  evidence: unknown;
  autoFixable: boolean;
  suggestedActionType: string | null;
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-500/10 text-red-700 dark:text-red-400 ring-red-500/20",
  HIGH: "bg-orange-500/10 text-orange-700 dark:text-orange-400 ring-orange-500/20",
  MEDIUM: "bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-amber-500/20",
  LOW: "bg-sky-500/10 text-sky-700 dark:text-sky-400 ring-sky-500/20",
  INFO: "bg-muted text-muted-foreground ring-border",
};

function SeverityPill({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ring-1 ring-inset ${
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.INFO
      }`}
    >
      {severity}
    </span>
  );
}

export function FindingsList({ findings }: { findings: FindingItem[] }) {
  if (findings.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm font-medium">No open issues</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Every check that ran against this profile passed.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
      SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]),
  );

  return (
    <div className="space-y-3">
      {sorted.map((finding) => (
        <Card key={finding.id}>
          <CardContent className="space-y-2 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <SeverityPill severity={finding.severity} />
                <h3 className="text-sm font-medium">{finding.title}</h3>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {finding.autoFixable ? (
                  <Badge variant="secondary" className="text-[10px]">
                    fixable via API
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    needs manual action
                  </Badge>
                )}
              </div>
            </div>

            <p className="text-muted-foreground text-sm leading-relaxed">{finding.detail}</p>

            {finding.evidence ? (
              <details className="text-xs">
                <summary className="text-muted-foreground cursor-pointer select-none">
                  Evidence
                </summary>
                <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 text-[11px]">
                  {JSON.stringify(finding.evidence, null, 2)}
                </pre>
              </details>
            ) : null}

            <p className="text-muted-foreground text-[11px]">
              Check: <code>{finding.ruleId}</code>
              {finding.suggestedActionType ? (
                <>
                  {" · "}Suggested action: <code>{finding.suggestedActionType}</code> (requires
                  approval)
                </>
              ) : null}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
