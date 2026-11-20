import Foundation
import UIKit
import Capacitor
import ARKit
import SceneKit
import CoreImage
import ReplayKit

/// Capacitor plugin: the live, world-anchored AR putt line.
///
/// The camera + ARKit view sits BEHIND the (transparent) web view, so every button and
/// label is the normal Tap-In web UI, while the putt line is real 3D geometry pinned to
/// the green. Walk around it and it stays put.
///
/// Native does only what the web layer can't:
///  • world tracking (gravity aligned; "east/north" are just the session's fixed X and −Z axes)
///  • small camera frames for the web layer's ball / flag detector
///  • ray-casts from a pixel to the ground (LiDAR depth when available)
///  • a height grid of the turf from the LiDAR mesh
///  • drawing the lines and markers the web layer computes
/// JS name: "ArPutt"  (see src/lib/arPutt.ts)
@objc(ArPuttPlugin)
public class ArPuttPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate, RPPreviewViewControllerDelegate {
    public let identifier = "ArPuttPlugin"
    public let jsName = "ArPutt"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDetect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "heights", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recStop", returnType: CAPPluginReturnPromise),
    ]

    // MARK: record the AR view (the real putt with the line on it)

    /// Starts a screen recording (iOS asks the golfer to allow it the first time).
    @objc func recStart(_ call: CAPPluginCall) {
        let rec = RPScreenRecorder.shared()
        guard rec.isAvailable else { call.reject("Screen recording isn't available right now"); return }
        if rec.isRecording { call.resolve(); return }
        rec.isMicrophoneEnabled = false
        rec.startRecording { err in
            if let e = err { call.reject(e.localizedDescription) } else { call.resolve() }
        }
    }

    /// Stops and hands the clip to the iPhone's share sheet: Save Video, AirDrop, Messages, Files.
    /// (Apple's own preview screen sat up under the status bar here and its X / Save didn't respond.)
    @objc func recStop(_ call: CAPPluginCall) {
        let rec = RPScreenRecorder.shared()
        guard rec.isRecording else { call.resolve(["shown": false]); return }
        if #available(iOS 14.0, *) {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Tap-In putt \(Int(Date().timeIntervalSince1970)).mp4")
            try? FileManager.default.removeItem(at: url)
            rec.stopRecording(withOutput: url) { err in
                DispatchQueue.main.async {
                    if let e = err { call.reject(e.localizedDescription); return }
                    guard let vc = self.bridge?.viewController else { call.reject("Couldn't show the recording"); return }
                    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    if let pop = share.popoverPresentationController {
                        pop.sourceView = vc.view
                        pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 120, width: 1, height: 1)
                    }
                    vc.present(share, animated: true)
                    call.resolve(["shown": true])
                }
            }
            return
        }
        rec.stopRecording { preview, err in
            DispatchQueue.main.async {
                guard let p = preview else { call.reject(err?.localizedDescription ?? "Nothing was recorded"); return }
                p.previewControllerDelegate = self
                self.bridge?.viewController?.present(p, animated: true)
                call.resolve(["shown": true])
            }
        }
    }

    public func previewControllerDidFinish(_ previewController: RPPreviewViewController) {
        previewController.dismiss(animated: true)
    }

    private var sceneView: ARSCNView?
    private let root = SCNNode()
    private var cams: [(id: Int, cam: ARCamera)] = []
    private var frameId = 0
    private var detectOn = true
    /// fast = small frames ~15 per second, for following a rolling ball or the putter head
    private var fastFrames = false
    private var encoding = false
    private var lastFrameT: TimeInterval = 0
    private var lastStatusT: TimeInterval = 0
    private var hasLidar = false
    private let ci = CIContext()
    private var savedBackground: UIColor?

    // Pinning the scene to the real ground. ARKit corrects its own drift by nudging anchors, not
    // the raw world axes. One anchor is dropped at the first ball; everything the web layer sees
    // (ball, cup, heights, camera) is given in that anchor's frame as it was when dropped, and the
    // drawing follows the anchor, so the line, ball and cup stay on the same blades of grass.
    private var pinAnchor: ARAnchor?
    private var pin0 = matrix_identity_float4x4
    /// scene frame → current world, and back
    private var delta = matrix_identity_float4x4
    private var deltaInv = matrix_identity_float4x4

    // MARK: lifecycle

    @objc func isAvailable(_ call: CAPPluginCall) {
        let ok = ARWorldTrackingConfiguration.isSupported
        let lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        call.resolve([
            "available": ok,
            "lidar": lidar,
            "reason": ok ? "" : "This device doesn't support AR.",
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard ARWorldTrackingConfiguration.isSupported else { call.reject("AR isn't supported on this device"); return }
            self.teardown()
            guard let web = self.bridge?.webView, let host = web.superview else { call.reject("Couldn't open the camera view"); return }

            let v = ARSCNView(frame: host.bounds)
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            v.automaticallyUpdatesLighting = false
            v.scene = SCNScene()
            v.scene.rootNode.addChildNode(self.root)
            v.session.delegate = self
            host.insertSubview(v, belowSubview: web)

            self.savedBackground = web.backgroundColor
            web.isOpaque = false
            web.backgroundColor = .clear
            web.scrollView.backgroundColor = .clear
            web.scrollView.isOpaque = false

            let cfg = ARWorldTrackingConfiguration()
            // Gravity only. With compass alignment ARKit keeps turning the whole world as the heading
            // estimate settles (worse near a metal tripod), which slid the line, ball and cup sideways.
            cfg.worldAlignment = .gravity
            cfg.planeDetection = [.horizontal]
            let lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
            if lidar { cfg.sceneReconstruction = .mesh }
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { cfg.frameSemantics.insert(.sceneDepth) }
            v.session.run(cfg, options: [.resetTracking, .removeExistingAnchors])

            self.sceneView = v
            self.hasLidar = lidar
            self.detectOn = true
            self.fastFrames = false
            self.encoding = false
            self.cams = []
            UIApplication.shared.isIdleTimerDisabled = true
            call.resolve(["lidar": lidar])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardown()
            call.resolve()
        }
    }

    private func teardown() {
        guard let v = sceneView else { return }
        v.session.pause()
        v.session.delegate = nil
        v.removeFromSuperview()
        sceneView = nil
        for n in root.childNodes { n.removeFromParentNode() }
        root.removeFromParentNode()
        root.simdTransform = matrix_identity_float4x4
        pinAnchor = nil
        pin0 = matrix_identity_float4x4
        delta = matrix_identity_float4x4
        deltaInv = matrix_identity_float4x4
        cams = []
        if let web = bridge?.webView {
            web.isOpaque = true
            web.backgroundColor = savedBackground ?? .black
            web.scrollView.backgroundColor = savedBackground ?? .black
        }
        UIApplication.shared.isIdleTimerDisabled = false
    }

    @objc func setDetect(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? true
        let fast = call.getBool("fast") ?? false
        DispatchQueue.main.async {
            self.fastFrames = fast
            self.detectOn = on
            call.resolve()
        }
    }

    // MARK: per-frame

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        if let a = pinAnchor, let cur = frame.anchors.first(where: { $0.identifier == a.identifier }) {
            let d = simd_mul(cur.transform, simd_inverse(pin0))
            delta = d
            deltaInv = simd_inverse(d)
            root.simdTransform = d
        }
        if t - lastStatusT > 0.4 {
            lastStatusT = t
            let m = frame.camera.transform
            var state = "normal"
            var reason = ""
            switch frame.camera.trackingState {
            case .normal: state = "normal"
            case .notAvailable: state = "none"
            case .limited(let r):
                state = "limited"
                switch r {
                case .excessiveMotion: reason = "Move the phone slower"
                case .insufficientFeatures: reason = "Point at the grass"
                case .initializing: reason = "Starting up. Move the phone a little"
                case .relocalizing: reason = "Finding its place again"
                @unknown default: reason = "Hold steady"
                }
            }
            let fwd = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
            let pitchDown = asin(max(-1, min(1, -fwd.y))) * 180 / .pi
            let meshes = frame.anchors.filter { $0 is ARMeshAnchor }.count
            let cp = simd_mul(deltaInv, SIMD4<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z, 1))
            // where the camera points, in the pinned scene frame (east, north): for the scan map's arrow
            let fw = simd_mul(deltaInv, SIMD4<Float>(-m.columns.2.x, -m.columns.2.y, -m.columns.2.z, 0))
            let drift = simd_length(SIMD3<Float>(delta.columns.3.x, delta.columns.3.y, delta.columns.3.z))
            notifyListeners("status", data: [
                "tracking": state, "reason": reason, "lidar": hasLidar, "meshes": meshes,
                "e": Double(cp.x), "n": Double(-cp.z), "u": Double(cp.y),
                "pitchDown": Double(pitchDown), "drift": Double(drift), "pinned": pinAnchor != nil,
                "fe": Double(fw.x), "fn": Double(-fw.z),
            ])
        }

        guard detectOn, !encoding, t - lastFrameT > (fastFrames ? 0.06 : 0.3) else { return }
        lastFrameT = t
        encoding = true
        frameId += 1
        let id = frameId
        cams.append((id: id, cam: frame.camera))
        if cams.count > 60 { cams.removeFirst() }

        // upright (portrait) copy of the camera picture, ~720 px wide
        let img = CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right)
        let scale = (fastFrames ? 360.0 : 720.0) / img.extent.width
        let small = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let w = Int(small.extent.width.rounded())
        let h = Int(small.extent.height.rounded())
        let ctx = ci
        DispatchQueue.global(qos: .userInitiated).async {
            let data = ctx.jpegRepresentation(of: small, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:])
            DispatchQueue.main.async {
                self.encoding = false
                guard let d = data, self.sceneView != nil else { return }
                self.notifyListeners("frame", data: ["id": id, "w": w, "h": h, "t": t, "jpeg": d.base64EncodedString()])
            }
        }
    }

    // MARK: pixel → ground

    private func num(_ v: Any?) -> Double { return (v as? NSNumber)?.doubleValue ?? 0 }

    /// A point in ARKit's world → east/north/up in the pinned scene frame.
    private func enu(_ p: SIMD3<Float>, approx: Bool) -> [String: Any] {
        let s = simd_mul(deltaInv, SIMD4<Float>(p.x, p.y, p.z, 1))
        return ["e": Double(s.x), "n": Double(-s.z), "u": Double(s.y), "approx": approx]
    }

    /// Drop the anchor the scene is pinned to (once per AR session), at a spot given in scene metres.
    @objc func pin(_ call: CAPPluginCall) {
        let e = Float(call.getDouble("e") ?? 0)
        let n = Float(call.getDouble("n") ?? 0)
        let u = Float(call.getDouble("u") ?? 0)
        DispatchQueue.main.async {
            guard let v = self.sceneView else { call.reject("AR isn't running"); return }
            if self.pinAnchor != nil { call.resolve(["pinned": true, "new": false]); return }
            var t = matrix_identity_float4x4
            t.columns.3 = SIMD4<Float>(e, u, -n, 1) // before the first pin the scene frame is the world
            let a = ARAnchor(name: "tapin-pin", transform: t)
            v.session.add(anchor: a)
            self.pinAnchor = a
            self.pin0 = t
            call.resolve(["pinned": true, "new": true])
        }
    }

    /// Rough ground height: look 45° down in front of the camera.
    private func groundY(_ session: ARSession, cam: ARCamera) -> Float {
        let m = cam.transform
        let origin = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        var f = SIMD3<Float>(-m.columns.2.x, 0, -m.columns.2.z)
        if simd_length(f) < 1e-4 { f = SIMD3<Float>(0, 0, -1) }
        let dir = simd_normalize(simd_normalize(f) + SIMD3<Float>(0, -1, 0))
        let q = ARRaycastQuery(origin: origin, direction: dir, allowing: .estimatedPlane, alignment: .any)
        if let r = session.raycast(q).first {
            let y = r.worldTransform.columns.3.y
            if y < origin.y - 0.2 && y > origin.y - 3 { return y }
        }
        return origin.y - 1.4
    }

    /// Where the ray through `pt` (in a `size` portrait viewport of `cam`) meets the ground.
    private func hit(_ session: ARSession, cam: ARCamera, pt: CGPoint, size: CGSize, ground: Float) -> [String: Any]? {
        let m = cam.transform
        let origin = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        var plane = matrix_identity_float4x4
        plane.columns.3 = SIMD4<Float>(0, ground, 0, 1)
        guard let flat = cam.unprojectPoint(pt, ontoPlane: plane, orientation: .portrait, viewportSize: size) else { return nil }
        let toFlat = flat - origin
        let far = simd_length(toFlat)
        if far < 0.05 || far > 60 { return nil }
        // the plane must be in front of the camera
        let fwd = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        if simd_dot(toFlat, fwd) <= 0 { return nil }
        let dir = toFlat / far
        let q = ARRaycastQuery(origin: origin, direction: dir, allowing: .estimatedPlane, alignment: .any)
        if let r = session.raycast(q).first {
            let c = r.worldTransform.columns.3
            let p = SIMD3<Float>(c.x, c.y, c.z)
            let d = simd_distance(p, origin)
            // accept a depth hit unless it's wildly off the ground guess (a person, a bag, the flag)
            if d > 0.05 && d < 60 && abs(p.y - ground) < max(0.35, 0.08 * d) { return enu(p, approx: false) }
        }
        return enu(flat, approx: true)
    }

    @objc func locate(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? -1
        let w = call.getDouble("w") ?? 0
        let h = call.getDouble("h") ?? 0
        let pts = (call.getArray("points") ?? []).compactMap { $0 as? JSObject }
        DispatchQueue.main.async {
            guard let v = self.sceneView else { call.reject("AR isn't running"); return }
            guard w > 0, h > 0, let cam = self.cams.first(where: { $0.id == id })?.cam else { call.reject("That frame is too old"); return }
            let size = CGSize(width: w, height: h)
            let ground = self.groundY(v.session, cam: cam)
            var out: [Any] = []
            for p in pts {
                let pt = CGPoint(x: self.num(p["x"]), y: self.num(p["y"]))
                if let r = self.hit(v.session, cam: cam, pt: pt, size: size, ground: ground) { out.append(r) } else { out.append(NSNull()) }
            }
            call.resolve(["points": out])
        }
    }

    /// A tap on the screen (web-view points) → the spot on the ground.
    @objc func tap(_ call: CAPPluginCall) {
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        DispatchQueue.main.async {
            guard let v = self.sceneView, let frame = v.session.currentFrame else { call.reject("AR isn't running"); return }
            let pt = CGPoint(x: x, y: y)
            let ground = self.groundY(v.session, cam: frame.camera)
            let m = frame.camera.transform
            let origin = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
            // the ground first (horizontal), then anything; a hit far off the ground height is a
            // flagstick, a leg or a wrong plane guess, so it is skipped
            for align in [ARRaycastQuery.TargetAlignment.horizontal, ARRaycastQuery.TargetAlignment.any] {
                guard let q = v.raycastQuery(from: pt, allowing: .estimatedPlane, alignment: align) else { continue }
                for r in v.session.raycast(q) {
                    let c = r.worldTransform.columns.3
                    let p = SIMD3<Float>(c.x, c.y, c.z)
                    let d = simd_distance(p, origin)
                    if d > 0.05 && d < 60 && abs(p.y - ground) < max(0.25, 0.06 * d) {
                        call.resolve(["point": self.enu(p, approx: false)])
                        return
                    }
                }
            }
            var plane = matrix_identity_float4x4
            plane.columns.3 = SIMD4<Float>(0, ground, 0, 1)
            if let flat = frame.camera.unprojectPoint(pt, ontoPlane: plane, orientation: .portrait, viewportSize: v.bounds.size) {
                call.resolve(["point": self.enu(flat, approx: true)])
            } else {
                call.resolve(["point": NSNull()])
            }
        }
    }

    // MARK: LiDAR mesh → height grid

    @objc func heights(_ call: CAPPluginCall) {
        let e0 = Float(call.getDouble("e0") ?? 0)
        let n0 = Float(call.getDouble("n0") ?? 0)
        let e1 = Float(call.getDouble("e1") ?? 0)
        let n1 = Float(call.getDouble("n1") ?? 0)
        let cell = Float(max(0.05, call.getDouble("cell") ?? 0.1))
        DispatchQueue.main.async {
            guard let v = self.sceneView, let frame = v.session.currentFrame else { call.reject("AR isn't running"); return }
            let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
            let toScene = self.deltaInv
            DispatchQueue.global(qos: .userInitiated).async {
                let r = ArPuttPlugin.grid(anchors: anchors, e0: e0, n0: n0, e1: e1, n1: n1, cell: cell, toScene: toScene)
                DispatchQueue.main.async {
                    if let r = r { call.resolve(r) } else { call.reject("That area is too big to read") }
                }
            }
        }
    }

    /// Samples every flat mesh triangle into a grid (x = east, y = north, value = up), in the pinned
    /// scene frame. Steep triangles (furniture, walls, legs, a rug's edge, the ball) are not turf:
    /// the cells under them and 15 cm around are flagged `near`, because the mesh rounds off the
    /// floor beside them ("skirts") and that rounding would read as slope.
    static func grid(anchors: [ARMeshAnchor], e0: Float, n0: Float, e1: Float, n1: Float, cell: Float, toScene: simd_float4x4) -> [String: Any]? {
        let nx = Int(((e1 - e0) / cell).rounded(.up)) + 1
        let ny = Int(((n1 - n0) / cell).rounded(.up)) + 1
        guard nx > 1, ny > 1, nx * ny <= 400_000 else { return nil }
        var sum = [Float](repeating: 0, count: nx * ny)
        var cnt = [Int32](repeating: 0, count: nx * ny)
        var steep = [UInt8](repeating: 0, count: nx * ny)
        var samples = 0
        for a in anchors {
            let M = simd_mul(toScene, a.transform)
            // skip mesh chunks nowhere near the area
            let c = M.columns.3
            if c.x < e0 - 6 || c.x > e1 + 6 || -c.z < n0 - 6 || -c.z > n1 + 6 { continue }
            let vs = a.geometry.vertices
            let fs = a.geometry.faces
            let vb = vs.buffer.contents()
            let fb = fs.buffer.contents()
            var wv = [SIMD3<Float>]()
            wv.reserveCapacity(vs.count)
            for i in 0..<vs.count {
                let p = vb.advanced(by: vs.offset + vs.stride * i).assumingMemoryBound(to: Float.self)
                let w = simd_mul(M, SIMD4<Float>(p[0], p[1], p[2], 1))
                wv.append(SIMD3<Float>(w.x, w.y, w.z))
            }
            let per = fs.indexCountPerPrimitive
            let bytes = fs.bytesPerIndex
            if per != 3 { continue }
            for t in 0..<fs.count {
                var idx = [0, 0, 0]
                for k in 0..<3 {
                    let ptr = fb.advanced(by: (t * per + k) * bytes)
                    idx[k] = bytes == 4 ? Int(ptr.assumingMemoryBound(to: UInt32.self).pointee) : Int(ptr.assumingMemoryBound(to: UInt16.self).pointee)
                }
                if idx[0] >= wv.count || idx[1] >= wv.count || idx[2] >= wv.count { continue }
                let A = wv[idx[0]], B = wv[idx[1]], C = wv[idx[2]]
                let nrm = simd_cross(B - A, C - A)
                let len = simd_length(nrm)
                if len < 1e-9 { continue }
                let flatness = abs(nrm.y) / len
                // turf: within about 20° of level. Steeper than about 45°: something standing on it.
                // In between: mesh noise or the rounded foot of something; used for neither.
                let isGround = flatness >= 0.94
                let isSteep = flatness < 0.7
                if !isGround && !isSteep { continue }
                let longest = max(simd_distance(A, B), max(simd_distance(B, C), simd_distance(A, C)))
                let n = max(1, min(16, Int((longest / (cell * 0.7)).rounded(.up))))
                for i in 0...n {
                    for j in 0...(n - i) {
                        let u = Float(i) / Float(n), w = Float(j) / Float(n)
                        let p = A + (B - A) * u + (C - A) * w
                        let gi = Int(((p.x - e0) / cell).rounded())
                        let gj = Int(((-p.z - n0) / cell).rounded())
                        if gi < 0 || gj < 0 || gi >= nx || gj >= ny { continue }
                        if isSteep { steep[gj * nx + gi] = 1; continue }
                        sum[gj * nx + gi] += p.y
                        cnt[gj * nx + gi] += 1
                        samples += 1
                    }
                }
            }
        }
        // grow the steep flags by 15 cm
        let r = max(1, Int((0.15 / cell).rounded(.up)))
        var near = [Int](repeating: 0, count: nx * ny)
        for gj in 0..<ny {
            for gi in 0..<nx where steep[gj * nx + gi] == 1 {
                for dj in -r...r {
                    for di in -r...r where di * di + dj * dj <= r * r {
                        let x = gi + di, y = gj + dj
                        if x >= 0 && y >= 0 && x < nx && y < ny { near[y * nx + x] = 1 }
                    }
                }
            }
        }
        // (no per-cell counts: nothing uses them, and the scan round the cup sends ~10,000 cells a second)
        var heights: [Any] = []
        heights.reserveCapacity(nx * ny)
        for k in 0..<(nx * ny) {
            if cnt[k] > 0 { heights.append(NSNumber(value: sum[k] / Float(cnt[k]))) } else { heights.append(NSNull()) }
        }
        return ["cell": Double(cell), "nx": nx, "ny": ny, "e0": Double(e0), "n0": Double(n0), "heights": heights, "near": near, "samples": samples]
    }

    // MARK: drawing

    @objc func setScene(_ call: CAPPluginCall) {
        let lines = (call.getArray("lines") ?? []).compactMap { $0 as? JSObject }
        let markers = (call.getArray("markers") ?? []).compactMap { $0 as? JSObject }
        DispatchQueue.main.async {
            guard self.sceneView != nil else { call.reject("AR isn't running"); return }
            for n in self.root.childNodes { n.removeFromParentNode() }
            var order = 10
            for l in lines {
                if let n = self.ribbon(l) { n.renderingOrder = order; order += 1; self.root.addChildNode(n) }
            }
            for m in markers {
                let n = self.marker(m)
                n.renderingOrder = 100
                self.root.addChildNode(n)
            }
            call.resolve()
        }
    }

    private func color(_ hex: String?, alpha: Double = 1) -> UIColor {
        var s = (hex ?? "#ffffff").trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        guard s.count == 6, Scanner(string: s).scanHexInt64(&v) else { return UIColor.white.withAlphaComponent(CGFloat(alpha)) }
        return UIColor(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: CGFloat(alpha))
    }

    private func flatMaterial(_ c: UIColor) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = c
        m.isDoubleSided = true
        m.readsFromDepthBuffer = false
        m.writesToDepthBuffer = false
        return m
    }

    /// A flat ribbon lying on the turf. `pts` = [e, n, u, e, n, u, …] in metres.
    private func ribbon(_ l: JSObject) -> SCNNode? {
        let raw = (l["pts"] as? JSArray) ?? []
        let p = raw.map { self.num($0) }
        let count = p.count / 3
        guard count >= 2 else { return nil }
        let half = Float(max(0.002, num(l["width"]) / 2))
        let dash = (l["dash"] as? Bool) ?? false
        // on the turf, not above it: with no depth test nothing flickers, and a line floating even
        // a centimetre up slides against the grass as you walk around it (parallax)
        let lift: Float = 0.002
        var pos = [SIMD3<Float>]()
        for i in 0..<count { pos.append(SIMD3<Float>(Float(p[i * 3]), Float(p[i * 3 + 2]) + lift, -Float(p[i * 3 + 1]))) }
        var verts = [SCNVector3]()
        var idx = [Int32]()
        let up = SIMD3<Float>(0, 1, 0)
        for i in 0..<count {
            let a = pos[max(0, i - 1)], b = pos[min(count - 1, i + 1)]
            var d = b - a
            d.y = 0
            if simd_length(d) < 1e-6 { d = SIMD3<Float>(1, 0, 0) }
            let side = simd_normalize(simd_cross(up, simd_normalize(d))) * half
            let L = pos[i] + side, R = pos[i] - side
            verts.append(SCNVector3(L.x, L.y, L.z))
            verts.append(SCNVector3(R.x, R.y, R.z))
            if i < count - 1 && !(dash && (i / 2) % 2 == 1) {
                let k = Int32(i * 2)
                idx.append(contentsOf: [k, k + 1, k + 2, k + 1, k + 3, k + 2])
            }
        }
        guard !idx.isEmpty else { return nil }
        let geo = SCNGeometry(sources: [SCNGeometrySource(vertices: verts)], elements: [SCNGeometryElement(indices: idx, primitiveType: .triangles)])
        let alpha = l["alpha"] == nil ? 1.0 : num(l["alpha"])
        geo.materials = [flatMaterial(color(l["color"] as? String, alpha: alpha))]
        return SCNNode(geometry: geo)
    }

    /// kind: "ring" (flat circle), "disc", "post" (a pole with a ball on top). Optional label.
    private func marker(_ m: JSObject) -> SCNNode {
        let node = SCNNode()
        node.simdPosition = SIMD3<Float>(Float(num(m["e"])), Float(num(m["u"])), -Float(num(m["n"])))
        let kind = (m["kind"] as? String) ?? "ring"
        let r = CGFloat(max(0.01, num(m["r"])))
        let c = color(m["color"] as? String)
        var top: Float = 0.06
        if kind == "post" {
            let hgt = CGFloat(max(0.05, num(m["h"])))
            let pole = SCNNode(geometry: SCNCylinder(radius: 0.006, height: hgt))
            pole.geometry?.materials = [flatMaterial(c)]
            pole.position = SCNVector3(0, Float(hgt) / 2, 0)
            let ball = SCNNode(geometry: SCNSphere(radius: r))
            ball.geometry?.materials = [flatMaterial(c)]
            ball.position = SCNVector3(0, Float(hgt), 0)
            let foot = SCNNode(geometry: SCNCylinder(radius: r, height: 0.003))
            foot.geometry?.materials = [flatMaterial(c)]
            foot.position = SCNVector3(0, 0.003, 0)
            node.addChildNode(pole)
            node.addChildNode(ball)
            node.addChildNode(foot)
            top = Float(hgt) + Float(r) + 0.03
        } else if kind == "disc" {
            let d = SCNNode(geometry: SCNCylinder(radius: r, height: 0.003))
            d.geometry?.materials = [flatMaterial(c)]
            d.position = SCNVector3(0, 0.003, 0)
            node.addChildNode(d)
        } else {
            let t = SCNNode(geometry: SCNTorus(ringRadius: r, pipeRadius: 0.006))
            t.geometry?.materials = [flatMaterial(c)]
            t.position = SCNVector3(0, 0.004, 0)
            node.addChildNode(t)
        }
        if let text = m["label"] as? String, !text.isEmpty {
            let g = SCNText(string: text, extrusionDepth: 0)
            g.font = UIFont.systemFont(ofSize: 10, weight: .heavy)
            g.flatness = 0.2
            g.materials = [flatMaterial(c)]
            let tn = SCNNode(geometry: g)
            let (lo, hi) = g.boundingBox
            tn.pivot = SCNMatrix4MakeTranslation((lo.x + hi.x) / 2, lo.y, 0)
            let s = Float(max(0.002, num(m["labelSize"]) / 10))
            tn.scale = SCNVector3(s, s, s)
            let holder = SCNNode()
            holder.position = SCNVector3(0, top, 0)
            holder.constraints = [SCNBillboardConstraint()]
            holder.addChildNode(tn)
            node.addChildNode(holder)
        }
        return node
    }
}
