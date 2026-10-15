import UIKit
import ARKit
import RealityKit

/// Full-screen LiDAR green scanner with live coaching.
///
/// While you walk, Tap-In tells you:
///  • HEIGHT: phone height above the grass (best 0.5–1.1 m / 20–45″)
///  • ANGLE: how far the phone points down (best 35–70°)
///  • SPEED: slow down above ~0.6 m/s
///  • COVERAGE: a live top-down map. Green = well scanned, yellow = thin,
///    red = gaps inside the scanned area. Walk over the red and yellow spots only.
/// World alignment is gravity + compass, so +Y is exactly "up" and −Z is true north.
final class GreenScanViewController: UIViewController, ARSessionDelegate {
    enum ScanError: LocalizedError {
        case cancelled, noData, unsupported
        var errorDescription: String? {
            switch self {
            case .cancelled: return "Scan cancelled"
            case .noData: return "Not enough of the green was captured — walk the whole green and try again"
            case .unsupported: return "LiDAR scanning isn't supported on this device"
            }
        }
    }

    private let cell: Float
    private let completion: (Result<[String: Any], Error>) -> Void
    private var arView: ARView!
    private let status = UILabel()
    private let coach = UILabel()
    private let map = UIImageView()
    private let mapLabel = UILabel()
    private var lastStatus: TimeInterval = 0
    private var lastPos: SIMD3<Float>? = nil
    private var lastPosT: TimeInterval = 0
    private var speed: Float = 0
    private var groundY: Float? = nil
    private var busy = false
    private var finished = false

