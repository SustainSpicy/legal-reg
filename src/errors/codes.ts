import { z } from 'zod';

export const ErrorOutputSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    fallback_used: z.boolean(),
  }),
});

export type ErrorOutputType = z.infer<typeof ErrorOutputSchema>;

export const ERROR_CODES = {
  ENTITY_NOT_FOUND: { retryable: false, http: 404 },
  ENTITY_NOT_RESOLVED: { retryable: true, http: 422 },
  UPSTREAM_UNAVAILABLE: { retryable: true, http: 200 }, // 200 + stale flag
  RATE_LIMIT_EXCEEDED: { retryable: true, http: 429 },
  AUTH_REQUIRED: { retryable: false, http: 402 },
  SCHEMA_VALIDATION_FAIL: { retryable: false, http: 500 },
  JURISDICTION_UNSUPPORTED: { retryable: false, http: 422 },
  INVALID_INPUT: { retryable: false, http: 400 },
  BENEFICIAL_OWNERSHIP_UNAVAILABLE: { retryable: false, http: 200 },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function structuredError(
  code: ErrorCode,
  message: string,
  partialData?: Record<string, unknown>,
) {
  const { retryable } = ERROR_CODES[code];
  const errorPayload = {
    error: {
      code,
      message,
      retryable,
      fallback_used: !!partialData,
    },
    ...partialData,
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(errorPayload) }],
    structuredContent: errorPayload,
  };
}
