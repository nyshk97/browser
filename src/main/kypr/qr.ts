import type { NativeImage } from 'electron'
import jsQR from 'jsqr'

function decode(image: NativeImage): string | null {
  const { width, height } = image.getSize()
  // `NativeImage.toBitmap()` は BGRA の並びなので、jsQR が読む RGBA に並べ替える
  const bgra = image.toBitmap()
  const rgba = new Uint8ClampedArray(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]!
    rgba[i + 1] = bgra[i + 1]!
    rgba[i + 2] = bgra[i]!
    rgba[i + 3] = bgra[i + 3]!
  }
  const found = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' })
  return found?.data ? found.data : null
}

/**
 * 画面の画像から QR コードを読む（ページに出ている 2FA の設定の QR。jsQR は 1 枚から 1 つだけ読む）。
 *
 * **まず縮めずに読む**。半端な倍率で縮めると升目の境目がぼけて、升目の細かい QR（otpauth URI は長い）が読めなくなる
 * （Retina の 2040×1640 を 2000px に縮めて読めなかった実測あり）。読めなければ、ちょうど半分に縮めてもう一度読む。
 */
export function readQrFromImage(image: NativeImage): string | null {
  if (image.isEmpty()) return null
  const full = decode(image)
  if (full !== null) return full
  const { width, height } = image.getSize()
  if (Math.max(width, height) < 1200) return null
  return decode(
    image.resize({ width: Math.round(width / 2), height: Math.round(height / 2), quality: 'good' })
  )
}
