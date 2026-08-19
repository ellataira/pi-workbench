import AppKit
import Darwin
import Foundation
import UserNotifications

private let cellWidth: CGFloat = 192
private let cellHeight: CGFloat = 208
private let inboxAttentionWindow: TimeInterval = 15 * 60

private struct PetSnapshot: Codable {
    let version: Int
    let client: String
    let sessionId: String
    let pid: Int32
    let phase: String
    let activeTools: Int
    let children: Int
    let workspaceId: String?
    let surfaceId: String?
    let updatedAt: String

    var completionKey: String {
        "\(sessionId):\(updatedAt)"
    }
}

private struct ActionInboxItem: Codable {
    let id: String
    let state: String
    let source: String
    let code: String
    let sessionId: String?
    let workspaceId: String?
    let automationId: String?
    let createdAt: String
    let updatedAt: String

    var phase: String {
        switch state {
        case "failed": return "failed"
        case "blocked", "approval": return "waiting"
        default: return "completed"
        }
    }

    var snapshot: PetSnapshot {
        PetSnapshot(
            version: 1,
            client: "pi",
            sessionId: sessionId ?? id,
            pid: getpid(),
            phase: phase,
            activeTools: 0,
            children: 0,
            workspaceId: workspaceId,
            surfaceId: nil,
            updatedAt: updatedAt
        )
    }
}

private struct ActionInbox: Codable {
    let version: Int
    let items: [ActionInboxItem]
}

private struct AnimationFrame: Equatable {
    let row: Int
    let column: Int
    let duration: TimeInterval
}

private struct Animation {
    let frames: [AnimationFrame]
    let loopStartIndex: Int?
    let label: String
}

private let idleFrames = [
    AnimationFrame(row: 0, column: 0, duration: 0.280),
    AnimationFrame(row: 0, column: 1, duration: 0.110),
    AnimationFrame(row: 0, column: 2, duration: 0.110),
    AnimationFrame(row: 0, column: 3, duration: 0.140),
    AnimationFrame(row: 0, column: 4, duration: 0.140),
    AnimationFrame(row: 0, column: 5, duration: 0.320)
]

private func rowFrames(
    row: Int,
    count: Int,
    duration: TimeInterval,
    finalDuration: TimeInterval
) -> [AnimationFrame] {
    (0..<count).map { column in
        AnimationFrame(
            row: row,
            column: column,
            duration: column == count - 1 ? finalDuration : duration
        )
    }
}

private func frames(for state: String) -> [AnimationFrame] {
    switch state {
    case "failed":
        return rowFrames(row: 5, count: 8, duration: 0.140, finalDuration: 0.240)
    case "jumping":
        return rowFrames(row: 4, count: 5, duration: 0.140, finalDuration: 0.280)
    case "review", "completed":
        return rowFrames(row: 8, count: 6, duration: 0.150, finalDuration: 0.280)
    case "running":
        return rowFrames(row: 7, count: 6, duration: 0.120, finalDuration: 0.220)
    case "running-left":
        return rowFrames(row: 2, count: 8, duration: 0.120, finalDuration: 0.220)
    case "running-right":
        return rowFrames(row: 1, count: 8, duration: 0.120, finalDuration: 0.220)
    case "waving":
        return rowFrames(row: 3, count: 4, duration: 0.140, finalDuration: 0.280)
    case "waiting":
        return rowFrames(row: 6, count: 6, duration: 0.150, finalDuration: 0.260)
    default:
        return idleFrames
    }
}

