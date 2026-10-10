package dev.crow.companion;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(CrowGatewayPlugin.class);
        super.onCreate(state);
        getBridge().getWebView().getSettings().setAllowFileAccess(false);
        getBridge().getWebView().getSettings().setAllowContentAccess(false);
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                // No arbitrary remote WebView, external intent, username, alternate port or deep-link navigation.
                return !("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                android.net.Uri uri = android.net.Uri.parse(url);
                return !("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443));
            }
        });
    }
}
