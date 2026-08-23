# Keep the JavaScript bridge methods accessed from terminal.html via reflection.
-keepclassmembers class com.yasha.pocketdesk.ui.TermBridge {
    @android.webkit.JavascriptInterface <methods>;
}