private func animationSpec(
    for snapshot: PetSnapshot,
    stateOverride: String? = nil,
    reducedMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
) -> Animation {
    let suffix: String
    if snapshot.children > 0 {
        suffix = " · \(snapshot.children) \(snapshot.children == 1 ? "agent" : "agents")"
    } else if snapshot.activeTools > 0 {
        suffix = " · \(snapshot.activeTools) \(snapshot.activeTools == 1 ? "tool" : "tools")"
    } else {
        suffix = ""
    }

    let state = stateOverride ?? snapshot.phase
    let label: String
    switch state {
    case "running":
        label = "Working\(suffix)"
    case "running-left", "running-right":
        label = "Moving"
    case "waiting":
        label = "Needs you"
    case "review", "completed":
        label = snapshot.phase == "completed" ? "Done" : "Reviewing"
    case "failed":
        label = "Failed"
    case "waving":
        label = "Hello"
    case "jumping":
        label = "Attention"
    default:
        label = "Ready"
    }

    let eventFrames = frames(for: state)
    if reducedMotion {
        return Animation(frames: [eventFrames[0]], loopStartIndex: nil, label: label)
    }

    let slowIdle = idleFrames.map {
        AnimationFrame(row: $0.row, column: $0.column, duration: $0.duration * 6)
    }
    if state == "idle" {
        return Animation(frames: slowIdle, loopStartIndex: 0, label: label)
    }

    let repeated = eventFrames + eventFrames + eventFrames
    return Animation(
        frames: repeated + slowIdle,
        loopStartIndex: repeated.count,
        label: label
    )
}

private func phasePriority(_ phase: String) -> Int {
    switch phase {
    case "failed": return 50
    case "waiting": return 40
    case "completed": return 30
    case "review": return 25
    case "running": return 20
    case "idle": return 10
    default: return 0
    }
}

private func parsedDate(_ value: String) -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }
    return ISO8601DateFormatter().date(from: value) ?? .distantPast
}

private func inboxItemRequiresAttention(_ item: ActionInboxItem, now: Date = Date()) -> Bool {
    now.timeIntervalSince(parsedDate(item.updatedAt)) <= inboxAttentionWindow
}

private func processIsAlive(_ pid: Int32) -> Bool {
    if pid <= 0 {
        return false
    }
    if kill(pid, 0) == 0 {
        return true
    }
    return errno != ESRCH
}

private final class PetStore {
    private let runtimeDirectory: URL
    private let sessionsDirectory: URL
    private let inboxURL: URL
    private let decoder = JSONDecoder()

    init() {
        runtimeDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agents/runtime/pi-pet", isDirectory: true)
        sessionsDirectory = runtimeDirectory.appendingPathComponent("sessions", isDirectory: true)
        inboxURL = runtimeDirectory.appendingPathComponent("inbox.json")
    }

    func inboxItems() -> [ActionInboxItem] {
        guard let data = try? Data(contentsOf: inboxURL),
              let inbox = try? decoder.decode(ActionInbox.self, from: data),
              inbox.version == 1
        else {
            return []
        }
        return inbox.items.filter {
            ["approval", "blocked", "completed", "failed"].contains($0.state)
        }
    }

    func acknowledgeInboxItem(id: String) {
        let remaining = inboxItems().filter { $0.id != id }
        let inbox = ActionInbox(version: 1, items: remaining)
        guard let data = try? JSONEncoder().encode(inbox) else {
            return
        }
        try? FileManager.default.createDirectory(
            at: runtimeDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        do {
            try data.write(to: inboxURL, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: inboxURL.path
            )
        } catch {
            return
        }
    }

    func liveSnapshots() -> [PetSnapshot] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: sessionsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return files.compactMap { file in
            guard file.pathExtension == "json",
                  let data = try? Data(contentsOf: file),
                  let snapshot = try? decoder.decode(PetSnapshot.self, from: data),
                  snapshot.version == 1,
                  snapshot.client == "pi"
            else {
                return nil
            }
            if snapshot.phase == "stopped" || !processIsAlive(snapshot.pid) {
                try? FileManager.default.removeItem(at: file)
                return nil
            }
            return snapshot
        }
    }

    func requestFocus(sessionId: String) {
        let requestsDirectory = runtimeDirectory.appendingPathComponent("requests", isDirectory: true)
        let destination = requestsDirectory.appendingPathComponent("focus.json")
        let payload: [String: Any] = [
            "version": 1,
            "sessionId": sessionId,
            "requestedAt": ISO8601DateFormatter().string(from: Date())
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return
        }
        try? FileManager.default.createDirectory(
            at: requestsDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        do {
            try data.write(to: destination, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: destination.path
            )
        } catch {
            return
        }
    }
}

private final class PetView: NSView {
    var onActivate: (() -> Void)?
    var onQuit: (() -> Void)?
    var onMoved: ((NSPoint) -> Void)?

