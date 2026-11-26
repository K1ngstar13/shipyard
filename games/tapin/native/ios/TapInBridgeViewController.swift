import UIKit
import Capacitor

/// Registers Tap-In's own native plugins with Capacitor.
/// Main.storyboard must use this class instead of CAPBridgeViewController
/// (scripts/install-ios-plugin.mjs makes that change).
class TapInBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(GreenScanPlugin())
        bridge?.registerPluginInstance(ArPuttPlugin())
        // Pages scroll inside the web page, straight up and down (see .screen in styles.css): the web
        // view itself never needs to move, and mustn't be dragged sideways or bounced about.
        if let sv = bridge?.webView?.scrollView {
            sv.bounces = false
            sv.alwaysBounceHorizontal = false
            sv.alwaysBounceVertical = false
            sv.isDirectionalLockEnabled = true
            sv.showsHorizontalScrollIndicator = false
        }
    }
}
