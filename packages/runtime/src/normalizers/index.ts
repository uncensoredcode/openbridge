import type { PacketNormalizationResult } from "../packet-normalizer.ts";
import { legacyPacketModule } from "./legacy-packet.ts";

const { normalizeLegacyPacket } = legacyPacketModule;
function normalizeGenericLegacyPacket(candidate: string): PacketNormalizationResult | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("<packet")) {
    return null;
  }
  return normalizeLegacyPacket(trimmed);
}

export const normalizersModule = {
  normalizeGenericLegacyPacket
};
