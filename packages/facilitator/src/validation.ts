// Request validation for POST /verify and POST /settle (spec §7.1, §7.2): the body must be a v2
// `{ x402Version, paymentPayload, paymentRequirements }` whose payload targets the same scheme and
// network as the requirements, and the facilitator must have registered that scheme on that network.
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema, z } from "@x402/core/schemas";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** Spec §9 codes this layer returns itself; anything scheme-specific comes from the mechanism. */
export const ERR_INVALID_PAYLOAD = "invalid_payload";
export const ERR_INVALID_REQUIREMENTS = "invalid_payment_requirements";
export const ERR_INVALID_VERSION = "invalid_x402_version";
export const ERR_INVALID_SCHEME = "invalid_scheme";
export const ERR_INVALID_NETWORK = "invalid_network";
export const ERR_UNSUPPORTED_SCHEME = "unsupported_scheme";
export const ERR_UNEXPECTED_VERIFY = "unexpected_verify_error";
export const ERR_UNEXPECTED_SETTLE = "unexpected_settle_error";

export const X402_VERSION = 2;

export interface FacilitatorRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export type Validation =
  | { ok: true; request: FacilitatorRequest }
  /** `status` is 400 for a malformed request, 200 for a well-formed one this facilitator cannot serve. */
  | { ok: false; status: 400 | 200; reason: string; message: string; network?: string };

const bodySchema = z
  .object({
    x402Version: z.number().int(),
    paymentPayload: z.unknown(),
    paymentRequirements: z.unknown(),
  })
  .strict();

function describe(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function networkOf(value: unknown): string | undefined {
  if (value && typeof value === "object" && "network" in value) {
    const n = (value as { network: unknown }).network;
    if (typeof n === "string" && n.length <= 64) return n;
  }
  return undefined;
}

/** The (scheme, network) pairs this facilitator serves, from `x402Facilitator.getSupported()`. */
export interface SupportedKindLike {
  x402Version: number;
  scheme: string;
  network: string;
}

export function validateRequest(body: unknown, kinds: readonly SupportedKindLike[]): Validation {
  const envelope = bodySchema.safeParse(body);
  if (!envelope.success) {
    return { ok: false, status: 400, reason: ERR_INVALID_PAYLOAD, message: describe(envelope.error) };
  }
  const { x402Version, paymentPayload, paymentRequirements } = envelope.data;
  const network = networkOf(paymentRequirements);
  const fail = (status: 400 | 200, reason: string, message: string): Validation => ({
    ok: false,
    status,
    reason,
    message,
    ...(network !== undefined ? { network } : {}),
  });

  if (x402Version !== X402_VERSION) return fail(400, ERR_INVALID_VERSION, `x402Version ${x402Version} is not supported`);

  const requirements = PaymentRequirementsV2Schema.safeParse(paymentRequirements);
  if (!requirements.success) return fail(400, ERR_INVALID_REQUIREMENTS, describe(requirements.error));

  const payload = PaymentPayloadV2Schema.safeParse(paymentPayload);
  if (!payload.success) return fail(400, ERR_INVALID_PAYLOAD, describe(payload.error));
  if (payload.data.x402Version !== x402Version) {
    return fail(400, ERR_INVALID_VERSION, "paymentPayload.x402Version differs from the request's");
  }

  const req = requirements.data;
  // The facilitator dispatches on the requirements; a payload built for another kind must not reach
  // that mechanism.
  if (payload.data.accepted.scheme !== req.scheme) return fail(400, ERR_INVALID_SCHEME, "paymentPayload.accepted.scheme differs from paymentRequirements.scheme");
  if (payload.data.accepted.network !== req.network) return fail(400, ERR_INVALID_NETWORK, "paymentPayload.accepted.network differs from paymentRequirements.network");

  const sameScheme = kinds.filter(k => k.x402Version === x402Version && k.scheme === req.scheme);
  if (sameScheme.length === 0) return fail(200, ERR_UNSUPPORTED_SCHEME, `scheme ${JSON.stringify(req.scheme)} is not supported`);
  if (!sameScheme.some(k => k.network === req.network)) return fail(200, ERR_INVALID_NETWORK, `network ${JSON.stringify(req.network)} is not supported for ${req.scheme}`);

  // NetworkSchemaV2 checked the CAIP-2 colon, which is what the core `Network` template type encodes.
  const { accepted, extensions, ...rest } = payload.data;
  return {
    ok: true,
    request: {
      paymentPayload: {
        ...rest,
        accepted: { ...accepted, network: accepted.network as Network, extra: accepted.extra ?? {} },
        ...(extensions ? { extensions } : {}),
      },
      paymentRequirements: { ...req, network: req.network as Network, extra: req.extra ?? {} },
    },
  };
}
