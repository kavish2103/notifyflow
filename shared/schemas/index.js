const { z } = require('zod');

// Regex patterns to enforce strict distributed object identifiers.
// We format tenant IDs as 'tenant-<uuid-v4>' and event IDs as 'evt-<uuid-v4>'.
const UUID_V4_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const EVENT_ID_REGEX = new RegExp(`^evt-${UUID_V4_PATTERN}$`);
const TENANT_ID_REGEX = new RegExp(`^tenant-${UUID_V4_PATTERN}$`);

/**
 * 1. Client Event Schema: Raw event structure arriving at Event Ingestion from API Gateway.
 */
const clientEventSchema = z.object({
  clientEventId: z.string({
    required_error: "clientEventId is required",
    invalid_type_error: "clientEventId must be a string"
  }).min(1, "clientEventId cannot be empty"),

  tenantId: z.string({
    required_error: "tenantId is required"
  }).regex(TENANT_ID_REGEX, {
    message: "tenantId must be a string prefixed with 'tenant-' followed by a valid UUID v4"
  }),

  userId: z.string({
    required_error: "userId is required"
  }).startsWith("user-", {
    message: "userId must be a string prefixed with 'user-'"
  }),

  eventType: z.string({
    required_error: "eventType is required"
  }).min(1, "eventType cannot be empty"),

  payload: z.record(z.any(), {
    required_error: "payload is required",
    invalid_type_error: "payload must be a JSON object"
  })
}).strict(); // Reject any unexpected parameters to prevent parameter pollution

/**
 * 2. Event Envelope Schema: The structured message envelope published onto Kafka.
 * Incorporates enrichment details needed for worker tracing and offset delivery.
 */
const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0", {
    required_error: "schemaVersion is required and must be '1.0'"
  }),

  eventId: z.string({
    required_error: "eventId is required"
  }).regex(EVENT_ID_REGEX, {
    message: "eventId must be a string prefixed with 'evt-' followed by a valid UUID v4"
  }),

  clientEventId: z.string({
    required_error: "clientEventId is required"
  }).min(1, "clientEventId cannot be empty"),

  tenantId: z.string({
    required_error: "tenantId is required"
  }).regex(TENANT_ID_REGEX, {
    message: "tenantId must be a string prefixed with 'tenant-' followed by a valid UUID v4"
  }),

  userId: z.string({
    required_error: "userId is required"
  }).startsWith("user-", {
    message: "userId must be a string prefixed with 'user-'"
  }),

  eventType: z.string({
    required_error: "eventType is required"
  }).min(1, "eventType cannot be empty"),

  timestamp: z.string({
    required_error: "timestamp is required"
  }).datetime({
    message: "timestamp must be a valid ISO 8601 UTC timestamp (e.g., 2026-05-25T14:10:00.000Z)"
  }),

  correlationId: z.string({
    required_error: "correlationId is required"
  }).startsWith("req-", {
    message: "correlationId must be a string prefixed with 'req-'"
  }),

  retryCount: z.number({
    required_error: "retryCount is required"
  }).int().nonnegative().default(0),

  payload: z.record(z.any(), {
    required_error: "payload is required"
  })
}).strict();

/**
 * Validates external requests entering the Ingestion API endpoint.
 * @param {object} data - Raw request body
 * @returns {object} Zod safeParse result
 */
function validateClientEvent(data) {
  return clientEventSchema.safeParse(data);
}

/**
 * Validates Kafka-produced event envelopes before processing inside worker queues.
 * @param {object} data - Parsed message content
 * @returns {object} Zod safeParse result
 */
function validateEventEnvelope(data) {
  return eventEnvelopeSchema.safeParse(data);
}

module.exports = {
  clientEventSchema,
  eventEnvelopeSchema,
  validateClientEvent,
  validateEventEnvelope
};
