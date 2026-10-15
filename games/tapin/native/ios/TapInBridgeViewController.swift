import UIKit
import Capacitor

/// Registers Tap-In's own native plugins with Capacitor.
/// Main.storyboard must use this class instead of CAPBridgeViewController
/// (scripts/install-ios-plugin.mjs makes that change).
class TapInBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(GreenScanPlugin())
    }
}
