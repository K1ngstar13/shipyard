import UIKit
import ARKit
import RealityKit

/// AR putt read: the LiDAR measures the ground around the cup right now, the web layer (Tap-In's
/// putt solver) computes the line, and this view draws it on the real grass: the putt's path, the
/// aim point and tee gates, plus numbered ball spots for the accuracy test.
///
/// The web layer drives everything through GreenScanPlugin:
///   arUi   → title, help text, button rows, what a tap on the grass means ("cup", "ball", "none")
///   arDraw → lines / markers / gates in world coordinates (east, north, up; metres)
///   arMeasure → height grid of everything scanned so far (event "surface")
/// and receives events: "tap" (a point on the ground), "button" (id), "surface", "closed".
/// World alignment is gravity + compass: +Y up, −Z true north, +X east.
final class ARReadViewController: UIViewController, ARSessionDelegate {
    var onEvent: (([String: Any]) -> Void)?
    private var arView: ARView!
    private let titleL = UILabel()
    private let subL = UILabel()
    private let map = UIImageView()
    private let rows = UIStackView()
    private let root = AnchorEntity(world: .zero)
    private var tapMode = "none"
    private var showMap = true
    private var lastCov: TimeInterval = 0
    private var busy = false
    private var closed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else {
            onEvent?(["type": "error", "message": "This iPhone has no LiDAR scanner"]); return
        }
        arView = ARView(frame: view.bounds)
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.environment.sceneUnderstanding.options.insert(.collision) // taps hit the scanned grass
        arView.renderOptions.insert(.disableMotionBlur)
        view.addSubview(arView)
        arView.scene.addAnchor(root)

