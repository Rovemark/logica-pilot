// pilot-key — a mão da IA para a UI NATIVA do Logica Pilot.
//
// Por que existe: o CDP só alcança a página. Menu, toolbar, painel lateral e
// atalhos do browser são UI nativa, fora do alcance dele. E `osascript keystroke`
// digita no teclado do Arquiteto — atrapalha o que ele está fazendo e é proibido.
//
// CGEventPostToPid entrega o evento DIRETO ao processo do Pilot: o teclado e o
// mouse do Arquiteto seguem livres, mesmo com outra janela em foco.
//
// Uso: pilot-key <pid> <tecla> [cmd] [shift] [alt] [ctrl]
//   ex: pilot-key 4213 k cmd

import Foundation
import CoreGraphics

// Mapa das teclas que a IA precisa acionar (virtual key codes do macOS).
let keyMap: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45,
    "m": 46, "return": 36, "tab": 48, "space": 49, "escape": 53,
]

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[1]),
      let key = keyMap[args[2].lowercased()] else {
    FileHandle.standardError.write(
        "uso: pilot-key <pid> <tecla> [cmd] [shift] [alt] [ctrl]\n".data(using: .utf8)!)
    exit(2)
}

var flags: CGEventFlags = []
for m in args.dropFirst(3) {
    switch m.lowercased() {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: break
    }
}

let src = CGEventSource(stateID: .hidSystemState)
guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else {
    FileHandle.standardError.write("não consegui criar o evento\n".data(using: .utf8)!)
    exit(1)
}
down.flags = flags
up.flags = flags

down.postToPid(pid)
usleep(40_000)
up.postToPid(pid)
print("enviado: \(args[2]) \(flags.rawValue != 0 ? args.dropFirst(3).joined(separator: "+") : "") → pid \(pid)")
