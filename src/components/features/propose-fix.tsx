import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Form for proposing a fix from an audit finding.
 *
 * Covers the single-value actions. Categories, hours and address need richer
 * editors and are not offered here — an incomplete editor for those would be
 * worse than none, since a half-filled hours payload ERASES the days it omits.
 */
export const PROPOSABLE_ACTIONS = [
  "UPDATE_WEBSITE",
  "UPDATE_PHONE",
  "UPDATE_DESCRIPTION",
  "UPDATE_TITLE",
] as const;

export type ProposableAction = (typeof PROPOSABLE_ACTIONS)[number];

export function isProposable(actionType: string | null): actionType is ProposableAction {
  return actionType !== null && (PROPOSABLE_ACTIONS as readonly string[]).includes(actionType);
}

const FIELD_CONFIG: Record<
  ProposableAction,
  { label: string; placeholder: string; multiline?: boolean; type?: string; help: string }
> = {
  UPDATE_WEBSITE: {
    label: "Website URL",
    placeholder: "https://example.com/portland",
    type: "url",
    help: "For a business with several locations, link the location page rather than the homepage.",
  },
  UPDATE_PHONE: {
    label: "Primary phone number",
    placeholder: "+1 555-0100",
    type: "tel",
    help: "Use the number a customer should actually reach, including country code.",
  },
  UPDATE_DESCRIPTION: {
    label: "Business description",
    placeholder: "What the business does, who it serves, and where.",
    multiline: true,
    help: "Up to 750 characters. This is checked for ranking claims and keyword stuffing before it can be queued.",
  },
  UPDATE_TITLE: {
    label: "Business name",
    placeholder: "The name the business trades under",
    help: "Must be the real trading name. Adding a city or service keyword is refused — that is a Google policy violation.",
  },
};

export interface ProposeFixProps {
  orgSlug: string;
  locationId: string;
  findingId: string;
  actionType: ProposableAction;
  action: (formData: FormData) => Promise<void>;
}

export function ProposeFix({
  orgSlug,
  locationId,
  findingId,
  actionType,
  action,
}: ProposeFixProps) {
  const config = FIELD_CONFIG[actionType];
  const fieldId = `value-${findingId}`;

  return (
    <form action={action} className="border-border space-y-3 rounded-lg border p-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="actionType" value={actionType} />
      <input type="hidden" name="findingId" value={findingId} />

      <div className="space-y-2">
        <Label htmlFor={fieldId}>{config.label}</Label>
        {config.multiline ? (
          <Textarea id={fieldId} name="value" required rows={4} placeholder={config.placeholder} />
        ) : (
          <Input
            id={fieldId}
            name="value"
            required
            type={config.type ?? "text"}
            placeholder={config.placeholder}
          />
        )}
        <p className="text-muted-foreground text-xs">{config.help}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`source-${findingId}`}>Where did this value come from?</Label>
        <select
          id={`source-${findingId}`}
          name="sourceKind"
          defaultValue="USER_INPUT"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
        >
          <option value="USER_INPUT">The customer told us</option>
          <option value="WEBSITE">Taken from their website</option>
          <option value="DOCUMENT">From a document they supplied</option>
          <option value="GBP_CURRENT">Already on the profile</option>
          {actionType === "UPDATE_DESCRIPTION" ? (
            <option value="AI_GENERATED">Drafted by the assistant</option>
          ) : null}
        </select>
        <Input
          name="sourceDetail"
          required
          placeholder="Briefly, how was this confirmed?"
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          Every change records its source. Facts such as a phone number or address may not originate
          from the assistant — only a person, the website, or a supplied document.
        </p>
      </div>

      <Button type="submit" size="sm">
        Propose this fix
      </Button>
    </form>
  );
}
