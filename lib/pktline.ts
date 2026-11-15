// pkt-line codec + sideband-64k framing (git smart HTTP).
//
// pkt-line: 4 hex length bytes (payload + 4) then the payload; `0000` flush,
// `0001` delim, `0002` response-end. Largest packet 65520 bytes.
// Sideband-64k: each pkt-line's payload starts with a band byte — 1 = data,
// 2 = progress, 3 = error — followed by the channel bytes.
//
// Erasable TypeScript only (node --experimental-strip-types).

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest data payload inside one sideband packet (payload minus the band byte). */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX_PAYLOAD - 1;

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a complete buffer into packets. Stops at (and includes) the first
 * flush packet when `stopAtFlush` is set and reports the unconsumed tail in
 * `rest` — the receive-pack body is pkt-lines up to a flush, then raw pack
 * bytes. Throws on a malformed header or a truncated packet.
 */
export function decodePktLines(
  bytes: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: GitPacket[]; rest: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    }
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush) return { packets, rest: bytes.subarray(offset) };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > bytes.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    }
    const raw = bytes.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sideband-64k
// ---------------------------------------------------------------------------------------------

export type Sideband = 1 | 2 | 3;

/** One sideband packet: a pkt-line whose payload is a band byte + data. */
export function encodeSideband(band: Sideband, data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (body.length > SIDEBAND_MAX_DATA) {
    throw new Error(`sideband chunk is ${body.length} bytes, over the ${SIDEBAND_MAX_DATA}-byte maximum`);
  }
  return encodePktLine(Buffer.concat([Buffer.from([band]), body]));
}

/**
 * Frame a byte stream as band-1 sideband packets, chunked to the sideband
 * maximum. Always yields at least one packet, even for an empty stream, so a
 * packfile section is never packet-less.
 */
export function frameSideband(band: Sideband, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(encodeSideband(band, Buffer.alloc(0)));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_DATA) {
    parts.push(encodeSideband(band, data.subarray(offset, offset + SIDEBAND_MAX_DATA)));
  }
  return Buffer.concat(parts);
}

/** Decode one sideband payload into its band and channel bytes. */
export function decodeSideband(payload: Buffer): { band: number; data: Buffer } {
  if (payload.length < 1) throw new Error('empty sideband packet');
  return { band: payload[0] as number, data: payload.subarray(1) };
}
