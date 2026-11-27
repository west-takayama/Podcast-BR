import { AudioSampleSink, EncodedPacketSink, type InputAudioTrack } from "mediabunny";

/**
 * Some Opus decoders return a continuous decoded clock across gaps in container PTS.
 * Restart decoding at confirmed packet gaps so the first packet reanchors each span.
 * Only metadata is inspected, within the requested interval.
 */
export async function* samplesOnSourceClock(track: InputAudioTrack, start = 0, end = Infinity, signal?: AbortSignal) {
  const sink = new AudioSampleSink(track);
  if (await track.getCodec() !== "opus") {
    yield* sink.samples(start, end);
    return;
  }
  const packets = new EncodedPacketSink(track);
  const options = { metadataOnly: true };
  const first = await packets.getPacket(start, options);
  let sectionStart = start;
  let previousEnd: number | undefined;
  let nominalDuration = 0.02;
  for await (const packet of packets.packets(first ?? undefined, undefined, options)) {
    signal?.throwIfAborted();
    if (packet.timestamp >= end) break;
    if (previousEnd !== undefined && packet.timestamp - previousEnd >= 0.08) {
      if (previousEnd > sectionStart) yield* sink.samples(sectionStart, previousEnd);
      sectionStart = Math.max(sectionStart, packet.timestamp);
    }
    // WebM may report the distance to the next PTS as packet duration.
    // An Opus packet cannot carry over 120 ms of audio.
    if (packet.duration > 0 && packet.duration <= 0.120001) nominalDuration = packet.duration;
    previousEnd = packet.timestamp + nominalDuration;
  }
  if (sectionStart < end) yield* sink.samples(sectionStart, end);
}