        let cfg = ARWorldTrackingConfiguration()
        cfg.sceneReconstruction = .mesh
        cfg.worldAlignment = .gravityAndHeading
        cfg.environmentTexturing = .none
        arView.session.delegate = self
        arView.session.run(cfg)
        arView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))

        for l in [titleL, subL] {
            l.textColor = .white
            l.numberOfLines = 0
            l.textAlignment = .left
            l.backgroundColor = UIColor.black.withAlphaComponent(0.62)
            l.layer.cornerRadius = 12
            l.clipsToBounds = true
            l.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(l)
        }
        titleL.font = .systemFont(ofSize: 18, weight: .heavy)
        subL.font = .systemFont(ofSize: 14, weight: .semibold)
        map.translatesAutoresizingMaskIntoConstraints = false
        map.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        map.layer.cornerRadius = 10
        map.clipsToBounds = true
        map.contentMode = .scaleAspectFit
        map.layer.magnificationFilter = .nearest
        view.addSubview(map)

        let close = UIButton(type: .system)
        close.setTitle("✕", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 22, weight: .bold)
        close.setTitleColor(.white, for: .normal)
        close.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        close.layer.cornerRadius = 20
        close.translatesAutoresizingMaskIntoConstraints = false
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(close)

        rows.axis = .vertical
        rows.spacing = 8
        rows.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(rows)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            close.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            close.widthAnchor.constraint(equalToConstant: 40), close.heightAnchor.constraint(equalToConstant: 40),
            titleL.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            titleL.leadingAnchor.constraint(equalTo: close.trailingAnchor, constant: 8),
            titleL.trailingAnchor.constraint(equalTo: map.leadingAnchor, constant: -8),
            subL.topAnchor.constraint(equalTo: titleL.bottomAnchor, constant: 6),
            subL.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            subL.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            map.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            map.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            map.widthAnchor.constraint(equalToConstant: 96), map.heightAnchor.constraint(equalToConstant: 96),
            rows.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            rows.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            rows.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -10),
        ])
        setUI(["title": "Starting AR…", "sub": "", "rows": [], "tap": "none", "map": true])
    }

    // MARK: driven by the web layer

    /// title, sub, rows: [[{id, label, style}]], tap: "cup" | "ball" | "none", map: Bool
    func setUI(_ o: [String: Any]) {
        titleL.text = "  " + ((o["title"] as? String) ?? "") + "  "
        let sub = (o["sub"] as? String) ?? ""
        subL.text = sub.isEmpty ? nil : sub.split(separator: "\n").map { "  \($0)  " }.joined(separator: "\n")
        subL.isHidden = sub.isEmpty
        tapMode = (o["tap"] as? String) ?? "none"
        showMap = (o["map"] as? Bool) ?? false
        map.isHidden = !showMap
        rows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for r in (o["rows"] as? [[[String: Any]]]) ?? [] {
            let row = UIStackView()
            row.axis = .horizontal; row.spacing = 8; row.distribution = .fillEqually
            for b in r {
                let id = (b["id"] as? String) ?? ""
                let style = (b["style"] as? String) ?? "plain"
                let btn = UIButton(type: .system)
                btn.setTitle((b["label"] as? String) ?? id, for: .normal)
                btn.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
                btn.titleLabel?.adjustsFontSizeToFitWidth = true
                btn.titleLabel?.minimumScaleFactor = 0.6
                btn.layer.cornerRadius = 12
                switch style {
                case "primary": btn.backgroundColor = UIColor(red: 0.2, green: 0.91, blue: 0.62, alpha: 1); btn.setTitleColor(.black, for: .normal)
                case "on": btn.backgroundColor = UIColor(red: 1, green: 0.87, blue: 0.34, alpha: 1); btn.setTitleColor(.black, for: .normal)
                case "warn": btn.backgroundColor = UIColor(red: 1, green: 0.3, blue: 0.37, alpha: 0.9); btn.setTitleColor(.white, for: .normal)
                default: btn.backgroundColor = UIColor.black.withAlphaComponent(0.6); btn.setTitleColor(.white, for: .normal)
                }
                btn.accessibilityIdentifier = id
                btn.addTarget(self, action: #selector(buttonTapped(_:)), for: .touchUpInside)
                btn.heightAnchor.constraint(equalToConstant: 48).isActive = true
                row.addArrangedSubview(btn)
            }
            rows.addArrangedSubview(row)
        }
    }

    /// items: [{kind: "line"|"marker"|"gate", …}] in world east/north/up metres; replaces what was drawn.
    func draw(_ items: [[String: Any]]) {
        root.children.removeAll()
        for it in items {
            let kind = (it["kind"] as? String) ?? ""
            let color = ARReadViewController.color((it["color"] as? String) ?? "#ffffff")
            switch kind {
            case "line":
                let pts = ((it["points"] as? [[Double]]) ?? []).map { ARReadViewController.world($0) }
                let w = Float((it["width"] as? Double) ?? 0.012)
                let mat = UnlitMaterial(color: color)
                for k in 1..<max(1, pts.count) {
                    let a = pts[k - 1], b = pts[k]
                    let len = simd_distance(a, b)
                    if len < 0.002 { continue }
                    let seg = ModelEntity(mesh: .generateBox(width: w, height: 0.004, depth: len), materials: [mat])
                    seg.look(at: b, from: (a + b) / 2, relativeTo: nil)
                    root.addChild(seg)
                }
            case "marker":
                let p = ARReadViewController.world([(it["e"] as? Double) ?? 0, (it["n"] as? Double) ?? 0, (it["u"] as? Double) ?? 0])
                let r = Float((it["radius"] as? Double) ?? 0.03)
                let dot = ModelEntity(mesh: .generateSphere(radius: r), materials: [UnlitMaterial(color: color)])
                dot.position = p + SIMD3<Float>(0, r * 0.6, 0)
                root.addChild(dot)
                if let label = it["label"] as? String, !label.isEmpty {
                    let size = CGFloat((it["textSize"] as? Double) ?? 0.07)
                    let txt = ModelEntity(mesh: .generateText(label, extrusionDepth: 0.002, font: .systemFont(ofSize: size, weight: .heavy), containerFrame: .zero, alignment: .center, lineBreakMode: .byWordWrapping),
                                          materials: [UnlitMaterial(color: .white)])
                    let bounds = txt.visualBounds(relativeTo: nil)
                    txt.position = p + SIMD3<Float>(-(bounds.extents.x / 2), r * 2 + 0.03, 0)
                    if #available(iOS 18.0, *) { txt.components.set(BillboardComponent()) }
                    root.addChild(txt)
                }
            case "gate":
                // two tee pegs either side of the line, square to the direction of the putt there
                let p = ARReadViewController.world([(it["e"] as? Double) ?? 0, (it["n"] as? Double) ?? 0, (it["u"] as? Double) ?? 0])
                let de = Float((it["dirE"] as? Double) ?? 1), dn = Float((it["dirN"] as? Double) ?? 0)
                let half = Float((it["half"] as? Double) ?? 0.034)
                let side = SIMD3<Float>(-dn, 0, -de) // world (x = east, z = −north) left of the direction
                let lift = SIMD3<Float>(0, 0.035, 0)
                for s: Float in [-1, 1] {
                    let tee = ModelEntity(mesh: .generateBox(width: 0.008, height: 0.07, depth: 0.008), materials: [UnlitMaterial(color: color)])
                    tee.position = p + side * (half * s) + lift
                    root.addChild(tee)
                    let head = ModelEntity(mesh: .generateSphere(radius: 0.009), materials: [UnlitMaterial(color: color)])
                    head.position = p + side * (half * s) + lift * 2
                    root.addChild(head)
                }
            default: break
            }
        }
    }

    /// Height grid of everything scanned so far (east/north/up), sent back as a "surface" event.
    func measure(cell: Float) {
        guard let frame = arView?.session.currentFrame else { onEvent?(["type": "error", "message": "AR isn't running"]); return }
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        DispatchQueue.global(qos: .userInitiated).async {
            let r = GreenScanViewController.grid(anchors: anchors, cell: cell)
            DispatchQueue.main.async {
                switch r {
                case .success(var d): d["type"] = "surface"; self.onEvent?(d)
                case .failure(let e): self.onEvent?(["type": "error", "message": e.localizedDescription])
                }
            }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        arView?.session.pause()
        dismiss(animated: true) { self.onEvent?(["type": "closed"]) }
    }

    // MARK: input

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard tapMode != "none" else { return }
        let pt = g.location(in: arView)
        var hit: SIMD3<Float>? = nil
        if let h = arView.hitTest(pt, query: .nearest, mask: .sceneUnderstanding).first { hit = h.position }
        else if let r = arView.raycast(from: pt, allowing: .estimatedPlane, alignment: .horizontal).first {
            let t = r.worldTransform.columns.3; hit = SIMD3<Float>(t.x, t.y, t.z)
        }
        guard let p = hit else { onEvent?(["type": "miss", "mode": tapMode]); return }
        onEvent?(["type": "tap", "mode": tapMode, "e": Double(p.x), "n": Double(-p.z), "u": Double(p.y)])
    }

    @objc private func buttonTapped(_ b: UIButton) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onEvent?(["type": "button", "id": b.accessibilityIdentifier ?? ""])
    }

    @objc private func closeTapped() { close() }

    // MARK: live coverage map + tracking state

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        guard t - lastCov > 0.7, !busy else { return }
        lastCov = t
        if case .limited(let reason) = frame.camera.trackingState {
            onEvent?(["type": "tracking", "state": "limited", "reason": "\(reason)"])
        }
        guard showMap else { return }
        busy = true
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        let m = frame.camera.transform
        let cam = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        DispatchQueue.global(qos: .utility).async {
            let r = GreenScanViewController.coverage(anchors: anchors, camera: cam)
            DispatchQueue.main.async { self.busy = false; self.map.image = r.image }
        }
    }

    // MARK: helpers

    /// [east, north, up] → RealityKit world (x = east, y = up, z = −north)
    static func world(_ v: [Double]) -> SIMD3<Float> {
        SIMD3<Float>(Float(v.count > 0 ? v[0] : 0), Float(v.count > 2 ? v[2] : 0), -Float(v.count > 1 ? v[1] : 0))
    }

    static func color(_ hex: String) -> UIColor {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
