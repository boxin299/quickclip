import AppKit
import Foundation
import UniformTypeIdentifiers

private let logDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/DaVinciTextEditor", isDirectory: true)
private let logURL = logDirectory.appendingPathComponent("resolve_drag_probe.log")

private func ensureLogDirectory() {
    try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
}

private func appendLog(_ message: String) {
    ensureLogDirectory()
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logURL.path) {
            if let handle = try? FileHandle(forWritingTo: logURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        } else {
            try? data.write(to: logURL)
        }
    }
    print(line, terminator: "")
}

private func shortHexDump(_ data: Data, limit: Int = 96) -> String {
    let prefix = data.prefix(limit)
    let hex = prefix.map { String(format: "%02x", $0) }.joined()
    if data.count > limit {
        return "\(hex)... (\(data.count) bytes)"
    }
    return "\(hex) (\(data.count) bytes)"
}

private func shortBase64(_ data: Data, limit: Int = 512) -> String {
    let encoded = data.base64EncodedString()
    if encoded.count > limit {
        let endIndex = encoded.index(encoded.startIndex, offsetBy: limit)
        return "\(encoded[..<endIndex])... (\(encoded.count) chars)"
    }
    return encoded
}

private func shortTextPreview(_ data: Data, limit: Int = 512) -> String? {
    guard let text = String(data: data.prefix(limit), encoding: .utf8) else {
        return nil
    }
    let sanitized = text
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\n", with: "\\n")
    return sanitized.isEmpty ? nil : sanitized
}

private func describePropertyList(_ value: Any) -> String {
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted]),
       let text = String(data: data, encoding: .utf8) {
        return text
    }
    return String(describing: value)
}

private func dumpPasteboard(_ pasteboard: NSPasteboard, reason: String) {
    let types = pasteboard.types?.map(\.rawValue) ?? []
    appendLog("=== \(reason) ===")
    appendLog("changeCount=\(pasteboard.changeCount)")
    appendLog("types=\(types)")

    if let items = pasteboard.pasteboardItems, !items.isEmpty {
        appendLog("items=\(items.count)")
        for (itemIndex, item) in items.enumerated() {
            appendLog("-- item[\(itemIndex)] types=\(item.types.map(\.rawValue))")
            for type in item.types {
                appendLog("item[\(itemIndex)] type=\(type.rawValue)")
                if let plist = item.propertyList(forType: type) {
                    appendLog("propertyList=\(describePropertyList(plist))")
                }
                if let data = item.data(forType: type) {
                    appendLog("data.hex=\(shortHexDump(data))")
                    if let text = shortTextPreview(data) {
                        appendLog("data.utf8=\(text)")
                    }
                    appendLog("data.base64=\(shortBase64(data))")
                } else {
                    appendLog("data=nil")
                }
            }
        }
    } else {
        appendLog("items=0")
    }

    if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !fileURLs.isEmpty {
        appendLog("readObjects.fileURLs=\(fileURLs.map(\.path))")
    }
    if let strings = pasteboard.readObjects(forClasses: [NSString.self], options: nil) as? [String], !strings.isEmpty {
        appendLog("readObjects.strings=\(strings)")
    }
}

final class DropProbeView: NSView {
    private let label = NSTextField(labelWithString: "")
    private var lastLoggedChangeCount: Int?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        label.font = NSFont.systemFont(ofSize: 15)
        label.alignment = .center
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.stringValue = """
        把 Resolve 媒体池条目或时间线片段拖到这个窗口。

        我会记录:
        1. drag pasteboard 的 type 列表
        2. 每个 type 的 propertyList / 原始 data
        3. 可读的 UTF-8 / file URL

        日志路径:
        \(logURL.path)
        """
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])

        let broadType = NSPasteboard.PasteboardType(UTType.item.identifier)
        registerForDraggedTypes([broadType, .fileURL, .string])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        logIfNeeded(sender.draggingPasteboard, reason: "draggingEntered")
        layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.18).cgColor
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        logIfNeeded(sender.draggingPasteboard, reason: "draggingUpdated")
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        appendLog("draggingExited")
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        logIfNeeded(sender.draggingPasteboard, reason: "prepareForDragOperation")
        return true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        logIfNeeded(sender.draggingPasteboard, reason: "performDragOperation")
        layer?.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.18).cgColor
        return true
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        appendLog("concludeDragOperation")
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        self
    }

    private func logIfNeeded(_ pasteboard: NSPasteboard, reason: String) {
        let current = pasteboard.changeCount
        if lastLoggedChangeCount == current && reason == "draggingUpdated" {
            return
        }
        lastLoggedChangeCount = current
        dumpPasteboard(pasteboard, reason: reason)
    }
}

final class DragPasteboardWatcher {
    private let pasteboard = NSPasteboard(name: .drag)
    private var timer: Timer?
    private var lastChangeCount: Int
    private var globalMonitor: Any?
    private var localMonitor: Any?

    init() {
        lastChangeCount = pasteboard.changeCount
    }

    func start() {
        appendLog("DragPasteboardWatcher.start changeCount=\(lastChangeCount)")
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.poll()
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseDown, .leftMouseUp]) { [weak self] event in
            self?.logMouseEvent(event, source: "global")
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseDown, .leftMouseUp]) { [weak self] event in
            self?.logMouseEvent(event, source: "local")
            return event
        }
    }

    private func poll() {
        let current = pasteboard.changeCount
        guard current != lastChangeCount else { return }
        lastChangeCount = current
        dumpPasteboard(pasteboard, reason: "globalDragPasteboardChanged")
    }

    private func logMouseEvent(_ event: NSEvent, source: String) {
        let current = pasteboard.changeCount
        appendLog("\(source)MouseEvent type=\(event.type.rawValue) location=\(NSStringFromPoint(event.locationInWindow)) dragPB.changeCount=\(current)")
        if current != lastChangeCount {
            lastChangeCount = current
            dumpPasteboard(pasteboard, reason: "\(source)MouseEventPasteboardChanged")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let watcher = DragPasteboardWatcher()

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureLogDirectory()
        appendLog("resolve_drag_probe started")

        let frame = NSRect(x: 0, y: 0, width: 760, height: 420)
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "Resolve Drag Probe"
        let contentView = DropProbeView(frame: frame)
        window.contentView = contentView
        let broadType = NSPasteboard.PasteboardType(UTType.item.identifier)
        window.registerForDraggedTypes([broadType, .fileURL, .string])
        window.makeKeyAndOrderFront(nil)
        self.window = window

        watcher.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.activate(ignoringOtherApps: true)
app.run()
