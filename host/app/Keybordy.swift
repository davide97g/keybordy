// keybordy: the keymap editor as a Mac app, for the Dock.
//
// A window around the editor that Hammerspoon serves on http://localhost:7373
// (host/hammerspoon/keybordy_web.lua), so there is one editor UI (host/ui/).
// It adds what a browser tab lacks: its own Dock icon and menus, a window that
// remembers its frame, starting Hammerspoon when nothing answers, and saving
// pending edits before it quits. `?app=1` tells the page to drop its own
// header (the title bar is it) and show its status chips in a bottom bar.
// Links that leave the editor open in the default browser. Build and
// install: `just host-app`.

import Cocoa
import WebKit

let editorURL = URL(string: "http://localhost:7373/?app=1")!
let hammerspoonPaths = ["~/Applications/Hammerspoon.app", "/Applications/Hammerspoon.app"]
let background = NSColor(srgbRed: 0.047, green: 0.043, blue: 0.055, alpha: 1)  // --wb-0

// Shown while Hammerspoon starts or is missing, in the editor's own colors.
func waitingPage(_ message: String) -> String {
  """
  <!doctype html><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#0c0b0e;color:#a8a5ad;font:13px/1.5 -apple-system,sans-serif}
  body{display:grid;place-items:center;text-align:center}
  b{display:block;color:#f4f4f0;font-size:15px;margin-bottom:4px}
  i{display:inline-block;width:10px;height:10px;border-radius:3px;background:#d6ff1f;margin-right:8px;
    animation:p 1s ease-in-out infinite alternate}
  @keyframes p{to{opacity:.25}}
  </style><div><b><i></i>keybordy</b>\(message)</div>
  """
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var waiting = false
  var startedHammerspoon = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    web.uiDelegate = self
    web.underPageBackgroundColor = background
    web.setValue(false, forKey: "drawsBackground")  // no white flash before the page paints

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "keybordy"
    window.subtitle = "keymap"
    window.titlebarAppearsTransparent = true  // the dark background runs up into the title bar
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = background
    window.minSize = NSSize(width: 720, height: 560)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("keybordy-editor")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    load()
  }

  func load() {
    web.load(URLRequest(url: editorURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3))
  }

  // Nothing on :7373: Hammerspoon is not running (or keybordy.lua failed). Start it once, then retry.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if !startedHammerspoon, let app = hammerspoonPaths.map({ NSString(string: $0).expandingTildeInPath })
      .first(where: { FileManager.default.fileExists(atPath: $0) }) {
      startedHammerspoon = true
      let cfg = NSWorkspace.OpenConfiguration()
      cfg.activates = false
      NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: app), configuration: cfg)
    }
    let message = startedHammerspoon
      ? "Waiting for Hammerspoon to serve the editor on localhost:7373…"
      : "Hammerspoon is not installed: run <code>just host-install</code>."
    if !waiting {
      waiting = true
      web.loadHTMLString(waitingPage(message), baseURL: nil)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.load() }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView.url?.host == editorURL.host { waiting = false }
  }

  // The editor stays in the window; anything else (help links, URLs being tested) opens in the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    let local = url.scheme == "about" || ["localhost", "127.0.0.1"].contains(url.host ?? "")
    if local || action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  // Edits save themselves half a second after the last change. window.keybordyDirty() (app.js)
  // saves at once and says whether anything is still on its way; give that a moment, and only ask
  // if it could not be saved (Hammerspoon gone).
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if waiting { return .terminateNow }
    let dirty = "window.keybordyDirty ? window.keybordyDirty() : false"
    web.evaluateJavaScript(dirty) { first, _ in
      guard first as? Bool == true else { return NSApp.reply(toApplicationShouldTerminate: true) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
        self.web.evaluateJavaScript(dirty) { still, _ in
          guard still as? Bool == true else { return NSApp.reply(toApplicationShouldTerminate: true) }
          let alert = NSAlert()
          alert.messageText = "Some edits could not be saved"
          alert.informativeText = "Hammerspoon did not answer. Quit anyway and lose them?"
          alert.addButton(withTitle: "Cancel")
          alert.addButton(withTitle: "Quit")
          alert.beginSheetModal(for: self.window) { answer in
            NSApp.reply(toApplicationShouldTerminate: answer == .alertSecondButtonReturn)
          }
        }
      }
    }
    return .terminateLater
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  @objc func reload(_ sender: Any?) { load() }
  @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(editorURL) }

  // Without an Edit menu, ⌘C/⌘V/⌘Z do nothing in the web view's text fields.
  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    add("keybordy", [
      item("About keybordy", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Hide keybordy", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit keybordy", #selector(NSApplication.terminate(_:)), "q"),
    ])
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    add("View", [
      item("Reload", #selector(reload(_:)), "r"),
      item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift]),
    ])
    let windowItems = [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ]
    add("Window", windowItems)
    NSApp.mainMenu = main
    NSApp.windowsMenu = main.items.last?.submenu
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
