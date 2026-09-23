// pilot-window — devolve o CGWindowID da janela do Pilot, pra capturar SÓ ela.
// Privacidade: nunca capturar a tela inteira do Arquiteto.
import Foundation
import CoreGraphics
let pid = pid_t(CommandLine.arguments.count > 1 ? Int32(CommandLine.arguments[1]) ?? 0 : 0)
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
          let num = w[kCGWindowNumber as String] as? Int,
          let bounds = w[kCGWindowBounds as String] as? [String: Any],
          let h = bounds["Height"] as? Double, h > 200 else { continue }
    print(num); exit(0)
}
exit(1)
