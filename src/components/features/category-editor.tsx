"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Category editor.
 *
 * The primary category is the strongest ranking signal a profile has, and a
 * wrong one is the most damaging non-fatal error there is — so this deliberately
 * does not let anyone set a category by typing a guess. It searches Google's
 * own taxonomy and you pick from what comes back.
 *
 * When the taxonomy cannot be reached (API access not approved yet), it falls
 * back to entering a known id, clearly labelled as such. That fallback keeps
 * the editor usable rather than pretending the feature does not exist; it is
 * not the intended path.
 *
 * Google caps secondary categories at 9, and every one dilutes relevance, so
 * the UI shows the count rather than encouraging people to fill the slots.
 */

const MAX_SECONDARY = 9;
const GCID_PATTERN = /^gcid:[a-z0-9_]+$/;

export interface CategoryOption {
  id: string;
  displayName: string;
}

export type SearchResult =
  | { available: true; categories: CategoryOption[] }
  | { available: false; reason: string };

export interface CategoryEditorProps {
  orgSlug: string;
  locationId: string;
  currentPrimary: CategoryOption | null;
  currentSecondary: CategoryOption[];
  searchAction: (locationId: string, query: string) => Promise<SearchResult>;
  submitAction: (formData: FormData) => Promise<void>;
}

export function CategoryEditor({
  orgSlug,
  locationId,
  currentPrimary,
  currentSecondary,
  searchAction,
  submitAction,
}: CategoryEditorProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CategoryOption[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [isSearching, startSearch] = useTransition();

  const [primary, setPrimary] = useState<CategoryOption | null>(currentPrimary);
  const [secondary, setSecondary] = useState<CategoryOption[]>(currentSecondary);
  const [manualId, setManualId] = useState("");

  const runSearch = () => {
    startSearch(async () => {
      const result = await searchAction(locationId, query);
      setSearched(true);
      if (result.available) {
        setResults(result.categories);
        setUnavailable(null);
      } else {
        setResults([]);
        setUnavailable(result.reason);
      }
    });
  };

  const addManualId = () => {
    const id = manualId.trim();
    if (!GCID_PATTERN.test(id)) return;
    const option = { id, displayName: id };
    if (!primary) setPrimary(option);
    else if (secondary.length < MAX_SECONDARY && !isSelected(id)) {
      setSecondary([...secondary, option]);
    }
    setManualId("");
  };

  const isSelected = (id: string) =>
    primary?.id === id || secondary.some((category) => category.id === id);

  const manualIdValid = GCID_PATTERN.test(manualId.trim());
  const unchanged =
    primary?.id === currentPrimary?.id &&
    secondary.length === currentSecondary.length &&
    secondary.every((category, index) => category.id === currentSecondary[index]?.id);

  return (
    <form action={submitAction} className="border-border space-y-5 rounded-lg border p-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="primaryCategoryId" value={primary?.id ?? ""} />
      <input type="hidden" name="primaryCategoryName" value={primary?.displayName ?? ""} />
      <input
        type="hidden"
        name="additionalCategoryIds"
        value={secondary.map((category) => category.id).join(",")}
      />

      {/* ---- current selection ------------------------------------------- */}
      <div className="space-y-2">
        <Label>Primary category</Label>
        {primary ? (
          <div className="flex items-center gap-2">
            <Badge>{primary.displayName}</Badge>
            <code className="text-muted-foreground text-xs">{primary.id}</code>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setPrimary(null)}
            >
              Clear
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            None selected. Search below and choose the most specific category that describes the
            main service.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>
          Secondary categories{" "}
          <span className="text-muted-foreground font-normal">
            ({secondary.length} of {MAX_SECONDARY})
          </span>
        </Label>
        {secondary.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {secondary.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSecondary(secondary.filter((c) => c.id !== category.id))
                  }
                  className="border-border hover:bg-muted inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                  aria-label={`Remove ${category.displayName}`}
                >
                  {category.displayName}
                  <span aria-hidden className="text-muted-foreground">
                    ×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">None.</p>
        )}
        <p className="text-muted-foreground text-xs">
          Add only categories describing services the business actually offers. Each additional
          one dilutes relevance rather than adding reach.
        </p>
      </div>

      {/* ---- search ------------------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor={`category-search-${locationId}`}>Search Google&apos;s categories</Label>
        <div className="flex gap-2">
          <Input
            id={`category-search-${locationId}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. dentist"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={runSearch}
            disabled={isSearching || query.trim().length < 2}
          >
            {isSearching ? "Searching…" : "Search"}
          </Button>
        </div>

        {unavailable ? (
          <Alert>
            <AlertDescription className="text-xs">{unavailable}</AlertDescription>
          </Alert>
        ) : null}

        {searched && !unavailable && results.length === 0 ? (
          <p className="text-muted-foreground text-xs">No categories matched that search.</p>
        ) : null}

        {results.length > 0 ? (
          <ul className="border-border max-h-56 divide-y divide-border overflow-y-auto rounded-md border">
            {results.map((category) => {
              const selected = isSelected(category.id);
              return (
                <li
                  key={category.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="text-sm">{category.displayName}</span>
                    <code className="text-muted-foreground ml-2 text-[11px]">{category.id}</code>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={primary?.id === category.id ? "secondary" : "outline"}
                      onClick={() => setPrimary(category)}
                    >
                      Primary
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={selected || secondary.length >= MAX_SECONDARY}
                      onClick={() => setSecondary([...secondary, category])}
                    >
                      Add
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* ---- manual fallback ---------------------------------------------- */}
      {unavailable ? (
        <div className="space-y-2">
          <Label htmlFor={`category-manual-${locationId}`}>Or enter a known category id</Label>
          <div className="flex gap-2">
            <Input
              id={`category-manual-${locationId}`}
              value={manualId}
              onChange={(event) => setManualId(event.target.value)}
              placeholder="gcid:dentist"
            />
            <Button type="button" variant="outline" onClick={addManualId} disabled={!manualIdValid}>
              Add
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Must look like <code>gcid:dentist</code>. Google rejects ids outside its taxonomy, so a
            guess will fail validation rather than be applied.
          </p>
        </div>
      ) : null}

      {/* ---- source attribution ------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor={`category-source-${locationId}`}>
          Where did this categorisation come from?
        </Label>
        <select
          id={`category-source-${locationId}`}
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
          Categories are a fact about the business, so the assistant may not be their source.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!primary || unchanged}>
          Propose category change
        </Button>
        {!primary ? (
          <span className="text-muted-foreground text-xs">A primary category is required.</span>
        ) : unchanged ? (
          <span className="text-muted-foreground text-xs">Nothing has changed yet.</span>
        ) : (
          <span className="text-muted-foreground text-xs">
            Goes to the approval queue — category changes always need a human approver.
          </span>
        )}
      </div>
    </form>
  );
}