    init(cell: Float, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.cell = max(0.05, cell)
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else {
            finish(.failure(ScanError.unsupported)); return
        }
        arView = ARView(frame: view.bounds)
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.debugOptions.insert(.showSceneUnderstanding)
        view.addSubview(arView)

        let cfg = ARWorldTrackingConfiguration()
        cfg.sceneReconstruction = .mesh
        cfg.worldAlignment = .gravityAndHeading
        cfg.environmentTexturing = .none
        arView.session.delegate = self
        arView.session.run(cfg)

        for l in [status, coach, mapLabel] {
            l.textColor = .white
            l.numberOfLines = 0
            l.textAlignment = .center
            l.backgroundColor = UIColor.black.withAlphaComponent(0.6)
            l.layer.cornerRadius = 12
            l.clipsToBounds = true
            l.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(l)
        }
        status.font = .systemFont(ofSize: 14, weight: .semibold)
        coach.font = .systemFont(ofSize: 20, weight: .heavy)
        mapLabel.font = .systemFont(ofSize: 12, weight: .bold)
        status.text = "Walk the edge of the green once, then make 2–3 slow passes across it. Include a foot of fringe."
        map.translatesAutoresizingMaskIntoConstraints = false
        map.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        map.layer.cornerRadius = 12
        map.clipsToBounds = true
        map.contentMode = .scaleAspectFit
        map.layer.magnificationFilter = .nearest
        view.addSubview(map)

        let cancel = button("Cancel", color: UIColor.white.withAlphaComponent(0.2), action: #selector(cancelTapped))
        let done = button("Finish scan", color: UIColor(red: 0.2, green: 0.91, blue: 0.62, alpha: 1), action: #selector(doneTapped))
        done.setTitleColor(.black, for: .normal)
        let row = UIStackView(arrangedSubviews: [cancel, done])
        row.axis = .horizontal; row.spacing = 12; row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(row)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: g.topAnchor, constant: 10),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            status.trailingAnchor.constraint(equalTo: map.leadingAnchor, constant: -10),
            map.topAnchor.constraint(equalTo: g.topAnchor, constant: 10),
            map.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            map.widthAnchor.constraint(equalToConstant: 140),
            map.heightAnchor.constraint(equalToConstant: 140),
            mapLabel.topAnchor.constraint(equalTo: map.bottomAnchor, constant: 4),
            mapLabel.centerXAnchor.constraint(equalTo: map.centerXAnchor),
            mapLabel.widthAnchor.constraint(equalTo: map.widthAnchor),
            coach.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            coach.bottomAnchor.constraint(equalTo: row.topAnchor, constant: -16),
            coach.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32),
            row.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            row.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            row.heightAnchor.constraint(equalToConstant: 54),
        ])
    }

    private func button(_ title: String, color: UIColor, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        b.setTitleColor(.white, for: .normal)
        b.backgroundColor = color
        b.layer.cornerRadius = 14
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    // MARK: live coaching

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        let m = frame.camera.transform
        let pos = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        if let lp = lastPos, t - lastPosT > 0.25 {
            let d = simd_distance(SIMD3(pos.x, 0, pos.z), SIMD3(lp.x, 0, lp.z))
            speed = 0.6 * speed + 0.4 * d / Float(t - lastPosT)
            lastPos = pos; lastPosT = t
        } else if lastPos == nil { lastPos = pos; lastPosT = t }
        guard t - lastStatus > 0.5 else { return }
        lastStatus = t

        // camera looks along −Z; how far it points below level
        let fwd = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        let pitchDown = asin(max(-1, min(1, -fwd.y))) * 180 / .pi
        var tips: [String] = []
        var good = true
        if case .limited(let reason) = frame.camera.trackingState {
            good = false
            switch reason {
            case .excessiveMotion: tips.append("Slow down")
            case .insufficientFeatures: tips.append("Point at the grass")
            default: tips.append("Hold steady…")
            }
        }
        if speed > 0.65 { tips.append("Walk slower"); good = false }
        if pitchDown < 30 { tips.append("Tilt the phone down more"); good = false }
        else if pitchDown > 75 { tips.append("Tilt up a little (look ahead)"); good = false }
        if let gy = groundY {
            let h = pos.y - gy
            if h > 1.25 { tips.append(String(format: "Lower the phone (%.0f″ high)", h * 39.37)); good = false }
            else if h < 0.4 { tips.append(String(format: "Raise the phone (%.0f″ high)", h * 39.37)); good = false }
        }
        coach.text = good ? "✓ Good. Keep going" : tips.joined(separator: "\n")
        coach.textColor = good ? UIColor(red: 0.6, green: 1, blue: 0.75, alpha: 1) : UIColor(red: 1, green: 0.85, blue: 0.35, alpha: 1)

        // coverage map + ground height off the main thread, at most every 0.5 s
        if busy { return }
        busy = true
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        let cam = pos
        DispatchQueue.global(qos: .utility).async {
            let r = GreenScanViewController.coverage(anchors: anchors, camera: cam)
            DispatchQueue.main.async {
                self.busy = false
                self.map.image = r.image
                self.groundY = r.groundY
                self.mapLabel.text = r.cells < 30 ? "Start walking" : String(format: "Coverage %.0f%% · %d gap%@", r.pct, r.gaps, r.gaps == 1 ? "" : "s")
            }
        }
    }

    /// Top-down map: points per 20 cm cell, gaps = empty cells surrounded by scanned ones.
    static func coverage(anchors: [ARMeshAnchor], camera: SIMD3<Float>) -> (image: UIImage?, pct: Double, gaps: Int, cells: Int, groundY: Float?) {
        let c: Float = 0.2
        var counts: [Int: Int] = [:]
        var nearY: [Float] = []
        var minX = Float.greatestFiniteMagnitude, maxX = -Float.greatestFiniteMagnitude, minZ = Float.greatestFiniteMagnitude, maxZ = -Float.greatestFiniteMagnitude
        for a in anchors {
            let v = a.geometry.vertices
            let base = v.buffer.contents()
            let step = max(1, v.count / 4000) // sample large meshes
            var i = 0
            while i < v.count {
                let p = base.advanced(by: v.offset + v.stride * i).assumingMemoryBound(to: Float.self)
                let w = a.transform * SIMD4<Float>(p[0], p[1], p[2], 1)
                let ix = Int((w.x / c).rounded(.down)), iz = Int((w.z / c).rounded(.down))
                counts[ix &* 100003 &+ iz, default: 0] += step
                minX = min(minX, w.x); maxX = max(maxX, w.x); minZ = min(minZ, w.z); maxZ = max(maxZ, w.z)
                if abs(w.x - camera.x) < 1.0 && abs(w.z - camera.z) < 1.0 && w.y < camera.y - 0.15 { nearY.append(w.y) }
                i += step
            }
        }
        let ground: Float? = nearY.count > 20 ? nearY.sorted()[nearY.count / 2] : nil
        guard minX < maxX, minZ < maxZ else { return (nil, 0, 0, 0, ground) }
        let nx = Int(((maxX - minX) / c).rounded(.up)) + 1, nz = Int(((maxZ - minZ) / c).rounded(.up)) + 1
        guard nx * nz < 250_000 else { return (nil, 0, 0, counts.count, ground) }
        let x0 = Int((minX / c).rounded(.down)), z0 = Int((minZ / c).rounded(.down))
        let count = { (i: Int, j: Int) -> Int in counts[(x0 + i) &* 100003 &+ (z0 + j)] ?? 0 }
        var good = 0, thin = 0, gaps = 0
        var px = [UInt8](repeating: 0, count: nx * nz * 4)
        for j in 0..<nz {
            for i in 0..<nx {
                let n = count(i, j)
                var col: (UInt8, UInt8, UInt8, UInt8) = (0, 0, 0, 0)
                if n >= 12 { col = (52, 232, 158, 255); good += 1 }
                else if n > 0 { col = (255, 205, 60, 255); thin += 1 }
                else {
                    var around = 0
                    for (di, dj) in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] where count(i + di, j + dj) > 0 { around += 1 }
                    if around >= 5 { col = (255, 70, 80, 255); gaps += 1 }
                }
                let k = (j * nx + i) * 4 // row 0 = smallest Z = north at the top
                px[k] = col.0; px[k + 1] = col.1; px[k + 2] = col.2; px[k + 3] = col.3
            }
        }
        // camera dot
        let ci = Int((camera.x / c).rounded(.down)) - x0, cj = Int((camera.z / c).rounded(.down)) - z0
        for dj in -1...1 { for di in -1...1 {
            let i = ci + di, j = cj + dj
            if i >= 0 && i < nx && j >= 0 && j < nz { let k = (j * nx + i) * 4; px[k] = 255; px[k + 1] = 255; px[k + 2] = 255; px[k + 3] = 255 }
        } }
        let total = good + thin + gaps
        let pct = total > 0 ? Double(good) / Double(total) * 100 : 0
        let provider = CGDataProvider(data: Data(px) as CFData)!
        let cg = CGImage(width: nx, height: nz, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: nx * 4, space: CGColorSpaceCreateDeviceRGB(),
                         bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        return (cg.map { UIImage(cgImage: $0) }, pct, gaps, total, ground)
    }

    // MARK: finish

    @objc private func cancelTapped() { finish(.failure(ScanError.cancelled)) }

    @objc private func doneTapped() {
        guard let frame = arView.session.currentFrame else { finish(.failure(ScanError.noData)); return }
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        status.text = "Building your green…"
        let cell = self.cell
        DispatchQueue.global(qos: .userInitiated).async {
            let result = GreenScanViewController.grid(anchors: anchors, cell: cell)
            DispatchQueue.main.async { self.finish(result) }
        }
    }

    /// Bins every mesh vertex (world space) into a height grid: x = east, y = north, value = up.
    static func grid(anchors: [ARMeshAnchor], cell: Float) -> Result<[String: Any], Error> {
        var east: [Float] = [], north: [Float] = [], up: [Float] = []
        for a in anchors {
            let v = a.geometry.vertices
            let base = v.buffer.contents()
            for i in 0..<v.count {
                let p = base.advanced(by: v.offset + v.stride * i).assumingMemoryBound(to: Float.self)
                let w = a.transform * SIMD4<Float>(p[0], p[1], p[2], 1)
                east.append(w.x); north.append(-w.z); up.append(w.y)
            }
        }
        guard east.count > 500, let e0 = east.min(), let e1 = east.max(), let n0 = north.min(), let n1 = north.max() else {
            return .failure(ScanError.noData)
        }
        // keep the raw points too: Files app → On My iPhone → Tap-In → Scans (for re-processing / sharing)
        let plyName = savePly(east: east, north: north, up: up)
        let nx = Int(((e1 - e0) / cell).rounded(.up)) + 1
        let ny = Int(((n1 - n0) / cell).rounded(.up)) + 1
        guard nx * ny < 4_000_000 else { return .failure(ScanError.noData) }
        var buckets = [[Float]](repeating: [], count: nx * ny)
        for k in 0..<east.count {
            let i = Int((east[k] - e0) / cell), j = Int((north[k] - n0) / cell)
            buckets[j * nx + i].append(up[k])
        }
        var heights: [Any] = []
        var counts: [Int] = []
        heights.reserveCapacity(nx * ny)
        for b in buckets {
            counts.append(b.count)
            if b.count < 2 { heights.append(NSNull()); continue }
            let s = b.sorted()
            heights.append(NSNumber(value: s[s.count / 2])) // median rejects stray points
        }
        return .success([
            "cell": cell, "nx": nx, "ny": ny,
            "x0": -Float(nx - 1) * cell / 2, "y0": -Float(ny - 1) * cell / 2,
            "heights": heights, "counts": counts, "points": east.count, "northAligned": true,
            "file": plyName ?? "",
        ])
    }

    /// Writes the scan as a binary PLY (x = east, y = up, z = −north, metres; the ARKit convention
    /// Tap-In's importer expects) into Documents/Scans. Returns the file name, or nil on failure.
    static func savePly(east: [Float], north: [Float], up: [Float]) -> String? {
        let fm = FileManager.default
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let dir = docs.appendingPathComponent("Scans", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd_HHmmss"
        let name = "green-\(f.string(from: Date())).ply"
        var data = Data("ply\nformat binary_little_endian 1.0\ncomment Tap-In LiDAR scan, gravity + compass aligned, metres\nelement vertex \(east.count)\nproperty float x\nproperty float y\nproperty float z\nend_header\n".utf8)
        data.reserveCapacity(data.count + east.count * 12)
        var xyz = [Float]()
        xyz.reserveCapacity(east.count * 3)
        for k in 0..<east.count { xyz.append(east[k]); xyz.append(up[k]); xyz.append(-north[k]) }
        xyz.withUnsafeBytes { data.append(contentsOf: $0) } // arm64 is little-endian
        do { try data.write(to: dir.appendingPathComponent(name)); return name } catch { return nil }
    }

    private func finish(_ r: Result<[String: Any], Error>) {
        guard !finished else { return }
        finished = true
        arView?.session.pause()
        if presentingViewController != nil {
            dismiss(animated: true) { self.completion(r) }
        } else {
            completion(r)
        }
    }
}
