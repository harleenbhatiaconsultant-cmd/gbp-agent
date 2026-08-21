"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DAY_KEYS, isOvernight, type DayKey, type EditablePeriod, type Schedule } from "@/lib/hours";

/**
 * Opening hours editor.
 *
 * The property that dictates this whole design: the update mask covers
 * `regularHours` wholesale, so whatever is submitted REPLACES the published
 * schedule entirely. A day left out of the payload is not "unchanged" — it is
 * CLOSED. A partially-filled form silently shuts a business on the days it
 * forgot, which is why there is no such thing as a partial hours edit here.
 *
 * Consequences of that, all deliberate:
 *   - the form is seeded from the currently published hours, never from empty
 *   - every day of the week is always present, with closed as an explicit state
 *   - closing a day that is currently open is called out before submission,
 *     because that is the destructive direction and the one worth pausing on
 *
 * Split hours (a lunch break) are supported as multiple periods per day.
 * Collapsing them to one period would quietly discard half a restaurant's
 * schedule the first time someone opened this editor.
 *
 * Overnight hours are inferred: a close time at or before the open time means
 * the business closes the following day, which is how Google models it.
 */

/**
 * Shape and conversion live in @/lib/hours so the round-trip can be tested
 * without a browser. Only presentation belongs here.
 */
const DAY_LABELS: Record<DayKey, string> = {
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};

const DAYS = DAY_KEYS.map((key) => ({ key, label: DAY_LABELS[key] }));

export interface HoursEditorProps {
  orgSlug: string;
  locationId: string;
  /** Seeded from what Google currently publishes. */
  currentSchedule: Schedule;
  submitAction: (formData: FormData) => Promise<void>;
}

function isAllDay(period: EditablePeriod): boolean {
  return period.open === "00:00" && period.close === "24:00";
}

function summarize(periods: EditablePeriod[]): string {
  if (periods.length === 0) return "Closed";
  if (periods.length === 1 && isAllDay(periods[0])) return "Open 24 hours";
  return periods
    .map((p) => `${p.open}–${p.close}${isOvernight(p) ? " (next day)" : ""}`)
    .join(", ");
}

export function HoursEditor({
  orgSlug,
  locationId,
  currentSchedule,
  submitAction,
}: HoursEditorProps) {
  const [schedule, setSchedule] = useState<Schedule>(currentSchedule);

  const setDay = (day: DayKey, periods: EditablePeriod[]) =>
    setSchedule({ ...schedule, [day]: periods });

  const closingDays = DAYS.filter(
    (day) => currentSchedule[day.key].length > 0 && schedule[day.key].length === 0,
  );

  const openingDays = DAYS.filter(
    (day) => currentSchedule[day.key].length === 0 && schedule[day.key].length > 0,
  );

  const everythingClosed = DAYS.every((day) => schedule[day.key].length === 0);

  const invalid = DAYS.some((day) =>
    schedule[day.key].some((p) => !p.open || !p.close || p.open === p.close),
  );

  const unchanged = JSON.stringify(schedule) === JSON.stringify(currentSchedule);

  return (
    <form action={submitAction} className="border-border space-y-5 rounded-lg border p-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="schedule" value={JSON.stringify(schedule)} />

      <Alert>
        <AlertDescription className="text-xs">
          Submitting replaces the published schedule in full. Any day marked closed here will be
          published as closed — this is not a partial edit.
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        {DAYS.map((day) => {
          const periods = schedule[day.key];
          const open = periods.length > 0;
          const wasOpen = currentSchedule[day.key].length > 0;

          return (
            <div key={day.key} className="border-border rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <input
                    id={`open-${locationId}-${day.key}`}
                    type="checkbox"
                    checked={open}
                    onChange={(event) =>
                      setDay(
                        day.key,
                        event.target.checked ? [{ open: "09:00", close: "17:00" }] : [],
                      )
                    }
                    className="size-4"
                  />
                  <Label htmlFor={`open-${locationId}-${day.key}`} className="cursor-pointer">
                    {day.label}
                  </Label>
                </div>

                <span className="text-muted-foreground text-xs">
                  {wasOpen && !open ? (
                    <span className="text-red-600 dark:text-red-400">
                      was {summarize(currentSchedule[day.key])} → closing
                    </span>
                  ) : (
                    summarize(periods)
                  )}
                </span>
              </div>

              {open ? (
                <div className="mt-3 space-y-2">
                  {periods.map((period, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        value={period.open}
                        aria-label={`${day.label} opening time`}
                        className="w-32"
                        onChange={(event) => {
                          const next = [...periods];
                          next[index] = { ...period, open: event.target.value };
                          setDay(day.key, next);
                        }}
                      />
                      <span className="text-muted-foreground text-xs">to</span>
                      <Input
                        type="time"
                        value={period.close === "24:00" ? "23:59" : period.close}
                        aria-label={`${day.label} closing time`}
                        className="w-32"
                        onChange={(event) => {
                          const next = [...periods];
                          next[index] = { ...period, close: event.target.value };
                          setDay(day.key, next);
                        }}
                      />
                      {isOvernight(period) ? (
                        <span className="text-muted-foreground text-xs">closes next day</span>
                      ) : null}
                      {periods.length > 1 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setDay(day.key, periods.filter((_, i) => i !== index))}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ))}

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setDay(day.key, [...periods, { open: "18:00", close: "21:00" }])}
                    >
                      Add split period
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDay(day.key, [{ open: "00:00", close: "24:00" }])}
                    >
                      Open 24 hours
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* ---- destructive-direction warnings ------------------------------- */}
      {closingDays.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            This closes {closingDays.map((d) => d.label).join(", ")}, which the profile currently
            shows as open. Customers will see the business as closed on those days.
          </AlertDescription>
        </Alert>
      ) : null}

      {everythingClosed ? (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            Every day is marked closed. That publishes a business with no opening hours at all —
            confirm that is really intended.
          </AlertDescription>
        </Alert>
      ) : null}

      {openingDays.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Opening {openingDays.map((d) => d.label).join(", ")}, which the profile currently shows
          as closed.
        </p>
      ) : null}

      {/* ---- source attribution ------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor={`hours-source-${locationId}`}>Where did these hours come from?</Label>
        <select
          id={`hours-source-${locationId}`}
          name="sourceKind"
          defaultValue="USER_INPUT"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
        >
          <option value="USER_INPUT">The customer told us</option>
          <option value="WEBSITE">Taken from their website</option>
          <option value="DOCUMENT">From a document they supplied</option>
          <option value="GBP_CURRENT">Already on the profile</option>
        </select>
        <Input
          name="sourceDetail"
          required
          placeholder="Briefly, how were these confirmed?"
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Opening hours are a fact about the business, so the assistant may not be their source.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={unchanged || invalid}>
          Propose hours change
        </Button>
        {invalid ? (
          <span className="text-muted-foreground text-xs">
            Every open day needs an opening and closing time, and they cannot be identical.
          </span>
        ) : unchanged ? (
          <span className="text-muted-foreground text-xs">Nothing has changed yet.</span>
        ) : (
          <span className="text-muted-foreground text-xs">Goes to the approval queue.</span>
        )}
      </div>
    </form>
  );
}
