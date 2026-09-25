# Keep the JavaScript bridge methods accessed from terminal.html via reflection.
-keepclassmembers class com.yasha.pocketdesk.ui.TermBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# iroh's generated bindings and JNA are reached from native code by name.
-keep class computer.iroh.** { *; }
-keep class com.sun.jna.** { *; }
-dontwarn java.awt.**
