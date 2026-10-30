# Keep the JavaScript bridge methods accessed from terminal.html via reflection.
-keepclassmembers class com.yasha.pocketdesk.ui.TermBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# iroh's generated bindings and JNA are reached from native code by name.
-keep class computer.iroh.** { *; }
-keep class com.sun.jna.** { *; }
-dontwarn java.awt.**

# ML Kit builds its registrars by reflection from manifest names; without the
# no-arg constructor the code scanner client crashes with a null SharedPrefManager.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }

# Started by name through su with app_process for root live panes.
-keep class com.yasha.pocketdesk.PaneServer { public static void main(java.lang.String[]); }