    private let atlas: NSImage
    private var currentAnimation = Animation(
        frames: idleFrames.map {
            AnimationFrame(row: $0.row, column: $0.column, duration: $0.duration * 6)
        },
        loopStartIndex: 0,
        label: "Ready"
    )
    private var currentSnapshot: PetSnapshot?
    private var transientState: String?
    private var lookFrame: AnimationFrame?
    private var frameIndex = 0
    private var timer: Timer?
    private var pointerTimer: Timer?
    private var isAnimating = false
    private var dragStartMouse: NSPoint?
    private var dragStartWindow: NSPoint?
    private var previousDragMouse: NSPoint?
    private var didDrag = false

    init(frame: NSRect, atlas: NSImage) {
        self.atlas = atlas
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        timer?.invalidate()
        pointerTimer?.invalidate()
    }

    func update(snapshot: PetSnapshot) {
        currentSnapshot = snapshot
        guard transientState == nil else {
            return
        }
        apply(animation: animationSpec(for: snapshot))
    }

    private func apply(animation next: Animation) {
        let animationChanged =
            next.frames != currentAnimation.frames ||
            next.loopStartIndex != currentAnimation.loopStartIndex
        currentAnimation = next
        if animationChanged {
            frameIndex = 0
            if isAnimating, lookFrame == nil {
                scheduleNextFrame()
            }
        }
        needsDisplay = true
    }

    func setAnimating(_ active: Bool) {
        guard active != isAnimating else {
            return
        }
        isAnimating = active
        if active {
            if lookFrame == nil {
                scheduleNextFrame()
            }
            pointerTimer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) {
                [weak self] _ in self?.updatePointerLook()
            }
        } else {
            timer?.invalidate()
            timer = nil
            pointerTimer?.invalidate()
            pointerTimer = nil
        }
    }

    private func scheduleNextFrame() {
        timer?.invalidate()
        guard isAnimating, lookFrame == nil, !currentAnimation.frames.isEmpty else {
            return
        }
        let frame = currentAnimation.frames[frameIndex % currentAnimation.frames.count]
        timer = Timer.scheduledTimer(withTimeInterval: frame.duration, repeats: false) {
            [weak self] _ in
            guard let self, self.isAnimating else {
                return
            }
            let nextIndex = self.frameIndex + 1
            if nextIndex >= self.currentAnimation.frames.count {
                guard let loopStartIndex = self.currentAnimation.loopStartIndex else {
                    self.frameIndex = self.currentAnimation.frames.count - 1
                    self.timer = nil
                    return
                }
                self.frameIndex = loopStartIndex
            } else {
                self.frameIndex = nextIndex
            }
            self.needsDisplay = true
            self.scheduleNextFrame()
        }
    }

    private func updatePointerLook() {
        guard transientState == nil,
              currentSnapshot?.phase == "idle",
              let window
        else {
            setLookFrame(nil)
            return
        }

        let petCenter = NSPoint(
            x: window.frame.minX + 80,
            y: window.frame.minY + 99.5
        )
        let pointer = NSEvent.mouseLocation
        let deltaX = pointer.x - petCenter.x
        let deltaY = pointer.y - petCenter.y
        guard hypot(deltaX, deltaY) > 24 else {
            setLookFrame(nil)
            return
        }

        let degrees = atan2(deltaX, deltaY) * 180 / .pi
        let normalized = degrees < 0 ? degrees + 360 : degrees
        let direction = Int((normalized / 22.5).rounded()) % 16
        setLookFrame(
            AnimationFrame(
                row: direction < 8 ? 9 : 10,
                column: direction % 8,
                duration: 0
            )
        )
    }

    private func setLookFrame(_ next: AnimationFrame?) {
        guard next != lookFrame else {
            return
        }
        lookFrame = next
        timer?.invalidate()
        timer = nil
        if next == nil, isAnimating {
            scheduleNextFrame()
        }
        needsDisplay = true
    }

