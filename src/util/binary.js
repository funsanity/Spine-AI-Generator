/**
 * Spine 二进制格式的底层读取器。
 *
 * Spine 的 .skel（二进制）与 .json 是同一份数据的两种编码，字段顺序完全由
 * SkeletonBinary 的读取顺序决定，没有自描述的类型信息。因此解析必须严格
 * 按顺序读，读错一个字节后面全乱——这也是为什么本文件只用最小原语，
 * 把"顺序"的责任留给上层调用者。
 *
 * 参考 spine-ts 的 SkeletonBinary.ts。
 */

/** 读取越界时抛出的错误，便于把"格式不匹配"和"IO 失败"区分开。 */
export class BinaryReadError extends Error {
  constructor(message, offset) {
    super(`${message} (offset=${offset})`);
    this.name = 'BinaryReadError';
    this.offset = offset;
  }
}

export class BinaryReader {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
    this.length = bytes.byteLength;
  }

  get remaining() {
    return this.length - this.offset;
  }

  require(n) {
    if (this.offset + n > this.length) {
      throw new BinaryReadError(`需要 ${n} 字节但只剩 ${this.remaining}`, this.offset);
    }
  }

  /** 有符号 8 位 */
  readByte() {
    this.require(1);
    return this.view.getInt8(this.offset++);
  }

  /** 无符号 8 位 */
  readUByte() {
    this.require(1);
    return this.view.getUint8(this.offset++);
  }

  /** 有符号 32 位大端 — Spine 用它编码布尔的真实值（true=1, false=0） */
  readInt(optimize = true) {
    if (optimize) {
      // 优化模式下布尔被压成单字节
      return this.readByte();
    }
    this.require(4);
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  /** 32 位浮点大端 */
  readFloat() {
    this.require(4);
    const v = this.view.getFloat32(this.offset);
    this.offset += 4;
    return v;
  }

  /**
   * 变长整数。7 位一组，最高位是延续位，最多 5 字节。
   *
   * optimizePositive 的语义与 spine-ts 的 readInt 一致，别记反：
   *   true  —— 直接返回，用于非负值（索引、计数、字符串长度）
   *   false —— zigzag 还原成有符号数
   * 对称于写入侧的 writeInt(value, optimizePositive)。
   */
  readVarInt(optimizePositive = true) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (shift > 35) throw new BinaryReadError('varint 过长', this.offset);
      this.require(1);
      b = this.view.getUint8(this.offset++);
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);

    if (optimizePositive) return result >>> 0;

    // zigzag 解码：低位是符号
    const isNegative = (result & 1) === 1;
    result >>>= 1;
    return isNegative ? ~result : result;
  }

  /**
   * 无符号变长整数。语义与 readVarInt(true) 相同，保留独立名字是因为
   * 调用点写出来能自解释"这里读的是长度/索引，不是有符号数值"。
   */
  readVarIntUnsigned() {
    return this.readVarInt(true);
  }

  /** 布尔：优化模式下 1 字节，否则 4 字节整数 */
  readBoolean(optimize = true) {
    return this.readInt(optimize) !== 0;
  }

  /** 32 位大端整数 — 用于字符串长度、数组长度 */
  readInt32() {
    this.require(4);
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  readFloatArray(count) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.readFloat();
    return out;
  }

  readIntArray(count) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.readInt32();
    return out;
  }

  /**
   * 字符串。编码的是"字节数 + 1"，所以要减一才是真实长度：
   *   0     → null（字段缺失，语义是"继承"）
   *   1     → 空串（显式为空）
   *   n + 1 → n 个字节
   * null 与空串语义不同，不能合并——"继承上一帧的附件"和
   * "这一帧不要附件"是两回事。
   *
   * 字节序列是 1/2/3 字节的 UTF-8 变体，但用 TextDecoder 直接解
   * 整段更快，且对合法 UTF-8 结果完全一致（Spine 导出必然是合法
   * UTF-8，非法的部分只会出现在被截断的调试切片里）。
   */
  readString() {
    const byteCount = this.readVarIntUnsigned();
    if (byteCount === 0) return null;
    if (byteCount === 1) return '';
    const len = byteCount - 1;
    this.require(len);
    const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder('utf-8').decode(slice);
  }

  /** 颜色：4 字节 RGBA，返回 #rrggbbaa */
  readColor() {
    const r = this.readUByte();
    const g = this.readUByte();
    const b = this.readUByte();
    const a = this.readUByte();
    return (
      '#' +
      [r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')
    );
  }
}
