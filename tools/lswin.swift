import Foundation
import CoreGraphics
let pid = pid_t(Int32(CommandLine.arguments[1])!)
for opts in [CGWindowListOption.optionOnScreenOnly, CGWindowListOption.optionAll] {
  print("--- \(opts == .optionOnScreenOnly ? "onscreen" : "todas") ---")
  let list = CGWindowListCopyWindowInfo([opts, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid {
    let n = w[kCGWindowNumber as String] as? Int ?? -1
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let name = w[kCGWindowName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    print("  id=\(n) layer=\(layer) \(b["Width"] ?? "?")x\(b["Height"] ?? "?") '\(name)'")
  }
}
