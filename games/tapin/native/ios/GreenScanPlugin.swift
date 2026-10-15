import Foundation
import Capacitor
import ARKit

/// Capacitor plugin: scans a putting green with the iPhone/iPad Pro LiDAR scanner and
/// returns a gravity- and compass-aligned height grid to the Tap-In web layer.
/// JS name: "GreenScan"  (see src/lib/greenScan.ts)
@objc(GreenScanPlugin)
public class GreenScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GreenScanPlugin"
    public let jsName = "GreenScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        let ok = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        call.resolve([
            "available": ok,
            "reason": ok ? "" : "This device has no LiDAR scanner. Green scanning needs an iPhone 12 Pro or newer Pro model, or an iPad Pro.",
        ])
    }

    @objc func scan(_ call: CAPPluginCall) {
        let cell = Float(call.getDouble("cell") ?? 0.1)
        DispatchQueue.main.async {
            let vc = GreenScanViewController(cell: cell) { result in
                switch result {
                case .success(let dict): call.resolve(dict)
                case .failure(let err): call.reject(err.localizedDescription)
                }
            }
            vc.modalPresentationStyle = .fullScreen
            self.bridge?.viewController?.present(vc, animated: true)
        }
    }
}
