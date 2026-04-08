type PacketExtractionSuccess = {
  ok: true;
  format: "zc_packet" | "provider_packet";
  packetText: string;
};
type PacketExtractionFailure = {
  ok: false;
  code: "no_packet_found" | "multiple_packets_found";
  message: string;
  candidates: string[];
};
type PacketExtractionResult = PacketExtractionSuccess | PacketExtractionFailure;
const CANDIDATE_PATTERNS: Array<{
  format: PacketExtractionSuccess["format"];
  pattern: RegExp;
}> = [
  {
    format: "zc_packet",
    pattern: /<zc_packet version="1">[\s\S]*?<\/zc_packet>/g
  },
  {
    format: "provider_packet",
    pattern: /<packet\b[^>]*\bmode="(?:final|tool_request|ask_user|fail)"[^>]*>[\s\S]*?<\/packet>/g
  }
];
function extractPacketCandidate(rawText: string): PacketExtractionResult {
  const candidates = CANDIDATE_PATTERNS.flatMap(({ format, pattern }) =>
    [...rawText.matchAll(pattern)]
      .map((match) => ({
        format,
        packetText: (match[0] ?? "").trim(),
        index: match.index ?? 0
      }))
      .filter((match) => match.packetText)
  ).sort((left, right) => left.index - right.index);
  if (candidates.length === 1) {
    return {
      ok: true,
      format: candidates[0].format,
      packetText: candidates[0].packetText
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: "multiple_packets_found",
      message: `Found ${candidates.length} packet candidates in provider output.`,
      candidates: candidates.map((candidate) => candidate.packetText)
    };
  }
  return {
    ok: false,
    code: "no_packet_found",
    message: "Provider output did not contain a recognized packet block.",
    candidates: []
  };
}

export const packetExtractorModule = {
  extractPacketCandidate
};

export type { PacketExtractionFailure, PacketExtractionResult, PacketExtractionSuccess };
