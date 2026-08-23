import { createHash } from 'node:crypto'

/**
 * CRX3 の最小パーサ。
 * Chrome Web Store から取得した CRX の公開鍵を1回だけ抜き出すために使う
 * （拡張 ID を版に依らず固定するため、その鍵を lock に記録して manifest.key に注入する）。
 */

/** 公開鍵（base64 DER）から Chrome の拡張 ID を計算する。 */
export function extensionIdFromPublicKey(publicKeyBase64) {
  const hash = createHash('sha256').update(publicKeyBase64, 'base64').digest()
  const hex = hash.subarray(0, 16).toString('hex')
  let id = ''
  for (const char of hex) {
    const value = parseInt(char, 16)
    id += Number.isNaN(value) ? 'a' : String.fromCharCode('a'.charCodeAt(0) + value)
  }
  return id
}

function readVarint(buffer, offset) {
  let result = 0
  let shift = 0
  let index = offset
  for (;;) {
    if (index >= buffer.length) throw new Error('truncated varint')
    const byte = buffer[index++]
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result, index]
}

/** 単純な protobuf リーダ。length-delimited フィールドだけを集める。 */
function readMessage(buffer) {
  const fields = new Map()
  let offset = 0
  while (offset < buffer.length) {
    let tag
    ;[tag, offset] = readVarint(buffer, offset)
    const fieldNumber = Math.floor(tag / 8)
    const wireType = tag % 8
    if (wireType === 2) {
      let length
      ;[length, offset] = readVarint(buffer, offset)
      const value = buffer.subarray(offset, offset + length)
      offset += length
      const list = fields.get(fieldNumber) ?? []
      list.push(value)
      fields.set(fieldNumber, list)
    } else if (wireType === 0) {
      ;[, offset] = readVarint(buffer, offset)
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 1) {
      offset += 8
    } else {
      throw new Error(`unsupported wire type: ${wireType}`)
    }
  }
  return fields
}

/**
 * CRX3 バッファを解析する。
 * @returns {{ extensionId: string, publicKey: string, zip: Buffer }}
 */
export function parseCrx3(buffer) {
  if (buffer.toString('utf8', 0, 4) !== 'Cr24') throw new Error('not a CRX file')
  const version = buffer.readUInt32LE(4)
  if (version !== 3) throw new Error(`unsupported CRX version: ${version}`)
  const headerSize = buffer.readUInt32LE(8)
  const header = buffer.subarray(12, 12 + headerSize)
  const zip = buffer.subarray(12 + headerSize)

  const headerFields = readMessage(header)
  const signedHeaderData = headerFields.get(10000)?.[0]
  if (!signedHeaderData) throw new Error('CRX header has no signed_header_data')
  const declaredCrxId = readMessage(signedHeaderData).get(1)?.[0]
  if (!declaredCrxId) throw new Error('CRX signed data has no crx_id')
  const declaredId = (() => {
    let id = ''
    for (const char of declaredCrxId.toString('hex')) {
      id += String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16))
    }
    return id
  })()

  const proofs = headerFields.get(2) ?? []
  for (const proof of proofs) {
    const publicKey = readMessage(proof).get(1)?.[0]
    if (!publicKey) continue
    const base64 = publicKey.toString('base64')
    if (extensionIdFromPublicKey(base64) === declaredId) {
      return { extensionId: declaredId, publicKey: base64, zip }
    }
  }
  throw new Error('CRX public key does not match declared crx_id')
}

/** Web Store の CRX ダウンロード URL（常に最新版が返る点に注意）。 */
export function webStoreCrxUrl(extensionId, chromeVersion) {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.append('response', 'redirect')
  url.searchParams.append('acceptformat', 'crx2,crx3')
  const x = new URLSearchParams()
  x.append('id', extensionId)
  x.append('uc', '')
  url.searchParams.append('x', x.toString())
  url.searchParams.append('prodversion', chromeVersion)
  return url.toString()
}
