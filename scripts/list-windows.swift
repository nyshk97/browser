// 画面上にある窓を所有プロセス名で絞って列挙し、ディスプレイ内に見えている面積（exposed）と alpha を出す。
// 自走検証の背面モード（VERIFY.md「まとめて検証する」）で、検証用の Nemo の窓が本当に見えていないかを測るのに使う。
//
//   xcrun swiftc -O -o /tmp/list-windows scripts/list-windows.swift
//   while true; do /tmp/list-windows Electron; sleep 0.2; done >> windows.log   # mise run verify と並行して
//   /tmp/list-windows ALL                                                       # 今見えている窓の所有プロセス名の一覧
//   screencapture -l <id> -x shot.png                                           # 気になる窓だけ撮る（id は kCGWindowNumber）
//
// 見えるのは**今いる Space の窓だけ**（`.optionOnScreenOnly`）。最背面に置かれて他の窓に隠れていても「on screen」に数える。
// 時刻はミリ秒まで出すので、Nemo のログ（`foreground.parked`）と突き合わせられる。
import Cocoa

let fmt = DateFormatter()
fmt.dateFormat = "HH:mm:ss.SSS"
let now = fmt.string(from: Date())
let needle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Electron"

// NSScreen は左下原点、CGWindow は左上原点。主ディスプレイの高さで反転してそろえる
let primaryHeight = NSScreen.screens[0].frame.height
let screens: [CGRect] = NSScreen.screens.map { screen in
  let f = screen.frame
  return CGRect(x: f.origin.x, y: primaryHeight - f.origin.y - f.height, width: f.width, height: f.height)
}

let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
if needle == "ALL" {
  let owners = Set(list.compactMap { $0[kCGWindowOwnerName as String] as? String })
  print(owners.sorted().joined(separator: ", "))
  exit(0)
}
for window in list {
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  guard owner.contains(needle) else { continue }
  guard let b = window[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
  let rect = CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!)
  var exposed = CGRect.zero
  for screen in screens {
    let part = rect.intersection(screen)
    if !part.isNull, part.width * part.height > exposed.width * exposed.height { exposed = part }
  }
  let pid = window[kCGWindowOwnerPID as String] as? Int ?? 0
  let number = window[kCGWindowNumber as String] as? Int ?? 0
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  let alpha = window[kCGWindowAlpha as String] as? Double ?? -1
  let name = window[kCGWindowName as String] as? String ?? ""
  print(
    "\(now) owner=\(owner) pid=\(pid) id=\(number) layer=\(layer) bounds=\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height))"
      + " exposed=\(Int(exposed.width))x\(Int(exposed.height)) alpha=\(alpha) name=\(name)"
  )
}
