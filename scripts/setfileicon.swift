import Cocoa

guard CommandLine.arguments.count >= 3 else {
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let targetPath = CommandLine.arguments[2]

guard let image = NSImage(contentsOfFile: imagePath) else {
    exit(2)
}

let success = NSWorkspace.shared.setIcon(image, forFile: targetPath, options: [])
exit(success ? 0 : 3)
