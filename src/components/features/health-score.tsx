import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export interface HealthScoreCategory {
  category: string;
  score: number | null;
  earned: number;
  available: number;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
}

export interface HealthScoreProps {
  score: number | null;
  coverage: { evaluated: number; skipped: number; total: number; weightRatio: number };
  categories: HealthScoreCategory[];
  skippedReasons: Array<{ ruleId: string; title: string; reason: string }>;
}

const BAND_STYLES: Record<string, string> = {
  unknown: "text-muted-foreground",
  poor: "text-red-600 dark:text-red-400",
  fair: "text-amber-600 dark:text-amber-400",
  good: "text-sky-600 dark:text-sky-400",
  strong: "text-emerald-600 dark:text-emerald-400",
};

function band(score: number | null): string {
  if (score === null) return "unknown";
  if (score < 50) return "poor";
  if (score < 70) return "fair";
  if (score < 90) return "good";
  return "strong";
}

const CATEGORY_LABELS: Record<string, string> = {
  profile_completeness: "Profile fundamentals",
  categories: "Categories",
  contact: "Contact details",
  hours: "Opening hours",
  content: "Content",
  reviews: "Reviews",
  website: "Website",
};

/**
 * Score and coverage are shown together, deliberately.
 *
 * A score computed over half the checks is not comparable to one computed over
 * all of them, and presenting the number alone would overstate the health of a
 * profile whose reviews and website are not connected yet.
 */
export function HealthScore({ score, coverage, categories, skippedReasons }: HealthScoreProps) {
  const coveragePercent = Math.round(coverage.weightRatio * 100);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <div className={`text-5xl font-semibold tabular-nums ${BAND_STYLES[band(score)]}`}>
            {score ?? "—"}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Health score {score === null ? "(no checks could run)" : "out of 100"}
          </p>
        </div>

        <div className="min-w-[12rem] flex-1">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Check coverage</span>
            <span className="tabular-nums">
              {coverage.evaluated} of {coverage.total} checks
            </span>
          </div>
          <Progress value={coveragePercent} />
          <p className="text-muted-foreground mt-1.5 text-xs">
            {coverage.skipped > 0
              ? `${coverage.skipped} check(s) could not run. The score covers ${coveragePercent}% of the ruleset by weight.`
              : "Every check in the ruleset ran."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {categories.map((category) => (
          <div key={category.category} className="border-border rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {CATEGORY_LABELS[category.category] ?? category.category}
              </span>
              <span className={`text-sm font-semibold tabular-nums ${BAND_STYLES[band(category.score)]}`}>
                {category.score ?? "—"}
              </span>
            </div>
            <div className="text-muted-foreground mt-1 flex gap-3 text-xs">
              <span>{category.checksPassed} passed</span>
              <span>{category.checksFailed} failed</span>
              {category.checksSkipped > 0 ? <span>{category.checksSkipped} skipped</span> : null}
            </div>
          </div>
        ))}
      </div>

      {skippedReasons.length > 0 ? (
        <div className="border-border rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-medium">Checks that could not run</h3>
          <ul className="space-y-2">
            {skippedReasons.map((skipped) => (
              <li key={skipped.ruleId} className="flex items-start gap-2 text-xs">
                <Badge variant="outline" className="shrink-0">
                  skipped
                </Badge>
                <span>
                  <span className="font-medium">{skipped.title}</span>
                  <span className="text-muted-foreground"> — {skipped.reason}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            Skipped checks are excluded from the score rather than counted as passes, so the number
            above is not inflated by data that is missing.
          </p>
        </div>
      ) : null}
    </div>
  );
}
