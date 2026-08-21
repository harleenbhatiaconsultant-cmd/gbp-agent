"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  diffAddress,
  isEmptyAddress,
  validateAddress,
  type EditableAddress,
} from "@/lib/address";

/**
 * Address editor.
 *
 * The highest-risk edit in the platform, and the one this UI is most cautious
 * about. A bad address write frequently triggers Google re-verification, which
 * can take a listing offline entirely — the failure mode is not "wrong address
 * for a while", it is "invisible until a postcard arrives".
 *
 * So this editor does three things the others do not need to:
 *   - shows an explicit field-by-field diff before submission, because the
 *     approver needs to see what actually changed rather than re-read a form
 *   - calls out the two changes most likely to force re-verification: moving
 *     country, and adding an address to a profile that has none
 *   - states plainly that this always needs a human approver, since
 *     UPDATE_ADDRESS is permanently on the always-human list
 */

export interface AddressEditorProps {
  orgSlug: string;
  locationId: string;
  currentAddress: EditableAddress;
  /** True when the profile is service-area only, with no storefront. */
  isServiceAreaBusiness: boolean;
  submitAction: (formData: FormData) => Promise<void>;
}

export function AddressEditor({
  orgSlug,
  locationId,
  currentAddress,
  isServiceAreaBusiness,
  submitAction,
}: AddressEditorProps) {
  const [address, setAddress] = useState<EditableAddress>(currentAddress);

  const set = <K extends keyof EditableAddress>(field: K, value: EditableAddress[K]) =>
    setAddress({ ...address, [field]: value });

  const changes = diffAddress(currentAddress, address);
  const problems = validateAddress(address);
  const startedEmpty = isEmptyAddress(currentAddress);
  const changingCountry = changes.some((change) => change.field === "regionCode");

  return (
    <form action={submitAction} className="border-border space-y-5 rounded-lg border p-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="address" value={JSON.stringify(address)} />

      <Alert variant="destructive">
        <AlertTitle>Address changes can take a listing offline</AlertTitle>
        <AlertDescription className="text-xs">
          Editing the address often triggers Google re-verification, during which the profile may
          stop appearing in search. Only change this when the business has genuinely moved or the
          published address is wrong.
        </AlertDescription>
      </Alert>

      {isServiceAreaBusiness && startedEmpty ? (
        <Alert>
          <AlertDescription className="text-xs">
            This profile currently has no storefront address — it operates as a service-area
            business. Adding one changes how Google treats the listing and will likely require
            re-verification. If the business does not serve customers at a physical location, leave
            this empty and set a service area instead.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---- fields ------------------------------------------------------- */}
      <div className="space-y-3">
        <div className="space-y-2">
          <Label>Street address</Label>
          {address.addressLines.map((line, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={line}
                aria-label={`Address line ${index + 1}`}
                placeholder={index === 0 ? "1200 NW 23rd Ave" : "Suite, floor, building"}
                onChange={(event) => {
                  const next = [...address.addressLines];
                  next[index] = event.target.value;
                  set("addressLines", next);
                }}
              />
              {address.addressLines.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    set(
                      "addressLines",
                      address.addressLines.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {address.addressLines.length < 5 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => set("addressLines", [...address.addressLines, ""])}
            >
              Add line
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`locality-${locationId}`}>City</Label>
            <Input
              id={`locality-${locationId}`}
              value={address.locality}
              onChange={(event) => set("locality", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`region-${locationId}`}>State / region</Label>
            <Input
              id={`region-${locationId}`}
              value={address.administrativeArea}
              onChange={(event) => set("administrativeArea", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`postal-${locationId}`}>Postal code</Label>
            <Input
              id={`postal-${locationId}`}
              value={address.postalCode}
              onChange={(event) => set("postalCode", event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`country-${locationId}`}>Country</Label>
            <Input
              id={`country-${locationId}`}
              value={address.regionCode}
              maxLength={2}
              placeholder="US"
              onChange={(event) => set("regionCode", event.target.value.toUpperCase())}
            />
          </div>
        </div>
      </div>

      {/* ---- diff --------------------------------------------------------- */}
      {changes.length > 0 ? (
        <div className="border-border rounded-md border p-3">
          <h4 className="mb-2 text-sm font-medium">What will change</h4>
          <ul className="space-y-1.5 text-xs">
            {changes.map((change) => (
              <li key={change.field} className="flex flex-wrap gap-1.5">
                <span className="font-medium">{change.label}:</span>
                <span className="text-muted-foreground line-through">
                  {change.from || "(empty)"}
                </span>
                <span aria-hidden>→</span>
                <span>{change.to || "(empty)"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {changingCountry ? (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            This changes the country. That is close to creating a different business in Google&apos;s
            eyes and will almost certainly force re-verification. Confirm it is genuinely correct.
          </AlertDescription>
        </Alert>
      ) : null}

      {problems.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">
            <ul className="list-inside list-disc space-y-0.5">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---- source attribution ------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor={`address-source-${locationId}`}>Where did this address come from?</Label>
        <select
          id={`address-source-${locationId}`}
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
          placeholder="Briefly, how was this confirmed?"
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          An address is a fact about the business, so the assistant may not be its source.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={changes.length === 0 || problems.length > 0}>
          Propose address change
        </Button>
        <span className="text-muted-foreground text-xs">
          {changes.length === 0
            ? "Nothing has changed yet."
            : problems.length > 0
              ? "Fix the problems above first."
              : "Always requires a human approver — this can never be auto-applied."}
        </span>
      </div>
    </form>
  );
}
