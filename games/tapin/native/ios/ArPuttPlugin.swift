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
        CAPPluginMethod(name: "project", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "heights", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "depth", returnType: CAPPluginReturnPromise),
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
    /// where the pinned spot was in ARKit's world when it was pinned, and how far ARKit has moved it since
    private var pinWorld0 = SIMD3<Float>(0, 0, 0)
    private var pinDrift: Float = 0
    /// scene frame → current world, and back
    private var delta = matrix_identity_float4x4
    private var deltaInv = matrix_identity_float4x4

    // Has the phone's map of the world restarted? Counted up when the session is interrupted (the
    // app left the screen, a call), when it fails, and when the camera's position jumps further in
    // one frame than a phone can move. The web layer throws away what it measured before (see
    // src/ar/track.ts): ground from two maps laid over each other gave 10–17 cm cliffs on a green.
    private var mapEpoch = 0
    private var everNormal = false
    // Carrying the scene through a restart. When ARKit's tracking starts over, its map begins again
    // at wherever the camera is, turned however it's facing. But the camera itself has hardly moved
    // between the last picture before and the first picture after (a sixtieth of a second): its
    // place in the scene just before IS its place in the scene just after. That ties the new map
    // to the scene, so what was measured and drawn carries on. (What's lost is only how far the
    // phone moved while it had no tracking.)
    private var lastCamScene: simd_float4x4?
    private var lastWasInit = true
    private var lastFrameTime: TimeInterval = 0
    private var carried = 0

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
            // No plane detection. With it on, ARKit flattens the LiDAR mesh onto the level planes it
            // finds, and a sloping green comes out as level steps a few centimetres apart (seen in
            // reads sent from the course, Nov 2026: flat patches, 2–9 cm steps between them). The raw
            // mesh keeps the slope. Ray-casts use depth ("estimatedPlane"), which needs no planes.
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
        pinWorld0 = SIMD3<Float>(0, 0, 0)
        pinDrift = 0
        delta = matrix_identity_float4x4
        deltaInv = matrix_identity_float4x4
        mapEpoch = 0
        everNormal = false
        lastCamScene = nil
        lastWasInit = true
        lastFrameTime = 0
        carried = 0
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

    public func sessionWasInterrupted(_ session: ARSession) {
        mapEpoch += 1
    }

    public func sessionInterruptionEnded(_ session: ARSession) {
        mapEpoch += 1
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        mapEpoch += 1
    }

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let t = frame.timestamp
        var isInit = false
        if case .limited(let why0) = frame.camera.trackingState, case .initializing = why0 { isInit = true }
        if let a = pinAnchor, let cur = frame.anchors.first(where: { $0.identifier == a.identifier }) {
            let d = simd_mul(cur.transform, simd_inverse(pin0))
            delta = d
            deltaInv = simd_inverse(d)
            root.simdTransform = d
            let c = cur.transform.columns.3
            pinDrift = simd_distance(SIMD3<Float>(c.x, c.y, c.z), pinWorld0)
        }
        // Where the camera is in the scene now. It can't jump: more than a phone can move or turn
        // between two pictures means ARKit's map restarted under it (or its tracking has just
        // started over). The scene is carried across: the camera is where it was.
        var camScene = simd_mul(deltaInv, frame.camera.transform)
        if everNormal, let was = lastCamScene {
            let dt = Float(max(0.0, min(1.0, t - lastFrameTime)))
            let a = was.columns.3
            let b = camScene.columns.3
            let moved = simd_distance(SIMD3<Float>(a.x, a.y, a.z), SIMD3<Float>(b.x, b.y, b.z))
            let f0 = simd_normalize(SIMD3<Float>(-was.columns.2.x, -was.columns.2.y, -was.columns.2.z))
            let f1 = simd_normalize(SIMD3<Float>(-camScene.columns.2.x, -camScene.columns.2.y, -camScene.columns.2.z))
            let turned = acos(max(-1, min(1, simd_dot(f0, f1)))) * 180 / .pi
            // (3 m/s and 400° a second are beyond a hand; the allowance grows if pictures were dropped)
            if moved > 0.3 + 3.0 * dt || turned > 20 + 400 * dt || (isInit && !lastWasInit) {
                let inv = simd_mul(was, simd_inverse(frame.camera.transform))
                deltaInv = inv
                delta = simd_inverse(inv)
                root.simdTransform = delta
                pinAnchor = nil
                pinDrift = 0
                carried += 1
                mapEpoch += 1
                camScene = was
            }
        }
        lastCamScene = camScene
        lastWasInit = isInit
        lastFrameTime = t
        if t - lastStatusT > 0.4 {
            lastStatusT = t
            let m = frame.camera.transform
            var state = "normal"
            var reason = ""
            var why = ""
            switch frame.camera.trackingState {
            case .normal:
                state = "normal"
                everNormal = true
            case .notAvailable:
                state = "none"
                why = "other"
            case .limited(let r):
                state = "limited"
                switch r {
                case .excessiveMotion:
                    reason = "Move the phone slower"
                    why = "motion"
                case .insufficientFeatures:
                    reason = "Point at the grass"
                    why = "features"
                case .initializing:
                    reason = "Starting up. Move the phone a little"
                    why = "init"
                case .relocalizing:
                    reason = "Finding its place again"
                    why = "reloc"
                @unknown default:
                    reason = "Hold steady"
                    why = "other"
                }
            }
            // how bright the camera finds the scene (about 1000 = well lit): tracking needs light
            let light = Double(frame.lightEstimate?.ambientIntensity ?? -1)
            let fwd = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
            let pitchDown = asin(max(-1, min(1, -fwd.y))) * 180 / .pi
            let meshes = frame.anchors.filter { $0 is ARMeshAnchor }.count
            let cp = simd_mul(deltaInv, SIMD4<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z, 1))
            // where the camera points, in the pinned scene frame (east, north): for the scan map's arrow
            let fw = simd_mul(deltaInv, SIMD4<Float>(-m.columns.2.x, -m.columns.2.y, -m.columns.2.z, 0))
            let drift = pinDrift
            notifyListeners("status", data: [
                "tracking": state, "reason": reason, "lidar": hasLidar, "meshes": meshes,
                "e": Double(cp.x), "n": Double(-cp.z), "u": Double(cp.y),
                "pitchDown": Double(pitchDown), "drift": Double(drift), "pinned": pinAnchor != nil,
                "fe": Double(fw.x), "fn": Double(-fw.z),
                "why": why, "epoch": mapEpoch, "light": light, "carried": carried,
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

    /// Pin the scene to the real ground with an anchor at a spot given in scene metres. `move`: pin
    /// it here instead of where it was (each putt is pinned at its own ball, so ARKit's corrections
    /// turn about the putt being read, not about a spot across the green). The scene frame itself
    /// carries on unchanged: only what it follows changes.
    @objc func pin(_ call: CAPPluginCall) {
        let e = Float(call.getDouble("e") ?? 0)
        let n = Float(call.getDouble("n") ?? 0)
        let u = Float(call.getDouble("u") ?? 0)
        let move = call.getBool("move") ?? false
        DispatchQueue.main.async {
            guard let v = self.sceneView else { call.reject("AR isn't running"); return }
            if let old = self.pinAnchor {
                if !move { call.resolve(["pinned": true, "new": false]); return }
                v.session.remove(anchor: old)
            }
            var t = matrix_identity_float4x4
            t.columns.3 = SIMD4<Float>(e, u, -n, 1)
            // where that spot is in ARKit's world right now (before the first pin the scene frame is the world)
            let world = simd_mul(self.delta, t)
            let a = ARAnchor(name: "tapin-pin", transform: world)
            v.session.add(anchor: a)
            self.pinAnchor = a
            self.pin0 = t
            self.pinWorld0 = SIMD3<Float>(world.columns.3.x, world.columns.3.y, world.columns.3.z)
            self.pinDrift = 0
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
            let cm = cam.transform.columns.3
            call.resolve(["points": out, "origin": self.enu(SIMD3<Float>(cm.x, cm.y, cm.z), approx: false)])
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
                        call.resolve(["point": self.enu(p, approx: false), "origin": self.enu(origin, approx: false)])
                        return
                    }
                }
            }
            var plane = matrix_identity_float4x4
            plane.columns.3 = SIMD4<Float>(0, ground, 0, 1)
            if let flat = frame.camera.unprojectPoint(pt, ontoPlane: plane, orientation: .portrait, viewportSize: v.bounds.size) {
                call.resolve(["point": self.enu(flat, approx: true), "origin": self.enu(origin, approx: false)])
            } else {
                call.resolve(["point": NSNull()])
            }
        }
    }

    /// Spots in the scene (metres) → pixels of a camera frame: the reverse of `locate`. Null for a
    /// spot behind the camera.
    @objc func project(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? -1
        let w = call.getDouble("w") ?? 0
        let h = call.getDouble("h") ?? 0
        let pts = (call.getArray("points") ?? []).compactMap { $0 as? JSObject }
        DispatchQueue.main.async {
            guard self.sceneView != nil else { call.reject("AR isn't running"); return }
            guard w > 0, h > 0, let cam = self.cams.first(where: { $0.id == id })?.cam else { call.reject("That frame is too old"); return }
            let size = CGSize(width: w, height: h)
            let m = cam.transform
            let origin = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
            let fwd = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
            var out: [Any] = []
            for p in pts {
                let sp = SIMD4<Float>(Float(self.num(p["e"])), Float(self.num(p["u"])), -Float(self.num(p["n"])), 1)
                let wv = simd_mul(self.delta, sp)
                let wp = SIMD3<Float>(wv.x, wv.y, wv.z)
                if simd_dot(wp - origin, fwd) <= 0.05 { out.append(NSNull()); continue }
                let q = cam.projectPoint(wp, orientation: .portrait, viewportSize: size)
                out.append(["x": Double(q.x), "y": Double(q.y)])
            }
            call.resolve(["points": out, "origin": self.enu(origin, approx: false)])
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

    /// One LiDAR picture of the ground in front of the phone: this camera frame's depth alone, not
    /// ARKit's mesh. The mesh is ARKit's own blend of everything it has seen, laid down in a map
    /// that drifts over a long walk; a single depth frame is one rigid snapshot, good to
    /// millimetres within itself, and levelled by gravity (which doesn't drift). The web layer
    /// takes slopes from it (src/ar/slopeScan.ts). Returned: a square grid of mean heights round
    /// the camera in the scene frame, the spread of the depth points inside each cell (something
    /// standing on the turf shows as a large spread), and where the camera was.
    @objc func depth(_ call: CAPPluginCall) {
        let cell = Float(max(0.05, min(0.5, call.getDouble("cell") ?? 0.1)))
        let reach = Float(max(1.0, min(5.0, call.getDouble("reach") ?? 3.6)))
        let minConf = UInt8(max(0, min(2, call.getInt("minConf") ?? 1)))
        DispatchQueue.main.async {
            guard let v = self.sceneView, let frame = v.session.currentFrame else { call.reject("AR isn't running"); return }
            var tracking = "limited"
            if case .normal = frame.camera.trackingState { tracking = "normal" }
            let camNow = simd_mul(self.deltaInv, frame.camera.transform).columns.3
            // (no depth in this frame, as happens for a moment now and then: an empty picture, not an error)
            let empty: [String: Any] = [
                "cell": Double(cell), "nx": 0, "ny": 0, "e0": Double(camNow.x), "n0": Double(-camNow.z),
                "heights": [Any](), "spread": [Any](),
                "cam": ["e": Double(camNow.x), "n": Double(-camNow.z), "u": Double(camNow.y)],
                "fe": 0.0, "fn": 0.0, "fu": 0.0, "t": frame.timestamp, "tracking": tracking,
                "w": 0, "h": 0, "used": 0, "total": 0, "high": 0,
            ]
            guard let dd = frame.sceneDepth else { call.resolve(empty); return }
            let depthMap = dd.depthMap
            guard CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32 else { call.reject("Unexpected depth format"); return }
            let toScene = simd_mul(self.deltaInv, frame.camera.transform)
            let K = frame.camera.intrinsics
            let res = frame.camera.imageResolution
            let w = CVPixelBufferGetWidth(depthMap)
            let h = CVPixelBufferGetHeight(depthMap)
            guard w > 8, h > 8, res.width > 0, res.height > 0 else { call.reject("Empty depth frame"); return }
            // the camera's intrinsics are for the full picture: scale them to the depth map
            let sx = Float(w) / Float(res.width)
            let sy = Float(h) / Float(res.height)
            let fx = K[0][0] * sx
            let fy = K[1][1] * sy
            let cx = K[2][0] * sx
            let cy = K[2][1] * sy
            guard fx > 1, fy > 1 else { call.reject("Bad camera intrinsics"); return }
            let camP = toScene.columns.3
            // a square grid round the camera, on the scene's own lattice (so pictures line up)
            let half = Int((reach / cell).rounded(.up))
            let n = 2 * half + 1
            let ce = (camP.x / cell).rounded() * cell
            let cn = (-camP.z / cell).rounded() * cell
            var sum = [Float](repeating: 0, count: n * n)
            var sq = [Float](repeating: 0, count: n * n)
            var cnt = [Int32](repeating: 0, count: n * n)
            var used = 0
            var high = 0
            var total = 0
            CVPixelBufferLockBaseAddress(depthMap, .readOnly)
            let conf = dd.confidenceMap
            if let c = conf { CVPixelBufferLockBaseAddress(c, .readOnly) }
            if let base = CVPixelBufferGetBaseAddress(depthMap) {
                let rowBytes = CVPixelBufferGetBytesPerRow(depthMap)
                var cBase: UnsafeMutableRawPointer? = nil
                var cRow = 0
                if let c = conf, CVPixelBufferGetWidth(c) == w, CVPixelBufferGetHeight(c) == h {
                    cBase = CVPixelBufferGetBaseAddress(c)
                    cRow = CVPixelBufferGetBytesPerRow(c)
                }
                let reach2 = reach * reach
                for vy in 0..<h {
                    let row = base.advanced(by: vy * rowBytes).assumingMemoryBound(to: Float32.self)
                    let crow = cBase?.advanced(by: vy * cRow).assumingMemoryBound(to: UInt8.self)
                    for ux in 0..<w {
                        let d = row[ux]
                        // (NaN fails this test too)
                        if !(d > 0.2 && d < 6.0) { continue }
                        total += 1
                        if let cr = crow {
                            let cv = cr[ux]
                            if cv >= 2 { high += 1 }
                            if cv < minConf { continue }
                        }
                        // pixel → camera space (x right, y up, z towards the viewer) → scene
                        let xc = (Float(ux) - cx) * d / fx
                        let yc = -(Float(vy) - cy) * d / fy
                        let p = simd_mul(toScene, SIMD4<Float>(xc, yc, -d, 1))
                        let dx = p.x - camP.x
                        let dz = p.z - camP.z
                        if dx * dx + dz * dz > reach2 { continue }
                        let gi = Int(((p.x - ce) / cell).rounded()) + half
                        let gj = Int(((-p.z - cn) / cell).rounded()) + half
                        if gi < 0 || gj < 0 || gi >= n || gj >= n { continue }
                        let k = gj * n + gi
                        sum[k] += p.y
                        sq[k] += p.y * p.y
                        cnt[k] += 1
                        used += 1
                    }
                }
            }
            if let c = conf { CVPixelBufferUnlockBaseAddress(c, .readOnly) }
            CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
            // only the part of the grid with anything in it is sent (the wedge in front of the phone)
            var i0 = n, i1 = -1, j0 = n, j1 = -1
            for gj in 0..<n {
                for gi in 0..<n where cnt[gj * n + gi] >= 4 {
                    if gi < i0 { i0 = gi }
                    if gi > i1 { i1 = gi }
                    if gj < j0 { j0 = gj }
                    if gj > j1 { j1 = gj }
                }
            }
            if i1 < i0 || j1 < j0 { call.resolve(empty); return }
            let ox = i1 - i0 + 1
            let oy = j1 - j0 + 1
            var heights: [Any] = []
            var spread: [Any] = []
            heights.reserveCapacity(ox * oy)
            spread.reserveCapacity(ox * oy)
            for gj in j0...j1 {
                for gi in i0...i1 {
                    let k = gj * n + gi
                    // (a cell needs a handful of depth points to mean anything)
                    if cnt[k] >= 4 {
                        let m = sum[k] / Float(cnt[k])
                        let va = max(0, sq[k] / Float(cnt[k]) - m * m)
                        heights.append(NSNumber(value: m))
                        spread.append(NSNumber(value: va.squareRoot()))
                    } else {
                        heights.append(NSNull())
                        spread.append(NSNull())
                    }
                }
            }
            let m = frame.camera.transform
            let fw = simd_mul(self.deltaInv, SIMD4<Float>(-m.columns.2.x, -m.columns.2.y, -m.columns.2.z, 0))
            call.resolve([
                "cell": Double(cell), "nx": ox, "ny": oy,
                "e0": Double(ce + Float(i0 - half) * cell), "n0": Double(cn + Float(j0 - half) * cell),
                "heights": heights, "spread": spread,
                "cam": ["e": Double(camP.x), "n": Double(-camP.z), "u": Double(camP.y)],
                "fe": Double(fw.x), "fn": Double(-fw.z), "fu": Double(fw.y),
                "t": frame.timestamp, "tracking": tracking,
                "w": w, "h": h, "used": used, "total": total, "high": high,
            ])
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
                // Something standing on the turf (a bag, feet, the flagstick, the ball) is a few
                // centimetres tall at least. A small steep facet is a wrinkle in the mesh (a seam,
                // LiDAR scatter): on a real green those flagged half the ground as "beside something".
                let tall = max(A.y, max(B.y, C.y)) - min(A.y, min(B.y, C.y)) >= 0.03
                let isSteep = flatness < 0.7 && tall
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
