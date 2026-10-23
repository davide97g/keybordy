// Draws the app icon, a 1024 px PNG: the keybordy mark (favicon.svg in the simulator frontend: a
// lime key tile with a geometric K) as a keycap, a face over a darker skirt, on the macOS icon grid
// (824 px body, 100 px margin). Run by `just host-app`: swift host/app/icon.swift <out.png>

import AppKit

let size = 1024.0, inset = 100.0, body = size - 2 * inset, radius = 185.0
let scale = body / 32  // favicon.svg's viewBox is 32 x 32
let lime = NSColor(srgbRed: 0.839, green: 1, blue: 0.122, alpha: 1)    // #d6ff1f
let skirt = NSColor(srgbRed: 0.56, green: 0.70, blue: 0.0, alpha: 1)
let ink = NSColor(srgbRed: 0.047, green: 0.043, blue: 0.055, alpha: 1) // #0c0b0e

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let cg = NSGraphicsContext.current!.cgContext
cg.translateBy(x: 0, y: size)  // SVG coordinates: y down
cg.scaleBy(x: 1, y: -1)

let outer = CGRect(x: inset, y: inset, width: body, height: body)
cg.saveGState()
cg.setShadow(offset: CGSize(width: 0, height: 14), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
cg.addPath(CGPath(roundedRect: outer, cornerWidth: radius, cornerHeight: radius, transform: nil))
cg.setFillColor(skirt.cgColor)
cg.fillPath()
cg.restoreGState()

// The face sits up off the skirt, like a pressed-in keycap seen from the front.
let face = CGRect(x: inset + 14, y: inset + 10, width: body - 28, height: body - 58)
cg.addPath(CGPath(roundedRect: face, cornerWidth: radius - 14, cornerHeight: radius - 14, transform: nil))
cg.setFillColor(lime.cgColor)
cg.fillPath()

// The K, from favicon.svg, mapped onto the face.
func p(_ x: Double, _ y: Double) -> CGPoint {
  CGPoint(x: face.minX + x / 32 * face.width, y: face.minY + y / 32 * face.height)
}
cg.setFillColor(ink.cgColor)
let stem = CGRect(origin: p(8.5, 7.5), size: CGSize(width: 4.5 / 32 * face.width, height: 17 / 32 * face.height))
cg.addPath(CGPath(roundedRect: stem, cornerWidth: scale * 0.8, cornerHeight: scale * 0.8, transform: nil))
cg.fillPath()
for poly in [[(13, 15.2), (19.6, 7.5), (25, 7.5), (16.4, 17.6)], [(15.2, 15.6), (25, 24.5), (19.6, 24.5), (13, 18.6)]] {
  cg.move(to: p(poly[0].0, poly[0].1))
  for (x, y) in poly.dropFirst() { cg.addLine(to: p(x, y)) }
  cg.closePath()
  cg.fillPath()
}

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
