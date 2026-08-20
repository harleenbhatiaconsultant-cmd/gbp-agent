import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Layer boundaries (ARCHITECTURE.md §1.2) are enforced here rather than left to
 * code review. The rule in prose is:
 *
 *   "A React component never imports from integrations/, and a route handler
 *    never imports Prisma directly. Everything crosses through services/."
 *
 * Below is that rule, mechanically.
 */

const NO_DATA_LAYER = {
  group: ["@/server/db", "@/server/db/**", "@/generated/prisma/client"],
  message:
    "Do not access the database directly here. Go through a service in @/server/services/* so tenant scoping, RBAC and audit logging are applied.",
};

const NO_INTEGRATIONS = {
  group: ["@/server/integrations", "@/server/integrations/**"],
  message:
    "Do not call an external API directly here. Go through a service in @/server/services/* so errors, retries and quota governance are applied.",
};

const NO_SERVER_ENV = {
  group: ["@/config/env.server"],
  message:
    "Server environment contains secrets and must never reach the browser. Use @/config/env.client for public values.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Prisma client — not ours to lint.
    "src/generated/**",
  ]),

  // React components: presentation only.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [NO_DATA_LAYER, NO_INTEGRATIONS, NO_SERVER_ENV] },
      ],
    },
  },

  // Route handlers and webhooks: thin. Validate, delegate, respond.
  {
    files: ["src/app/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [NO_DATA_LAYER, NO_INTEGRATIONS] },
      ],
    },
  },

  // Pages and layouts: may call services, never the data or integration layers.
  {
    files: ["src/app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [NO_DATA_LAYER, NO_INTEGRATIONS] },
      ],
    },
  },

  // The integration layer must not depend on business logic or the database —
  // it translates an external API into typed results and nothing more.
  {
    files: ["src/server/integrations/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_DATA_LAYER,
            {
              group: ["@/server/services", "@/server/services/**"],
              message:
                "Integrations must not depend on services — that inverts the layering. Services call integrations.",
            },
          ],
        },
      ],
    },
  },

  // Audit rules must be pure functions over a snapshot: no I/O of any kind, so
  // they stay unit-testable offline and an audit stays reproducible.
  {
    files: ["src/server/audit/rules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_DATA_LAYER,
            NO_INTEGRATIONS,
            {
              group: ["@/server/services", "@/server/services/**"],
              message:
                "Audit rules must be pure functions of a snapshot. No service calls, no I/O — that is what makes an audit reproducible and testable.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
