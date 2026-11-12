/** 测试用最小 PNG 编码器（store 方式 deflate，足够解码器往返验证）。 */
import { deflateSync } from 'node:zlib';

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  // 解码器不校验 CRC；写 0 保持测试代码短。
  crc.writeUInt32BE(0, 0);
  return Buffer.concat([head, body, crc]);
}

/** 8 位 RGBA PNG。 */
export function pngOf(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('rgba 长度不符');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)));
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', new Uint8Array(ihdr)),
      chunk('IDAT', new Uint8Array(deflateSync(Buffer.concat(rows)))),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}
