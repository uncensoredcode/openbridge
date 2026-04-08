import { normalizersModule } from "./normalizers/index.ts";

const { normalizeGenericLegacyPacket } = normalizersModule;
type PacketNormalizationStrategy =
  | "canonical_passthrough"
  | "canonical_repaired_tool_call_close_tag"
  | "legacy_packet_v1";
type PacketNormalizationFailureCode = "unsupported_provider_packet" | "invalid_provider_packet";
type PacketNormalizationSuccess = {
  ok: true;
  strategy: PacketNormalizationStrategy;
  canonicalPacket: string;
  notes: string[];
};
type PacketNormalizationFailure = {
  ok: false;
  strategy: PacketNormalizationStrategy | "none";
  code: PacketNormalizationFailureCode;
  message: string;
  notes: string[];
};
type PacketNormalizationResult = PacketNormalizationSuccess | PacketNormalizationFailure;
function normalizeProviderPacket(
  _providerId: string,
  extractedCandidate: string
): PacketNormalizationResult {
  const candidate = extractedCandidate.trim();
  if (candidate.startsWith('<zc_packet version="1">')) {
    const repairedCanonicalPacket = repairMalformedCanonicalPacket(candidate);
    if (repairedCanonicalPacket) {
      return {
        ok: true,
        strategy: "canonical_repaired_tool_call_close_tag",
        canonicalPacket: repairedCanonicalPacket,
        notes: ["Repaired a malformed canonical </tool_call> closing tag before strict parsing."]
      };
    }
    return {
      ok: true,
      strategy: "canonical_passthrough",
      canonicalPacket: candidate,
      notes: ["Candidate already matched the canonical runtime packet format."]
    };
  }
  const genericLegacyPacket = normalizeGenericLegacyPacket(candidate);
  if (genericLegacyPacket) {
    return genericLegacyPacket;
  }
  return {
    ok: false,
    strategy: "none",
    code: "unsupported_provider_packet",
    message: "Non-canonical packet content did not match the supported legacy packet format.",
    notes: ["Only canonical passthrough and generic legacy packet normalization are available."]
  };
}
function repairMalformedCanonicalPacket(candidate: string) {
  const attributedOpenTagMatches = [...candidate.matchAll(/<tool_call\b[^>]+>/g)];
  const closeTagMatches = [...candidate.matchAll(/<\/tool_call>/g)];
  const hasTrailingBareOpenTag = /<tool_call>\s*<\/zc_packet>\s*$/u.test(candidate);
  if (
    attributedOpenTagMatches.length !== 1 ||
    closeTagMatches.length !== 0 ||
    !hasTrailingBareOpenTag
  ) {
    return null;
  }
  return candidate.replace(/<tool_call>\s*<\/zc_packet>\s*$/u, "</tool_call></zc_packet>");
}

export const packetNormalizerModule = {
  normalizeProviderPacket
};

export type {
  PacketNormalizationFailure,
  PacketNormalizationFailureCode,
  PacketNormalizationResult,
  PacketNormalizationStrategy,
  PacketNormalizationSuccess
};