    private func setTransientState(_ state: String?) {
        guard state != transientState else {
            return
        }
        transientState = state
        guard let currentSnapshot else {
            return
        }
        apply(animation: animationSpec(for: currentSnapshot, stateOverride: state))
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let petRect = NSRect(x: 14, y: 28, width: 132, height: 143)
        let frame = lookFrame ??
            currentAnimation.frames[frameIndex % currentAnimation.frames.count]
        let sourceY = atlas.size.height - CGFloat(frame.row + 1) * cellHeight
        let sourceRect = NSRect(
            x: CGFloat(frame.column) * cellWidth,
            y: sourceY,
            width: cellWidth,
            height: cellHeight
        )
        atlas.draw(
            in: petRect,
            from: sourceRect,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: false,
            hints: [.interpolation: NSImageInterpolation.none]
        )

        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        let label = currentAnimation.label as NSString
        let textSize = label.size(withAttributes: attributes)
        let pillRect = NSRect(
            x: max(6, (bounds.width - textSize.width - 18) / 2),
            y: 4,
            width: min(bounds.width - 12, textSize.width + 18),
            height: 22
        )
        NSColor.black.withAlphaComponent(0.72).setFill()
        NSBezierPath(roundedRect: pillRect, xRadius: 11, yRadius: 11).fill()
        label.draw(
            at: NSPoint(
                x: pillRect.midX - textSize.width / 2,
                y: pillRect.midY - textSize.height / 2
            ),
            withAttributes: attributes
        )
    }

    override func mouseDown(with event: NSEvent) {
        dragStartMouse = NSEvent.mouseLocation
        dragStartWindow = window?.frame.origin
        previousDragMouse = dragStartMouse
        didDrag = false
        setLookFrame(nil)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startMouse = dragStartMouse,
              let startWindow = dragStartWindow,
              let window
        else {
            return
        }
        let current = NSEvent.mouseLocation
        let delta = NSPoint(x: current.x - startMouse.x, y: current.y - startMouse.y)
        if abs(delta.x) > 3 || abs(delta.y) > 3 {
            didDrag = true
        }
        if let previousDragMouse {
            let step = current.x - previousDragMouse.x
            if step >= 4 {
                setTransientState("running-right")
            } else if step <= -4 {
                setTransientState("running-left")
            }
        }
        previousDragMouse = current
        window.setFrameOrigin(NSPoint(x: startWindow.x + delta.x, y: startWindow.y + delta.y))
    }

