import Foundation
import UIKit
import Capacitor
import ARKit
import SceneKit
import CoreImage

/// Capacitor plugin: the live, world-anchored AR putt line.
///
/// The camera + ARKit view sits BEHIND the (transparent) web view, so every button and
/// label is the normal Tap-In web UI, while the putt line is real 3D geometry pinned to
/// the green. Walk around it and it stays put.
///
/// Native does only what the web layer can't:
///  • world tracking (gravity + compass aligned: +X east, +Y up, −Z north)
///  • small camera frames for the web layer's ball / flag detector
///  • ray-casts from a pixel to the ground (LiDAR depth when available)
///  • a height grid of the turf from the LiDAR mesh
///  • drawing the lines and markers the web layer computes
/// JS name: "ArPutt"  (see src/lib/arPutt.ts)
@objc(ArPuttPlugin)
public class ArPuttPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
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
    ]

    private var sceneView: ARSCNView?
    private let root = SCNNode()
    private var cams: [(id: Int, cam: ARCamera)] = []
    private var frameId = 0
    private var detectOn = true
    private var encoding = false
    private var lastFrameT: TimeInterval = 0
    private var lastStatusT: TimeInterval = 0
    private var hasLidar = false
    private let ci = CIContext()
    private var savedBackground: UIColor?

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
            cfg.worldAlignment = .gravityAndHeading
            cfg.planeDetection = [.horizontal]
            let lidar = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
            if lidar { cfg.sceneReconstruction = .mesh }
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { cfg.frameSemantics.insert(.sceneDepth) }
            v.session.run(cfg, options: [.resetTracking, .removeExistingAnchors])

            self.sceneView = v
            self.hasLidar = lidar
            self.detectOn = true
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
        DispatchQueue.main.async {
            self.detectOn = on
            call.resolve()
        }
    }

    // MARK: per-frame

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
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
            notifyListeners("status", data: [
                "tracking": state, "reason": reason, "lidar": hasLidar, "meshes": meshes,
                "e": Double(m.columns.3.x), "n": Double(-m.columns.3.z), "u": Double(m.columns.3.y),
                "pitchDown": Double(pitchDown),
            ])
        }

        guard detectOn, !encoding, t - lastFrameT > 0.3 else { return }
        lastFrameT = t
        encoding = true
        frameId += 1
        let id = frameId
        cams.append((id: id, cam: frame.camera))
        if cams.count > 8 { cams.removeFirst() }

        // upright (portrait) copy of the camera picture, ~720 px wide
        let img = CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right)
        let scale = 720.0 / img.extent.width
        let small = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let w = Int(small.extent.width.rounded())
        let h = Int(small.extent.height.rounded())
        let ctx = ci
        DispatchQueue.global(qos: .userInitiated).async {
            let data = ctx.jpegRepresentation(of: small, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:])
            DispatchQueue.main.async {
                self.encoding = false
                guard let d = data, self.sceneView != nil else { return }
                self.notifyListeners("frame", data: ["id": id, "w": w, "h": h, "jpeg": d.base64EncodedString()])
            }
        }
    }

    // MARK: pixel → ground

    private func num(_ v: Any?) -> Double { return (v as? NSNumber)?.doubleValue ?? 0 }

    private func enu(_ p: SIMD3<Float>, approx: Bool) -> [String: Any] {
        return ["e": Double(p.x), "n": Double(-p.z), "u": Double(p.y), "approx": approx]
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
            if let q = v.raycastQuery(from: pt, allowing: .estimatedPlane, alignment: .any), let r = v.session.raycast(q).first {
                let c = r.worldTransform.columns.3
                call.resolve(["point": self.enu(SIMD3<Float>(c.x, c.y, c.z), approx: false)])
                return
            }
            let ground = self.groundY(v.session, cam: frame.camera)
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
            DispatchQueue.global(qos: .userInitiated).async {
                let r = ArPuttPlugin.grid(anchors: anchors, e0: e0, n0: n0, e1: e1, n1: n1, cell: cell)
                DispatchQueue.main.async {
                    if let r = r { call.resolve(r) } else { call.reject("That area is too big to read") }
                }
            }
        }
    }

    /// Samples every near-flat mesh triangle into a grid (x = east, y = north, value = up).
    static func grid(anchors: [ARMeshAnchor], e0: Float, n0: Float, e1: Float, n1: Float, cell: Float) -> [String: Any]? {
        let nx = Int(((e1 - e0) / cell).rounded(.up)) + 1
        let ny = Int(((n1 - n0) / cell).rounded(.up)) + 1
        guard nx > 1, ny > 1, nx * ny <= 400_000 else { return nil }
        var sum = [Float](repeating: 0, count: nx * ny)
        var cnt = [Int32](repeating: 0, count: nx * ny)
        var samples = 0
        for a in anchors {
            // skip mesh chunks nowhere near the area
            let c = a.transform.columns.3
            if c.x < e0 - 6 || c.x > e1 + 6 || -c.z < n0 - 6 || -c.z > n1 + 6 { continue }
            let vs = a.geometry.vertices
            let fs = a.geometry.faces
            let vb = vs.buffer.contents()
            let fb = fs.buffer.contents()
            var wv = [SIMD3<Float>]()
            wv.reserveCapacity(vs.count)
            for i in 0..<vs.count {
                let p = vb.advanced(by: vs.offset + vs.stride * i).assumingMemoryBound(to: Float.self)
                let w = a.transform * SIMD4<Float>(p[0], p[1], p[2], 1)
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
                if abs(nrm.y) / len < 0.8 { continue } // not turf: legs, bag, flagstick
                let longest = max(simd_distance(A, B), max(simd_distance(B, C), simd_distance(A, C)))
                let n = max(1, min(16, Int((longest / (cell * 0.7)).rounded(.up))))
                for i in 0...n {
                    for j in 0...(n - i) {
                        let u = Float(i) / Float(n), w = Float(j) / Float(n)
                        let p = A + (B - A) * u + (C - A) * w
                        let gi = Int(((p.x - e0) / cell).rounded())
                        let gj = Int(((-p.z - n0) / cell).rounded())
                        if gi < 0 || gj < 0 || gi >= nx || gj >= ny { continue }
                        sum[gj * nx + gi] += p.y
                        cnt[gj * nx + gi] += 1
                        samples += 1
                    }
                }
            }
        }
        var heights: [Any] = []
        var counts: [Int] = []
        heights.reserveCapacity(nx * ny)
        counts.reserveCapacity(nx * ny)
        for k in 0..<(nx * ny) {
            counts.append(Int(cnt[k]))
            if cnt[k] > 0 { heights.append(NSNumber(value: sum[k] / Float(cnt[k]))) } else { heights.append(NSNull()) }
        }
        return ["cell": Double(cell), "nx": nx, "ny": ny, "e0": Double(e0), "n0": Double(n0), "heights": heights, "counts": counts, "samples": samples]
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
        let lift: Float = 0.012
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
            foot.position = SCNVector3(0, 0.012, 0)
            node.addChildNode(pole)
            node.addChildNode(ball)
            node.addChildNode(foot)
            top = Float(hgt) + Float(r) + 0.03
        } else if kind == "disc" {
            let d = SCNNode(geometry: SCNCylinder(radius: r, height: 0.003))
            d.geometry?.materials = [flatMaterial(c)]
            d.position = SCNVector3(0, 0.012, 0)
            node.addChildNode(d)
        } else {
            let t = SCNNode(geometry: SCNTorus(ringRadius: r, pipeRadius: 0.006))
            t.geometry?.materials = [flatMaterial(c)]
            t.position = SCNVector3(0, 0.012, 0)
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
