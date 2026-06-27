import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// UX preferences for the Bridge: rich text formatting and streaming Previews
export const UxPreferencesSchema = Type.Object(
  {
    richText: Type.Optional(Type.Boolean()),
    streamPreviews: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type UxPreferences = Static<typeof UxPreferencesSchema>;

// Default UX preferences applied when ux is omitted or flags are missing
export const DEFAULT_UX: UxPreferences = {
  richText: true,
  streamPreviews: true,
};

// Config is the user-edited settings: bot token and UX preferences
export const PigramConfigSchema = Type.Object(
  {
    botToken: Type.String({ minLength: 1 }),
    ux: Type.Optional(UxPreferencesSchema),
  },
  { additionalProperties: false }
);

export type PigramConfig = Static<typeof PigramConfigSchema>;

type ValidationResult =
  | { ok: true; config: PigramConfig }
  | { ok: false; errors: string[] };

export function validateConfig(input: unknown): ValidationResult {
  // Basic type check
  if (!Value.Check(PigramConfigSchema, input)) {
    const errors = [...Value.Errors(PigramConfigSchema, input)].map(
      (err) => `${err.path}: ${err.message}`
    );
    return { ok: false, errors };
  }

  // Apply defaults for ux
  const config: PigramConfig = {
    ...input,
    ux: input.ux ? { ...DEFAULT_UX, ...input.ux } : { ...DEFAULT_UX },
  };

  return { ok: true, config };
}