    override func mouseUp(with event: NSEvent) {
        setTransientState(nil)
        if didDrag, let origin = window?.frame.origin {
            onMoved?(origin)
        } else {
            onActivate?()
        }
        dragStartMouse = nil
        dragStartWindow = nil
        previousDragMouse = nil
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let hide = NSMenuItem(title: "Hide Pi Pet", action: #selector(hidePet), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)
        let quit = NSMenuItem(title: "Quit Pi Pet", action: #selector(quitPet), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func hidePet() {
        window?.orderOut(nil)
    }

    @objc private func quitPet() {
        onQuit?()
    }
}

private final class PetController {
    private let store = PetStore()
    private let panel: NSPanel
    private let petView: PetView
    private var pollTimer: Timer?
    private var selected: PetSnapshot?
    private var selectedInbox: ActionInboxItem?
    private var acknowledgedCompletions = Set<String>()
    private var notifiedCompletions = Set<String>()

    init?(atlas: NSImage) {
        let frame = NSRect(origin: .zero, size: NSSize(width: 160, height: 178))
        panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        petView = PetView(frame: frame, atlas: atlas)

        panel.contentView = petView
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true

        let savedOrigin = UserDefaults.standard.string(forKey: "windowOrigin")
            .flatMap(Self.parsePoint)
        let defaultOrigin = Self.defaultOrigin(for: frame.size)
        panel.setFrameOrigin(Self.visibleOrigin(savedOrigin ?? defaultOrigin, size: frame.size))

        petView.onActivate = { [weak self] in
            self?.activateSelectedSession()
        }
        petView.onMoved = { origin in
            UserDefaults.standard.set("\(origin.x),\(origin.y)", forKey: "windowOrigin")
        }
        petView.onQuit = {
            NSApp.terminate(nil)
        }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    deinit {
        pollTimer?.invalidate()
    }

    func showIfAvailable() {
        refresh()
    }

    private func refresh() {
        let inbox = store.inboxItems().filter {
            inboxItemRequiresAttention($0)
        }.sorted { left, right in
            let priorityDifference = phasePriority(left.phase) - phasePriority(right.phase)
            if priorityDifference != 0 {
                return priorityDifference > 0
            }
            return parsedDate(left.updatedAt) > parsedDate(right.updatedAt)
        }
        let liveCandidates = store.liveSnapshots().filter { snapshot in
            snapshot.phase != "completed" ||
                !acknowledgedCompletions.contains(snapshot.completionKey)
        }
        let candidates = liveCandidates + inbox.map(\.snapshot)
        let next = candidates.sorted { left, right in
            let priorityDifference = phasePriority(left.phase) - phasePriority(right.phase)
            if priorityDifference != 0 {
                return priorityDifference > 0
            }
            return parsedDate(left.updatedAt) > parsedDate(right.updatedAt)
        }.first

        guard let next else {
            selected = nil
            selectedInbox = nil
            petView.setAnimating(false)
            panel.orderOut(nil)
            return
        }

        selected = next
        selectedInbox = inbox.first(where: {
            $0.id == next.sessionId || $0.sessionId == next.sessionId
        })
        petView.update(snapshot: next)
        petView.setAnimating(true)
        panel.orderFrontRegardless()

        if next.phase == "completed",
           notifiedCompletions.insert(next.completionKey).inserted
        {
            notifyCompletion()
        }
    }

    private func activateSelectedSession() {
        guard let selected else {
            return
        }

        if let selectedInbox {
            store.acknowledgeInboxItem(id: selectedInbox.id)
        }
        if selected.phase == "completed" {
            acknowledgedCompletions.insert(selected.completionKey)
        }

        if selected.workspaceId != nil {
            store.requestFocus(sessionId: selected.sessionId)
        }
        run(executableCandidates: ["/usr/bin/open"], arguments: ["-a", "cmux"])
        refresh()
    }

    private func notifyCompletion() {
        let content = UNMutableNotificationContent()
        content.title = "Pi finished"
        content.body = "Click Paddington to return to the completed session."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    private func run(executableCandidates: [String], arguments: [String]) {
        guard let executable = executableCandidates.first(where: {
            FileManager.default.isExecutableFile(atPath: $0)
        }) else {
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        try? process.run()
    }

    private static func parsePoint(_ value: String) -> NSPoint? {
        let parts = value.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2 else {
            return nil
        }
        return NSPoint(x: parts[0], y: parts[1])
    }

    private static func defaultOrigin(for size: NSSize) -> NSPoint {
        guard let visible = NSScreen.main?.visibleFrame else {
            return NSPoint(x: 40, y: 40)
        }
        return NSPoint(
            x: visible.maxX - size.width - 24,
            y: visible.minY + 24
        )
    }

    private static func visibleOrigin(_ origin: NSPoint, size: NSSize) -> NSPoint {
        let candidate = NSRect(origin: origin, size: size)
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(candidate) }) {
            return origin
        }
        return defaultOrigin(for: size)
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: PetController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        guard let atlas = loadAtlas() else {
            let alert = NSAlert()
            alert.messageText = "Pi Pet could not load Paddington"
            alert.informativeText = "Expected ~/.codex/pets/paddington/spritesheet.webp"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        controller = PetController(atlas: atlas)
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        controller?.showIfAvailable()
        return true
    }

    private func loadAtlas() -> NSImage? {
        let userAtlas = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/pets/paddington/spritesheet.webp")
        if let image = NSImage(contentsOf: userAtlas) {
            return image
        }
        guard let bundled = Bundle.main.url(forResource: "spritesheet", withExtension: "webp") else {
            return nil
        }
        return NSImage(contentsOf: bundled)
    }
}

private let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.run()
